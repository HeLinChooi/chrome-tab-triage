/**
 * Tab collection. The bridge between the Chrome APIs and the pure estimator libs.
 */

import { isInternalUrl } from './taxonomy.js';
import { scrapePage, pruneCache, cacheKey, CONTENT_TTL_MS } from './scrape.js';
import { STORAGE_KEYS } from './settings.js';
import { mapLimit, withTimeout } from './async.js';

export const ALL_URLS = { origins: ['<all_urls>'] };

export async function hasPageAccess() {
  return chrome.permissions.contains(ALL_URLS);
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

/** How long to wait on any one tab before giving up on it. */
export const SCRAPE_TIMEOUT_MS = 3000;

/** How long the whole scraping phase may take before we proceed with what we have. */
export const SCRAPE_DEADLINE_MS = 45000;

/** Tabs scraped at once. Injecting into every tab simultaneously wakes them all. */
export const SCRAPE_CONCURRENCY = 6;

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
  if (!(await hasPageAccess())) return { tabs, scraped: 0, cached: 0, skipped: 0, timedOut: 0 };

  const { token, onProgress } = opts;
  const timeoutMs = opts.timeoutMs || SCRAPE_TIMEOUT_MS;
  const deadline = Date.now() + (opts.deadlineMs || SCRAPE_DEADLINE_MS);

  const stored = await chrome.storage.local.get(STORAGE_KEYS.contentCache);
  const cache = pruneCache(stored[STORAGE_KEYS.contentCache] || {});
  const now = Date.now();

  let scraped = 0;
  let cached = 0;
  let skipped = 0;
  let timedOut = 0;
  let done = 0;

  await mapLimit(tabs, SCRAPE_CONCURRENCY, async (tab) => {
    done += 1;
    if (onProgress) onProgress({ phase: 'reading', done, total: tabs.length });

    if (token && token.cancelled) return;

    const key = cacheKey(tab.url);
    const hit = cache[key];
    if (hit && now - hit.scrapedAt < CONTENT_TTL_MS) {
      tab.content = hit;
      cached += 1;
      return;
    }

    // A tab that is asleep or still loading cannot be read without waking it,
    // and waking the whole profile is exactly what makes a run take minutes.
    if (tab.discarded || tab.status !== 'complete' || Date.now() > deadline) {
      skipped += 1;
      return;
    }

    const attempt = chrome.scripting
      .executeScript({ target: { tabId: tab.id }, func: scrapePage })
      .then((frames) => (frames && frames[0] ? frames[0].result : null))
      // Not scriptable: PDF viewer, restricted origin, or closed mid-run.
      .catch(() => null);

    const TIMED_OUT = Symbol('timeout');
    const content = await withTimeout(attempt, timeoutMs, TIMED_OUT);

    if (content === TIMED_OUT) {
      timedOut += 1;
      return;
    }
    if (!content) {
      skipped += 1;
      return;
    }

    tab.content = content;
    cache[key] = content;
    scraped += 1;
  });

  await chrome.storage.local.set({ [STORAGE_KEYS.contentCache]: pruneCache(cache, now) });
  return { tabs, scraped, cached, skipped, timedOut };
}
