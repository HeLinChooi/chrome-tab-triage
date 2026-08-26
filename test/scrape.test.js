import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneCache, cacheKey, CONTENT_TTL_MS, CONTENT_CACHE_MAX } from '../src/lib/scrape.js';

const NOW = 1_800_000_000_000;

test('cacheKey ignores the fragment', () => {
  assert.equal(cacheKey('https://a.example/p#section-2'), 'https://a.example/p');
  assert.equal(cacheKey(undefined), '');
});

test('pruneCache drops entries past the TTL', () => {
  const cache = {
    fresh: { scrapedAt: NOW - 1000 },
    stale: { scrapedAt: NOW - CONTENT_TTL_MS - 1 },
  };
  assert.deepEqual(Object.keys(pruneCache(cache, NOW)), ['fresh']);
});

test('pruneCache keeps the newest entries when over the cap', () => {
  const cache = {};
  for (let i = 0; i < 10; i++) cache[`k${i}`] = { scrapedAt: NOW - i * 1000 };
  const pruned = pruneCache(cache, NOW, 3);
  assert.deepEqual(Object.keys(pruned), ['k0', 'k1', 'k2']);
});

test('pruneCache tolerates a missing or malformed cache', () => {
  assert.deepEqual(pruneCache(undefined, NOW), {});
  assert.deepEqual(pruneCache({ bad: null }, NOW), {});
});

test('the cache cap is bounded enough for chrome.storage.local', () => {
  assert.ok(CONTENT_CACHE_MAX <= 1000);
});
