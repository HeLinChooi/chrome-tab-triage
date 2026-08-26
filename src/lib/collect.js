/**
 * Tab collection. The bridge between the Chrome APIs and the pure estimator libs.
 */

import { isInternalUrl } from './taxonomy.js';
import { scrapePage, pruneCache, cacheKey, CONTENT_TTL_MS } from './scrape.js';
import { STORAGE_KEYS } from './settings.js';

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
 * Enrich tabs with page text where we are allowed and able.
 *
 * Silently skips tabs we cannot script (discarded, cross-origin-restricted,
 * the Chrome Web Store) — a missing scrape just means a lower-confidence
 * estimate, never a failed run.
 */
export async function enrichWithContent(tabs) {
  if (!(await hasPageAccess())) return { tabs, scraped: 0, cached: 0 };

  const stored = await chrome.storage.local.get(STORAGE_KEYS.contentCache);
  const cache = pruneCache(stored[STORAGE_KEYS.contentCache] || {});
  const now = Date.now();
  let scraped = 0;
  let cached = 0;

  const jobs = tabs.map(async (tab) => {
    const key = cacheKey(tab.url);
    const hit = cache[key];
    if (hit && now - hit.scrapedAt < CONTENT_TTL_MS) {
      tab.content = hit;
      cached += 1;
      return;
    }
    if (tab.discarded || tab.status === 'unloaded') return;

    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrapePage,
      });
      if (result && result.result) {
        tab.content = result.result;
        cache[key] = result.result;
        scraped += 1;
      }
    } catch {
      // Not scriptable (PDF viewer, restricted origin, tab closed mid-run).
    }
  });

  await Promise.all(jobs);
  await chrome.storage.local.set({ [STORAGE_KEYS.contentCache]: pruneCache(cache, now) });
  return { tabs, scraped, cached };
}
