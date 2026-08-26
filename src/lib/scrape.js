/**
 * The page-scraping payload.
 *
 * `scrapePage` is injected into the target tab by `chrome.scripting.executeScript`,
 * so it must be entirely self-contained: no imports, no closure over anything in
 * this module. It reads only what the estimator needs — length and media duration —
 * and never touches form values, storage, or cookies.
 */

export async function scrapePage() {
  const started = Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (n, max) => (Number.isFinite(n) ? Math.min(n, max) : 0);

  function isoDurationToSeconds(iso) {
    const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
    if (!m) return 0;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  /* Cheap: a DOM query, no layout. Safe to call repeatedly while waiting. */
  function mediaSeconds() {
    let best = 0;
    for (const el of document.querySelectorAll('video, audio')) {
      if (Number.isFinite(el.duration) && el.duration > best) best = el.duration;
    }
    if (best > 0) return best;

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

  /* Cheap: counts content-bearing elements without measuring or laying out. */
  function contentNodes() {
    return document.querySelectorAll('p, li, article, main, h1, h2, h3, td, pre, blockquote').length;
  }

  /*
   * Expensive: innerText forces a full layout, and on a heavy page that costs
   * hundreds of milliseconds. Call it ONCE, after the cheap probes above say
   * there is something worth reading — polling with it is what pushes tabs past
   * their timeout.
   */
  function mainText() {
    const candidates = ['article', 'main', '[role="main"]', '#content', '.post', '.article-body'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 400) return el.innerText;
    }
    return document.body ? document.body.innerText || '' : '';
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

  /*
   * `load` is not "content is on screen": a single-page app completes its
   * document with an empty shell and renders afterwards, and a <video> reports
   * NaN duration until its metadata loads. Wait on the cheap signals only.
   */
  const deadline = started + 2000;
  let nodes = contentNodes();
  let media = mediaSeconds();

  while (Date.now() < deadline && nodes < 5 && media === 0) {
    await sleep(200);
    nodes = contentNodes();
    media = mediaSeconds();
  }

  const text = mainText().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;

  return {
    wordCount: clamp(words, 200000),
    // Cap at 8h so a live stream reporting Infinity does not swamp the totals.
    videoSeconds: Math.round(clamp(media, 8 * 3600)),
    formFields: visibleFormFields(),
    excerpt: text.slice(0, 400),
    contentNodes: nodes,
    readyState: document.readyState,
    tookMs: Date.now() - started,
    scrapedAt: Date.now(),
  };
}

/**
 * Bumped whenever the reader changes what it can extract.
 *
 * Without this, results scraped by an older reader stay authoritative for the
 * whole TTL, so a fix to the reader appears to do nothing — the fixed code never
 * runs, because every tab is served from cache.
 */
export const SCRAPE_VERSION = 3;

/**
 * Is this reading worth keeping?
 *
 * An empty or near-empty result is not a measurement, it is a failure to
 * measure. Caching one means replaying that failure for hours and never
 * retrying the page.
 */
export function isUsableContent(content) {
  if (!content) return false;
  return content.wordCount >= 120 || content.videoSeconds > 0;
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
    ([, v]) =>
      v &&
      v.v === SCRAPE_VERSION && // written by a reader that behaved like this one
      isUsableContent(v) &&
      now - (v.scrapedAt || 0) < CONTENT_TTL_MS,
  );
  live.sort((a, b) => (b[1].scrapedAt || 0) - (a[1].scrapedAt || 0));
  return Object.fromEntries(live.slice(0, max));
}

/** Cache key: URL without the fragment, since a hash rarely changes the text. */
export function cacheKey(url) {
  return (url || '').split('#')[0];
}
