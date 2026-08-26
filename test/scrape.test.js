import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pruneCache,
  cacheKey,
  isUsableContent,
  SCRAPE_VERSION,
  CONTENT_TTL_MS,
  CONTENT_CACHE_MAX,
} from '../src/lib/scrape.js';

const NOW = 1_800_000_000_000;

/** A cache entry as the collector writes them. */
const entry = (over = {}) => ({
  v: SCRAPE_VERSION,
  wordCount: 800,
  videoSeconds: 0,
  scrapedAt: NOW - 1000,
  ...over,
});

test('cacheKey ignores the fragment', () => {
  assert.equal(cacheKey('https://a.example/p#section-2'), 'https://a.example/p');
  assert.equal(cacheKey(undefined), '');
});

test('a reading counts as usable only with real text or media', () => {
  assert.equal(isUsableContent({ wordCount: 800, videoSeconds: 0 }), true);
  assert.equal(isUsableContent({ wordCount: 0, videoSeconds: 2700 }), true);
  assert.equal(isUsableContent({ wordCount: 12, videoSeconds: 0 }), false);
  assert.equal(isUsableContent(null), false);
});

test('pruneCache drops entries past the TTL', () => {
  const cache = {
    fresh: entry(),
    stale: entry({ scrapedAt: NOW - CONTENT_TTL_MS - 1 }),
  };
  assert.deepEqual(Object.keys(pruneCache(cache, NOW)), ['fresh']);
});

test('pruneCache drops readings from an older reader', () => {
  const cache = {
    current: entry(),
    ancient: entry({ v: SCRAPE_VERSION - 1 }),
    unversioned: { wordCount: 900, scrapedAt: NOW },
  };
  assert.deepEqual(Object.keys(pruneCache(cache, NOW)), ['current']);
});

test('pruneCache drops empty readings so the page gets retried', () => {
  const cache = {
    real: entry(),
    empty: entry({ wordCount: 3, videoSeconds: 0 }),
  };
  assert.deepEqual(Object.keys(pruneCache(cache, NOW)), ['real']);
});

test('pruneCache keeps the newest entries when over the cap', () => {
  const cache = {};
  for (let i = 0; i < 10; i++) cache[`k${i}`] = entry({ scrapedAt: NOW - i * 1000 });
  assert.deepEqual(Object.keys(pruneCache(cache, NOW, 3)), ['k0', 'k1', 'k2']);
});

test('pruneCache tolerates a missing or malformed cache', () => {
  assert.deepEqual(pruneCache(undefined, NOW), {});
  assert.deepEqual(pruneCache({ bad: null }, NOW), {});
});

test('the cache cap is bounded enough for chrome.storage.local', () => {
  assert.ok(CONTENT_CACHE_MAX <= 1000);
});
