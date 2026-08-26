/**
 * The page-scraping payload.
 *
 * `scrapePage` is injected into the target tab by `chrome.scripting.executeScript`,
 * so it must be entirely self-contained: no imports, no closure over anything in
 * this module. It reads only what the estimator needs — length and media duration —
 * and never touches form values, storage, or cookies.
 */

export function scrapePage() {
  const clamp = (n, max) => (Number.isFinite(n) ? Math.min(n, max) : 0);

  function mainText() {
    const candidates = ['article', 'main', '[role="main"]', '#content', '.post', '.article-body'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 400) return el.innerText;
    }
    return document.body ? document.body.innerText || '' : '';
  }

  function isoDurationToSeconds(iso) {
    const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
    if (!m) return 0;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  function mediaSeconds() {
    let best = 0;
    for (const el of document.querySelectorAll('video, audio')) {
      if (Number.isFinite(el.duration) && el.duration > best) best = el.duration;
    }
    if (best > 0) return best;

    // Media that has not loaded metadata yet still advertises its length.
    const metaSelectors = [
      'meta[itemprop="duration"]',
      'meta[property="video:duration"]',
      'meta[property="og:video:duration"]',
    ];
    for (const sel of metaSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const raw = el.getAttribute('content') || '';
      const seconds = /^\d+$/.test(raw) ? Number(raw) : isoDurationToSeconds(raw);
      if (seconds > best) best = seconds;
    }
    return best;
  }

  function visibleFormFields() {
    let count = 0;
    for (const el of document.querySelectorAll('input, textarea, select')) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden' || el.disabled) continue;
      if (el.offsetParent === null) continue;
      count += 1;
    }
    return count;
  }

  const text = mainText().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;

  return {
    wordCount: clamp(words, 200000),
    // Cap at 8h so a live stream reporting Infinity does not swamp the totals.
    videoSeconds: Math.round(clamp(mediaSeconds(), 8 * 3600)),
    formFields: visibleFormFields(),
    excerpt: text.slice(0, 400),
    scrapedAt: Date.now(),
  };
}

/** How long a scrape stays usable before we re-read the page. */
export const CONTENT_TTL_MS = 6 * 60 * 60 * 1000;

/** Keep the cache bounded — this lives in chrome.storage.local. */
export const CONTENT_CACHE_MAX = 600;

/**
 * Drop expired and surplus entries. Pure so it can be tested without storage.
 * @param {Record<string, {scrapedAt: number}>} cache
 */
export function pruneCache(cache, now = Date.now(), max = CONTENT_CACHE_MAX) {
  const live = Object.entries(cache || {}).filter(
    ([, v]) => v && now - (v.scrapedAt || 0) < CONTENT_TTL_MS,
  );
  live.sort((a, b) => (b[1].scrapedAt || 0) - (a[1].scrapedAt || 0));
  return Object.fromEntries(live.slice(0, max));
}

/** Cache key: URL without the fragment, since a hash rarely changes the text. */
export function cacheKey(url) {
  return (url || '').split('#')[0];
}
