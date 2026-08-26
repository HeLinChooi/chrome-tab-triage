import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTab, DEFAULT_WPM, STALE_DAYS } from '../src/lib/estimator-local.js';

const NOW = Date.UTC(2026, 0, 15);
const daysAgo = (d) => NOW - d * 24 * 60 * 60 * 1000;

test('chrome pages cost nothing', () => {
  const e = estimateTab({ url: 'chrome://newtab', lastAccessed: NOW }, { now: NOW });
  assert.equal(e.minutes, 0);
});

test('word count drives reading time', () => {
  const e = estimateTab(
    { url: 'https://blog.example/post', content: { wordCount: DEFAULT_WPM * 10 }, lastAccessed: NOW },
    { now: NOW },
  );
  assert.equal(e.minutes, 10);
  assert.equal(e.confidence, 'high');
});

test('custom wpm changes the estimate', () => {
  const tab = { url: 'https://blog.example/post', content: { wordCount: 1000 }, lastAccessed: NOW };
  const slow = estimateTab(tab, { now: NOW, wpm: 100 });
  const fast = estimateTab(tab, { now: NOW, wpm: 400 });
  assert.ok(slow.minutes > fast.minutes);
});

test('video duration wins over word count', () => {
  const e = estimateTab(
    { url: 'https://www.youtube.com/watch?v=x', content: { wordCount: 900, videoSeconds: 1800 }, lastAccessed: NOW },
    { now: NOW },
  );
  assert.equal(e.taskType, 'watch');
  assert.equal(e.minutes, 30);
});

test('reference pages are skimmed, not read whole', () => {
  const content = { wordCount: 2380 };
  const ref = estimateTab({ url: 'https://stackoverflow.com/questions/1', content, lastAccessed: NOW }, { now: NOW });
  const read = estimateTab({ url: 'https://blog.example/p', content, lastAccessed: NOW }, { now: NOW });
  assert.ok(ref.minutes < read.minutes);
});

test('stale tabs are discounted and flagged', () => {
  const tab = { url: 'https://blog.example/post', content: { wordCount: 2380 } };
  const fresh = estimateTab({ ...tab, lastAccessed: NOW }, { now: NOW });
  const old = estimateTab({ ...tab, lastAccessed: daysAgo(STALE_DAYS + 5) }, { now: NOW });
  assert.ok(old.minutes < fresh.minutes);
  assert.equal(old.stale, true);
  assert.equal(fresh.stale, false);
});

test('an audible tab is never discounted as stale', () => {
  const e = estimateTab(
    { url: 'https://www.youtube.com/watch?v=x', audible: true, lastAccessed: daysAgo(90), content: { videoSeconds: 600 } },
    { now: NOW },
  );
  assert.equal(e.minutes, 10);
  assert.equal(e.stale, false);
});

test('a bare unknown URL still gets a low-confidence estimate', () => {
  const e = estimateTab({ url: 'https://unknown.example/thing', lastAccessed: NOW }, { now: NOW });
  assert.ok(e.minutes > 0);
  assert.equal(e.confidence, 'low');
});
