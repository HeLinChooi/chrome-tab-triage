import test from 'node:test';
import assert from 'node:assert/strict';

// explainSkips is internal to digest.js, which imports Chrome-only modules.
// Re-derive its contract here against the same arithmetic so the reconciliation
// stays honest: every unmeasured tab must be accounted for by some reason.
function reasonsTotal(info) {
  return (
    info.asleep + info.wakeFailed + info.restricted + info.loading + info.timedOut + info.pastDeadline
  );
}

const empty = { asleep: 0, wakeFailed: 0, restricted: 0, loading: 0, timedOut: 0, pastDeadline: 0 };

test('the reported reasons never exceed the unmeasured count', () => {
  const info = { ...empty, asleep: 9, timedOut: 2 };
  const unmeasured = 15;
  const thin = Math.max(0, unmeasured - reasonsTotal(info));
  assert.equal(reasonsTotal(info) + thin, unmeasured);
  assert.equal(thin, 4, 'the four tabs read but too thin to measure must be named');
});

test('reasons that already account for everything add no remainder', () => {
  const info = { ...empty, asleep: 9, timedOut: 2, restricted: 4 };
  const thin = Math.max(0, 15 - reasonsTotal(info));
  assert.equal(thin, 0);
});

test('a remainder is never negative when reasons overcount', () => {
  const info = { ...empty, asleep: 20 };
  assert.equal(Math.max(0, 15 - reasonsTotal(info)), 0);
});
