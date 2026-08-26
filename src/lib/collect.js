/**
 * Tab collection. The bridge between the Chrome APIs and the pure estimator libs.
 */

import { isInternalUrl } from './taxonomy.js';
import {
  scrapePage,
  pruneCache,
  cacheKey,
  CONTENT_TTL_MS,
  SCRAPE_VERSION,
  isUsableContent,
} from './scrape.js';
import { STORAGE_KEYS } from './settings.js';
import { mapLimit, withTimeout } from './async.js';

export const ALL_URLS = { origins: ['<all_urls>'] };

export async function hasPageAccess() {
  return chrome.permissions.contains(ALL_URLS);
}

/** The active tab in every window, so focus can be handed back afterwards. */
async function currentlyActiveTabs() {
  try {
    const active = await chrome.tabs.query({ active: true });
    return active.map((t) => ({ id: t.id, windowId: t.windowId }));
  } catch {
    return [];
  }
}

/** Put the user back where they were. Best effort: tabs may have closed. */
async function restoreFocus(previous) {
  for (const entry of previous) {
    try {
      await chrome.tabs.update(entry.id, { active: true });
    } catch {
      // That tab is gone; nothing sensible to restore it to.
    }
  }
}

/** Normalize a chrome.tabs.Tab into the record the estimators expect. */
function normalize(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '(untitled)',
    favIconUrl: tab.favIconUrl || '',
    lastAccessed: tab.lastAccessed || null,
    status: tab.status || 'complete',
    // Chrome 132+ exposes this. A frozen tab is NOT discarded and still reports
    // status "complete", but its renderer is suspended and runs no JavaScript.
    frozen: Boolean(tab.frozen),
    audible: Boolean(tab.audible),
    pinned: Boolean(tab.pinned),
    discarded: Boolean(tab.discarded),
    active: Boolean(tab.active),
    content: null,
  };
}

/**
 * @param {{scope?: string, ignorePinned?: boolean}} settings
 * @returns {Promise<Array>} normalized tabs, internal pages excluded
 */
export async function collectTabs(settings = {}) {
  const query = settings.scope === 'currentWindow' ? { currentWindow: true } : {};
  const tabs = await chrome.tabs.query(query);
  return tabs
    .map(normalize)
    .filter((t) => t.url && !isInternalUrl(t.url))
    .filter((t) => !(settings.ignorePinned && t.pinned));
}

/**
 * How long to wait on any one tab before giving up on it.
 *
 * The injected reader polls for up to 2.5s waiting for a single-page app to
 * render, so this has to leave room for that plus the injection round trip.
 */
export const SCRAPE_TIMEOUT_MS = 8000;

/** How long the whole scraping phase may take before we proceed with what we have. */
export const SCRAPE_DEADLINE_MS = 45000;

/** Waking tabs means a page load each, so that phase gets a longer budget. */
export const WAKE_DEADLINE_MS = 120000;

/** Tabs scraped at once. Injecting into every tab simultaneously wakes them all. */
export const SCRAPE_CONCURRENCY = 6;

/** How long to give a discarded tab to reload before giving up on it. */
export const WAKE_TIMEOUT_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attempts to read a page that has not rendered yet, and the gaps between them. */
const RETRY_DELAYS_MS = [400, 900];

/**
 * A responsive tab answers in about a millisecond. A suspended one never answers
 * at all, so waiting the full budget on the first attempt buys nothing — probe
 * briefly, and spend the long timeout only after a reload has revived the tab.
 */
export const PROBE_TIMEOUT_MS = 1500;

/**
 * Read a page, retrying from the extension side if it comes back empty.
 *
 * The waiting deliberately happens here rather than inside the injected reader:
 * Chrome throttles timers in long-hidden tabs to about one per minute, so an
 * in-page wait does not return before the injection times out. The service
 * worker's timers are not throttled.
 */
export async function readPage(tabId, timeoutMs, allowRetries) {
  const TIMED_OUT = Symbol('timeout');
  let last = null;

  const attempts = allowRetries ? RETRY_DELAYS_MS.length + 1 : 1;
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(RETRY_DELAYS_MS[i - 1]);

    const injection = chrome.scripting
      .executeScript({ target: { tabId }, func: scrapePage })
      .then((frames) => (frames && frames[0] ? frames[0].result : null))
      .catch(() => null);

    const result = await withTimeout(injection, timeoutMs, TIMED_OUT);
    if (result === TIMED_OUT) return { status: 'timeout' };
    if (!result) return { status: 'refused' };

    last = result;
    if (isUsableContent(result)) return { status: 'ok', content: result, attempts: i + 1 };
  }

  return { status: 'thin', content: last, attempts };
}

