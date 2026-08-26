import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeOfDay, nextOccurrence } from '../src/lib/settings.js';

test('parseTimeOfDay accepts valid 24h times', () => {
  assert.deepEqual(parseTimeOfDay('08:30'), { hours: 8, minutes: 30 });
  assert.deepEqual(parseTimeOfDay('7:05'), { hours: 7, minutes: 5 });
  assert.deepEqual(parseTimeOfDay('23:59'), { hours: 23, minutes: 59 });
});

test('parseTimeOfDay rejects garbage rather than guessing', () => {
  for (const bad of ['', '25:00', '08:60', '830', 'morning', null, undefined]) {
    assert.equal(parseTimeOfDay(bad), null, `expected null for ${bad}`);
  }
});

test('nextOccurrence is today when the time is still ahead', () => {
  const from = new Date(2026, 0, 15, 6, 0, 0);
  const when = new Date(nextOccurrence({ hours: 8, minutes: 30 }, from));
  assert.equal(when.getDate(), 15);
  assert.equal(when.getHours(), 8);
  assert.equal(when.getMinutes(), 30);
});

test('nextOccurrence rolls to tomorrow once the time has passed', () => {
  const from = new Date(2026, 0, 15, 9, 0, 0);
  const when = new Date(nextOccurrence({ hours: 8, minutes: 30 }, from));
  assert.equal(when.getDate(), 16);
});

test('nextOccurrence is strictly in the future at the exact minute', () => {
  const from = new Date(2026, 0, 15, 8, 30, 0);
  const when = new Date(nextOccurrence({ hours: 8, minutes: 30 }, from));
  assert.equal(when.getDate(), 16);
});
