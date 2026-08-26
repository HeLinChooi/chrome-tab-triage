import test from 'node:test';
import assert from 'node:assert/strict';
import { scrapePage } from '../src/lib/scrape.js';

/**
 * A minimal DOM whose body text appears only after `appearsAfterMs`, the way a
 * single-page app renders its content well after the load event.
 */
function fakeDom({ appearsAfterMs = 0, words = 0, videoSeconds = 0, videoAfterMs = 0 } = {}) {
  const start = Date.now();
  const bodyText = () => (Date.now() - start >= appearsAfterMs ? 'word '.repeat(words) : '');

  const media = {
    get duration() {
      return Date.now() - start >= videoAfterMs ? videoSeconds : NaN;
    },
  };

  global.document = {
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === 'video, audio' && videoSeconds ? [media] : []),
    get body() {
      return { innerText: bodyText() };
    },
  };
}

test('a page that is already rendered is read immediately', async () => {
  fakeDom({ words: 500 });
  const started = Date.now();
  const result = await scrapePage();
  assert.equal(result.wordCount, 500);
  assert.ok(Date.now() - started < 200, 'should not poll when the first read succeeds');
});

test('content that arrives after load is still measured', async () => {
  fakeDom({ appearsAfterMs: 600, words: 900 });
  const result = await scrapePage();
  assert.equal(result.wordCount, 900);
});

test('video duration that resolves late is picked up', async () => {
  fakeDom({ videoSeconds: 2700, videoAfterMs: 700 });
  const result = await scrapePage();
  assert.equal(result.videoSeconds, 2700);
});

test('a genuinely empty page gives up rather than polling forever', async () => {
  fakeDom({ words: 0 });
  const started = Date.now();
  const result = await scrapePage();
  const elapsed = Date.now() - started;
  assert.equal(result.wordCount, 0);
  assert.ok(elapsed >= 2400, 'should have waited for the settle window');
  assert.ok(elapsed < 4000, `gave up too late: ${elapsed}ms`);
});

test('a short page below the usable threshold is still returned', async () => {
  fakeDom({ words: 30 });
  const result = await scrapePage();
  assert.equal(result.wordCount, 30);
});