/**
 * Read a page, reviving the tab first if its renderer will not answer.
 *
 * An injection into a frozen renderer never returns — the script is queued
 * against a suspended process. There is no error and no result, just silence
 * until we give up, which is why every such tab consumes its whole budget to the
 * millisecond while healthy ones answer in about a millisecond. Reloading the
 * tab is the only way to get a renderer back.
 */
/**
 * Bring a frozen tab back so it can be read, then hand focus back.
 *
 * Activation is the documented way a tab unfreezes ("It is unfrozen on
 * activation" — chrome.tabs docs). Reloading is not: a frozen tab's renderer is
 * suspended, so a reload request is queued behind the same wall that swallows an
 * injection. Activation is visible to the user, which is why it is opt-in.
 */
async function activateAndWait(tabId, timeoutMs = 3000) {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    return false; // closed, or the window went away
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(150);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }
    if (!tab.frozen && tab.status === 'complete') return true;
  }
  return false;
}

/**
 * Reload a discarded tab and wait for it to come back.
 *
 * `executeScript` does NOT wake a discarded tab — there is no renderer for it to
 * run in, so the call simply fails. Waking one means reloading it explicitly and
 * waiting for the load to finish, which is why this is opt-in: it costs a page
 * load per tab and re-runs whatever those pages do on startup.
 */
async function wakeTab(tabId, timeoutMs = WAKE_TIMEOUT_MS) {
  try {
    await chrome.tabs.reload(tabId);
  } catch {
    return false; // gone, or Chrome refused
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false; // closed while we waited
    }
    if (!tab.discarded && tab.status === 'complete') return true;
  }
  return false;
}

/**
 * Enrich tabs with page text where we are allowed and able.
 *
 * Three limits matter here, and the absence of any one of them can hang a run:
 *
 * - a per-tab timeout, because `executeScript` against a busy or wedged renderer
 *   can take a very long time to settle, and reading `innerText` on a huge page
 *   forces a full layout;
 * - a concurrency ceiling, because injecting into every tab at once asks Chrome
 *   to wake and lay out the entire profile simultaneously;
 * - an overall deadline, so a profile full of slow pages still produces a summary.
 *
 * A tab we fail to read is not an error — it just falls back to a rule-of-thumb
 * estimate, which the report reports as unmeasured.
 */
