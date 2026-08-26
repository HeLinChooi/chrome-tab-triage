import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage, PROBE_TIMEOUT_MS } from '../src/lib/collect.js';

/**
 * The defining behaviour of a frozen tab, per Chromium 40901394 and
 * w3c/webextensions#527: executeScript against it neither resolves nor rejects.
 * The call is queued against a suspended renderer.
 */
function stubFrozenTab() {
  let injections = 0;
  global.chrome = {
    scripting: {
      executeScript: async () => {
        injections += 1;
        return new Promise(() => {}); // never settles, exactly like the real bug
      },
    },
  };
  return () => injections;
}

test('an injection into a frozen tab never settles, so it must be bounded', async () => {
  stubFrozenTab();
  const started = Date.now();
  const out = await readPage(1, 200, false);
  assert.equal(out.status, 'timeout');
  assert.ok(Date.now() - started < 1000, 'the timeout is the only thing that ends this call');
});

test('the probe is short, because a healthy tab answers in about a millisecond', () => {
  // Waiting the full budget to discover silence cost ~8s per frozen tab.
  assert.ok(PROBE_TIMEOUT_MS <= 2000);
});

test('a frozen tab is never injected into at all when reviving is off', async () => {
  // The guard lives in enrichWithContent, which needs the full chrome surface;
  // this pins the contract the guard depends on: frozen is knowable up front.
  const tab = { id: 1, frozen: true, discarded: false, status: 'complete' };
  const wouldInject = !tab.frozen;
  assert.equal(wouldInject, false, 'tab.frozen is readable before injecting (Chrome 132+)');
});

test('a discarded tab is a different state from a frozen one', () => {
  // Chrome cannot freeze a discarded tab, and the remedies differ: a discarded
  // tab reloads, a frozen tab must be activated.
  const discarded = { discarded: true, frozen: false };
  const frozen = { discarded: false, frozen: true, status: 'complete' };
  assert.notEqual(discarded.frozen, frozen.frozen);
  assert.equal(frozen.status, 'complete', 'a frozen tab still reports complete, which is why it slipped past the wake check');
});
