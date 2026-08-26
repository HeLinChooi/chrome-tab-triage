import test from 'node:test';
import assert from 'node:assert/strict';
import { scrapePage } from '../src/lib/scrape.js';

const CONTENT_SELECTOR = 'p, li, article, main, h1, h2, h3, td, pre, blockquote';

/**
 * `layoutCost` counts innerText reads — the expensive, layout-forcing call the
 * reader must make at most once.
 */
function fakeDom({ words = 0, videoSeconds = 0, nodes = 20 } = {}) {
  const counters = { innerTextReads: 0, timersUsed: 0 };
  const media = { duration: videoSeconds || NaN };

  global.document = {
    readyState: 'complete',
    hidden: true,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === 'video, audio') return videoSeconds ? [media] : [];
      if (sel === CONTENT_SELECTOR) return new Array(words ? nodes : 0).fill({});
      return [];
    },
    get body() {
      return {
        get innerText() {
          counters.innerTextReads += 1;
          return 'word '.repeat(words);
        },
      };
    },
  };
  return counters;
}

test('the reader is synchronous — it must not depend on in-page timers', () => {
  fakeDom({ words: 500 });
  const result = scrapePage();
  assert.ok(!(result instanceof Promise), 'returning a promise means awaiting throttled timers');
  assert.equal(result.wordCount, 500);
});

test('innerText is read exactly once, however large the page', () => {
  const counters = fakeDom({ words: 5000 });
  scrapePage();
  assert.equal(counters.innerTextReads, 1);
});

test('an empty page returns immediately rather than waiting in the page', () => {
  const started = Date.now();
  fakeDom({ words: 0 });
  const result = scrapePage();
  assert.equal(result.wordCount, 0);
  assert.ok(Date.now() - started < 50, 'a hidden tab cannot wait; the extension retries instead');
});

test('media duration is reported when present', () => {
  fakeDom({ videoSeconds: 2700 });
  assert.equal(scrapePage().videoSeconds, 2700);
});

test('diagnostics needed to explain a failure come back with the reading', () => {
  fakeDom({ words: 0 });
  const result = scrapePage();
  assert.equal(result.readyState, 'complete');
  assert.equal(result.hidden, true);
  assert.equal(typeof result.contentNodes, 'number');
  assert.equal(typeof result.tookMs, 'number');
});
