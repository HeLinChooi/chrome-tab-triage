import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, mapLimit, createCancelToken, CancelledError } from '../src/lib/async.js';

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

test('withTimeout returns the real value when it arrives in time', async () => {
  assert.equal(await withTimeout(delay(5, 'real'), 100, 'fallback'), 'real');
});

test('withTimeout falls back rather than hanging', async () => {
  assert.equal(await withTimeout(delay(500, 'real'), 20, 'fallback'), 'fallback');
});

test('one hung job cannot stall the batch', async () => {
  const started = Date.now();
  const jobs = [delay(5000, 'hung'), delay(1, 'quick')];
  const out = await Promise.all(jobs.map((j) => withTimeout(j, 30, null)));
  assert.deepEqual(out, [null, 'quick']);
  assert.ok(Date.now() - started < 1000);
});

test('mapLimit respects the ceiling and keeps input order', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay(5);
    inFlight -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test('mapLimit handles an empty list', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test('a cancel token reports and throws once cancelled', () => {
  const token = createCancelToken();
  assert.equal(token.cancelled, false);
  token.throwIfCancelled();
  token.cancel();
  assert.equal(token.cancelled, true);
  assert.throws(() => token.throwIfCancelled(), CancelledError);
});

test('a closed message channel is recognized, a real error is not', async () => {
  const { isChannelClosed } = await import('../src/ui/shared.js');
  assert.equal(
    isChannelClosed({ ok: false, error: 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received' }),
    true,
  );
  assert.equal(isChannelClosed({ ok: false, error: 'Receiving end does not exist.' }), true);
  assert.equal(isChannelClosed({ ok: false, error: 'invalid API key' }), false);
  assert.equal(isChannelClosed({ ok: true, report: {} }), false);
  assert.equal(isChannelClosed(null), false);
});
