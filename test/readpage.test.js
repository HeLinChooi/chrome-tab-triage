import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from '../src/lib/collect.js';

/** Stub chrome.scripting with a scripted sequence of injection results. */
function stubScripting(results) {
  let call = 0;
  global.chrome = {
    scripting: {
      executeScript: async () => {
        const next = results[Math.min(call++, results.length - 1)];
        if (next === 'hang') return new Promise(() => {}); // never settles
        if (next === 'throw') throw new Error('Cannot access contents of the page');
        return [{ result: next }];
      },
    },
  };
  return () => call;
}

const good = { wordCount: 900, videoSeconds: 0 };
const empty = { wordCount: 0, videoSeconds: 0, contentNodes: 0 };

test('a page that reads first time is not retried', async () => {
  const calls = stubScripting([good]);
  const out = await readPage(1, 500, true);
  assert.equal(out.status, 'ok');
  assert.equal(out.attempts, 1);
  assert.equal(calls(), 1);
});

test('an empty page is retried when the tab was just woken', async () => {
  const calls = stubScripting([empty, empty, good]);
  const out = await readPage(1, 500, true);
  assert.equal(out.status, 'ok');
  assert.equal(out.attempts, 3);
  assert.equal(calls(), 3);
});

test('an already-loaded tab is read once, not retried', async () => {
  const calls = stubScripting([empty]);
  const out = await readPage(1, 500, false);
  assert.equal(out.status, 'thin');
  assert.equal(calls(), 1, 'retrying a tab that rendered long ago just wastes time');
});

test('a hung injection times out instead of stalling the run', async () => {
  stubScripting(['hang']);
  const started = Date.now();
  const out = await readPage(1, 150, true);
  assert.equal(out.status, 'timeout');
  assert.ok(Date.now() - started < 1000);
});

test('a refused injection is distinguished from an empty page', async () => {
  stubScripting(['throw']);
  const out = await readPage(1, 200, true);
  assert.equal(out.status, 'refused');
});

test('retries give up and report what they last saw', async () => {
  const calls = stubScripting([empty]);
  const out = await readPage(1, 300, true);
  assert.equal(out.status, 'thin');
  assert.equal(out.content.wordCount, 0);
  assert.equal(calls(), 3, 'one initial read plus the two retry delays');
});

test('a probe timeout is short, so a suspended tab is cheap to detect', async () => {
  const { PROBE_TIMEOUT_MS } = await import('../src/lib/collect.js');
  // A healthy tab answers in about a millisecond; a suspended one never answers.
  // Waiting the full budget on the first attempt buys nothing.
  assert.ok(PROBE_TIMEOUT_MS <= 2000, 'the probe must stay short');
});
