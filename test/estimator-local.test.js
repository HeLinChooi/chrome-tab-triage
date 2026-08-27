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

test('page size raises a per-site rule but never lowers it', () => {
  const doc = { url: 'https://docs.google.com/document/d/x', lastAccessed: NOW };
  const small = estimateTab({ ...doc, content: { wordCount: 200 } }, { now: NOW });
  const large = estimateTab({ ...doc, content: { wordCount: 20000 } }, { now: NOW });

  // The rule is the floor: a short doc still costs the typical amount.
  assert.equal(small.minutes, 15);
  // A very long one costs more, because size is real information.
  assert.ok(large.minutes > small.minutes, `${large.minutes} should exceed ${small.minutes}`);
});

test('a page read in full is high confidence even when priced by a rule', () => {
  // Previously these were reported as "unmeasured", which read as a failure to
  // read the page when the page had been read perfectly.
  const inbox = estimateTab(
    { url: 'https://mail.google.com/mail/u/0/', content: { wordCount: 2000 }, lastAccessed: NOW },
    { now: NOW },
  );
  assert.equal(inbox.confidence, 'high');
  assert.match(inbox.reason, /2,000 words/);
});

test('with no page content the rule still applies at medium confidence', () => {
  const inbox = estimateTab({ url: 'https://mail.google.com/mail/u/0/', lastAccessed: NOW }, { now: NOW });
  assert.equal(inbox.minutes, 20);
  assert.equal(inbox.confidence, 'medium');
});
