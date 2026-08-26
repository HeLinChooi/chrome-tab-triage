import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/lib/group.js';
import { formatMinutes, headline } from '../src/lib/format.js';

const tabs = [
  { id: 1, windowId: 1, url: 'https://github.com/a/b/pull/1', title: 'PR' },
  { id: 2, windowId: 1, url: 'https://github.com/a/b', title: 'repo' },
  { id: 3, windowId: 2, url: 'https://www.youtube.com/watch?v=x', title: 'vid' },
  { id: 4, windowId: 2, url: 'https://github.com/a/b', title: 'repo again' },
];
const estimates = [
  { tabId: 1, minutes: 12, taskType: 'act', confidence: 'medium', reason: '', stale: false },
  { tabId: 2, minutes: 6, taskType: 'reference', confidence: 'medium', reason: '', stale: true },
  { tabId: 3, minutes: 20, taskType: 'watch', confidence: 'high', reason: '', stale: false },
  { tabId: 4, minutes: 6, taskType: 'reference', confidence: 'medium', reason: '', stale: false },
];

test('totals add up across tabs and windows', () => {
  const r = buildReport(tabs, estimates);
  assert.equal(r.totals.tabs, 4);
  assert.equal(r.totals.windows, 2);
  assert.equal(r.totals.minutes, 44);
  assert.equal(r.totals.staleTabs, 1);
  assert.equal(r.totals.duplicates, 1);
});

test('groups are sorted by time and carry a task breakdown', () => {
  const r = buildReport(tabs, estimates);
  assert.equal(r.groups[0].name, 'GitHub');
  assert.equal(r.groups[0].minutes, 24);
  assert.equal(r.groups[0].count, 3);
  assert.deepEqual(
    r.groups[0].breakdown.map((b) => b.type),
    ['reference', 'act'],
  );
  assert.equal(r.groups[1].name, 'YouTube');
});

test('task-type view totals independently of site', () => {
  const r = buildReport(tabs, estimates);
  const watch = r.taskTypes.find((t) => t.type === 'watch');
  assert.equal(watch.minutes, 20);
  assert.equal(watch.label, 'Watch');
});

test('tabs missing an estimate are dropped rather than counted as zero', () => {
  const r = buildReport(tabs, estimates.slice(0, 2));
  assert.equal(r.totals.tabs, 2);
});

test('duration formatting', () => {
  assert.equal(formatMinutes(0), '< 1m');
  assert.equal(formatMinutes(45), '45m');
  assert.equal(formatMinutes(60), '1h');
  assert.equal(formatMinutes(80), '1h 20m');
});

test('headline reads as a sentence', () => {
  const r = buildReport(tabs, estimates);
  assert.equal(headline(r), '4 tabs ≈ 44m to clear');
});
