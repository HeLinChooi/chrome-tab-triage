import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStaleness, stalenessFactor, STALE_DAYS } from '../src/lib/staleness.js';

const NOW = Date.UTC(2026, 0, 15);
const daysAgo = (d) => NOW - d * 24 * 60 * 60 * 1000;

test('the discount steps down with age', () => {
  assert.equal(stalenessFactor(0), 1);
  assert.equal(stalenessFactor(3), 1);
  assert.equal(stalenessFactor(10), 0.75);
  assert.equal(stalenessFactor(STALE_DAYS), 0.3);
  assert.equal(stalenessFactor(STALE_DAYS * 3), 0.15);
});

test('a fresh tab keeps its full estimate', () => {
  const result = applyStaleness(20, { lastAccessed: NOW }, NOW);
  assert.equal(result.minutes, 20);
  assert.equal(result.stale, false);
});

test('a month-old tab is discounted and flagged', () => {
  const result = applyStaleness(20, { lastAccessed: daysAgo(STALE_DAYS + 1) }, NOW);
  assert.equal(result.minutes, 6);
  assert.equal(result.stale, true);
});

test('audio playing beats any age', () => {
  const result = applyStaleness(20, { lastAccessed: daysAgo(200), audible: true }, NOW);
  assert.equal(result.minutes, 20);
  assert.equal(result.stale, false);
  assert.equal(result.factor, 1);
});

test('a tab with no lastAccessed is treated as fresh, not ancient', () => {
  const result = applyStaleness(20, {}, NOW);
  assert.equal(result.minutes, 20);
  assert.equal(result.stale, false);
});

test('both engines discount identically, which is what makes them comparable', async () => {
  const { baseEstimate, estimateTab } = await import('../src/lib/estimator-local.js');
  const tab = {
    id: 1,
    url: 'https://blog.example/post',
    title: 'Something long',
    content: { wordCount: 2380 },
    lastAccessed: daysAgo(STALE_DAYS + 1),
  };

  // What the local engine reports is its own fresh estimate run through the
  // shared discount — the exact pipeline the Claude engine's output now takes.
  const fresh = baseEstimate(tab, { wpm: 238 });
  const local = estimateTab(tab, { now: NOW, wpm: 238 });
  const viaShared = applyStaleness(fresh.minutes, tab, NOW);
  assert.equal(local.minutes, viaShared.minutes);
});