export async function enrichWithContent(tabs, opts = {}) {
  if (!(await hasPageAccess())) {
    return {
      tabs, scraped: 0, cached: 0, asleep: 0, loading: 0, restricted: 0,
      timedOut: 0, pastDeadline: 0, woken: 0, wakeFailed: 0, thin: 0,
      frozen: 0, revived: 0, skipped: 0,
    };
  }

  const { token, onProgress } = opts;
  const timeoutMs = opts.timeoutMs || SCRAPE_TIMEOUT_MS;
  const defaultDeadline = opts.wakeSleeping ? WAKE_DEADLINE_MS : SCRAPE_DEADLINE_MS;
  const deadline = Date.now() + (opts.deadlineMs || defaultDeadline);

  const stored = await chrome.storage.local.get(STORAGE_KEYS.contentCache);
  const cache = opts.ignoreCache ? {} : pruneCache(stored[STORAGE_KEYS.contentCache] || {});
  const now = Date.now();

  // Counted by reason, because "could not be read" on its own tells the user
  // nothing about whether to act on it.
  const stats = {
    scraped: 0,
    cached: 0,
    asleep: 0,
    loading: 0,
    restricted: 0,
    timedOut: 0,
    pastDeadline: 0,
    woken: 0,
    wakeFailed: 0,
    thin: 0,
    frozen: 0,
    revived: 0,
  };
  let done = 0;

  /*
   * A per-tab record of what happened while reading. Three rounds of debugging
   * this from aggregate counts alone was three too many: when a page will not
   * measure, the answer is almost always specific to that site.
   */
  const log = [];
  const note = (tab, outcome, extra = {}) =>
    log.push({ url: tab.url, title: tab.title, outcome, ...extra });

  const concurrency = opts.wakeSleeping ? 3 : SCRAPE_CONCURRENCY;

  /*
   * Reviving a frozen tab means activating it, which is visible and can only
   * happen to one tab per window at a time. Remember what was in front so the
   * user's focus can be put back exactly where they left it.
   */
  const focusedBefore = opts.reviveFrozen ? await currentlyActiveTabs() : [];

  // Frozen tabs are handled one at a time; everything else runs in parallel.
  const frozen = opts.reviveFrozen ? tabs.filter((t) => t.frozen) : [];
  const rest = opts.reviveFrozen ? tabs.filter((t) => !t.frozen) : tabs;

  const readOne = async (tab) => {
    done += 1;
    if (onProgress) onProgress({ phase: 'reading', done, total: tabs.length });

    if (token && token.cancelled) return;

    const key = cacheKey(tab.url);
    const hit = cache[key];
    // Only a real measurement from this version of the reader may stand in for
    // reading the page again.
    if (hit && hit.v === SCRAPE_VERSION && isUsableContent(hit) && now - hit.scrapedAt < CONTENT_TTL_MS) {
      tab.content = hit;
      stats.cached += 1;
      note(tab, 'cached', { wordCount: hit.wordCount, videoSeconds: hit.videoSeconds });
      return;
    }

    if (Date.now() > deadline) {
      stats.pastDeadline += 1;
      note(tab, 'past deadline');
      return;
    }

    // A sleeping tab has no live page to read, and no renderer for an injected
    // script to run in. Reading one means reloading it first.
    let justWoken = false;
    const asleep = tab.discarded || tab.status === 'unloaded';
    if (asleep) {
      if (!opts.wakeSleeping) {
        stats.asleep += 1;
        note(tab, 'asleep');
        return;
      }
      if (onProgress) onProgress({ phase: 'waking', done, total: tabs.length });
      const awake = await wakeTab(tab.id);
      if (!awake) {
        stats.wakeFailed += 1;
        note(tab, 'would not wake');
        return;
      }
      stats.woken += 1;
      justWoken = true;
    } else if (tab.status !== 'complete') {
      stats.loading += 1;
      note(tab, 'still loading');
      return;
    }

    /*
     * NEVER inject into a frozen tab.
     *
     * chrome.scripting.executeScript against a frozen tab neither resolves nor
     * rejects — the call is queued against a suspended renderer and returns only
     * if the tab is later unfrozen (Chromium 40901394, w3c/webextensions#527).
     * The tab must be revived first, or left alone.
     */
    if (tab.frozen) {
      if (!opts.reviveFrozen) {
        stats.frozen += 1;
        note(tab, 'frozen', { frozen: true });
        return;
      }
      const revived = await activateAndWait(tab.id);
      if (!revived) {
        stats.frozen += 1;
        note(tab, 'would not unfreeze', { frozen: true });
        return;
      }
      stats.revived += 1;
      justWoken = true;
    }

    const read = await readPage(tab.id, justWoken ? timeoutMs : PROBE_TIMEOUT_MS, justWoken);

    if (read.status === 'timeout') {
      stats.timedOut += 1;
      note(tab, 'timed out', { waitedMs: justWoken ? timeoutMs : PROBE_TIMEOUT_MS });
      return;
    }
    if (read.status === 'refused') {
      // Chrome refused the injection: PDF viewer, the Web Store, a restricted
      // origin, a frozen renderer, or the tab went away mid-run.
      stats.restricted += 1;
      note(tab, 'injection refused');
      return;
    }

    const content = read.content;

    tab.content = content;
    // Never cache a failure to measure: it would replay for hours and the page
    // would never be retried.
    if (isUsableContent(content)) {
      cache[key] = { ...content, v: SCRAPE_VERSION };
      stats.scraped += 1;
      note(tab, 'read', {
        wordCount: content.wordCount,
        videoSeconds: content.videoSeconds,
        tookMs: content.tookMs,
        attempts: read.attempts,
      });
    } else {
      stats.thin += 1;
      note(tab, 'nothing to measure', {
        wordCount: content.wordCount,
        videoSeconds: content.videoSeconds,
        contentNodes: content.contentNodes,
        readyState: content.readyState,
        hidden: content.hidden,
        tookMs: content.tookMs,
        attempts: read.attempts,
      });
    }
  };

  await mapLimit(rest, concurrency, readOne);
  for (const tab of frozen) {
    if (token && token.cancelled) break;
    await readOne(tab);
  }
  await restoreFocus(focusedBefore);

  await chrome.storage.local.set({ [STORAGE_KEYS.contentCache]: pruneCache(cache, now) });
  return {
    tabs,
    ...stats,
    log,
    skipped: stats.asleep + stats.loading + stats.restricted + stats.pastDeadline + stats.wakeFailed,
  };
}
