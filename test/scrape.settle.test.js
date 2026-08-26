import test from 'node:test';
import assert from 'node:assert/strict';
import { scrapePage } from '../src/lib/scrape.js';

/**
 * A minimal DOM whose body text appears only after `appearsAfterMs`, the way a
 * single-page app renders its content well after the load event.
 */
const CONTENT_SELECTOR = 'p, li, article, main, h1, h2, h3, td, pre, blockquote';

/**
 * A minimal DOM whose content nodes and text appear only after `appearsAfterMs`,
 * the way a single-page app renders well after the load event.
 *
 * `layoutCost` counts innerText reads, which are the expensive, layout-forcing
 * calls the reader must not make in a loop.
 */
function fakeDom({ appearsAfterMs = 0, words = 0, videoSeconds = 0, videoAfterMs = 0 } = {}) {
  const start = Date.now();
  const ready = () => Date.now() - start >= appearsAfterMs;
  const counters = { innerTextReads: 0 };

  const media = {
    get duration() {
      return Date.now() - start >= videoAfterMs ? videoSeconds : NaN;
    },
  };

  global.document = {
    readyState: 'complete',
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === 'video, audio') return videoSeconds ? [media] : [];
      if (sel === CONTENT_SELECTOR) return new Array(ready() && words ? 20 : 0).fill({});
      return [];
    },
    get body() {
      return {
        get innerText() {
          counters.innerTextReads += 1;
          return ready() ? 'word '.repeat(words) : '';
        },
      };
    },
  };
  return counters;
}

test('a page that is already rendered is read immediately', async () => {
  const counters = fakeDom({ words: 500 });
  const started = Date.now();
  const result = await scrapePage();
  assert.equal(result.wordCount, 500);
  assert.ok(Date.now() - started < 200, 'should not poll when content is already present');
  assert.equal(counters.innerTextReads, 1, 'innerText forces layout; read it once');
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
  const counters = fakeDom({ words: 0 });
  const started = Date.now();
  const result = await scrapePage();
  const elapsed = Date.now() - started;
  assert.equal(result.wordCount, 0);
  assert.ok(elapsed >= 1800, 'should have waited for the settle window');
  assert.ok(elapsed < 3500, `gave up too late: ${elapsed}ms`);
  // The whole point: waiting is done with cheap probes, not repeated layouts.
  assert.equal(counters.innerTextReads, 1, 'must not poll with innerText');
});

test('polling never costs more than one layout, however long it waits', async () => {
  const counters = fakeDom({ appearsAfterMs: 1200, words: 900 });
  const result = await scrapePage();
  assert.equal(result.wordCount, 900);
  assert.equal(counters.innerTextReads, 1);
});

test('a short page below the usable threshold is still returned', async () => {
  fakeDom({ words: 30 });
  const result = await scrapePage();
  assert.equal(result.wordCount, 30);
});
