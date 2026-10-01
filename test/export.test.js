import test from 'node:test';
import assert from 'node:assert/strict';
import { reportToTsv } from '../src/lib/export.js';

const NOW = Date.UTC(2026, 0, 15);
const DAY = 24 * 60 * 60 * 1000;

const item = (over) => ({
  id: 1,
  url: 'https://a.test/',
  title: 'A page',
  site: 'a.test',
  taskType: 'read',
  minutes: 12.4,
  reason: '2,400 words at 200 wpm',
  lastAccessed: NOW - 3 * DAY,
  stale: false,
  content: { wordCount: 2400, videoSeconds: 0 },
  ...over,
});

const rows = (report) => reportToTsv(report).split('\n').map((line) => line.split('\t'));

test('the first line names every column', () => {
  const [header] = rows({ generatedAt: NOW, items: [] });
  assert.deepEqual(header, [
    'Title',
    'URL',
    'Site',
    'Task',
    'Minutes',
    'Words',
    'Media minutes',
    'Days idle',
    'Stale',
    'Duplicate',
    'Why',
  ]);
});

test('a tab becomes one row with its values', () => {
  const [, row] = rows({ generatedAt: NOW, items: [item()] });
  assert.deepEqual(row, [
    'A page',
    'https://a.test/',
    'a.test',
    'Read',
    '12',
    '2400',
    '',
    '3',
    'no',
    'no',
    '2,400 words at 200 wpm',
  ]);
});

test('media length is given in whole minutes', () => {
  const [, row] = rows({ generatedAt: NOW, items: [item({ content: { wordCount: 0, videoSeconds: 1530 } })] });
  assert.equal(row[6], '26');
});

test('a tab whose page was not read leaves words and media empty', () => {
  const [, row] = rows({ generatedAt: NOW, items: [item({ content: null })] });
  assert.equal(row[5], '');
  assert.equal(row[6], '');
});

test('the second copy of a URL is marked as a duplicate', () => {
  const report = { generatedAt: NOW, items: [item({ id: 1 }), item({ id: 2 })] };
  const [, first, second] = rows(report);
  assert.equal(first[9], 'no');
  assert.equal(second[9], 'yes');
});

test('a tab or newline inside a title cannot break the row', () => {
  const text = reportToTsv({ generatedAt: NOW, items: [item({ title: 'one\ttwo\nthree' })] });
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1].split('\t')[0], 'one two three');
});

test('rows are ordered by estimate, largest first', () => {
  const report = {
    generatedAt: NOW,
    items: [item({ id: 1, title: 'small', minutes: 2 }), item({ id: 2, title: 'big', url: 'https://b.test/', minutes: 40 })],
  };
  const [, first, second] = rows(report);
  assert.equal(first[0], 'big');
  assert.equal(second[0], 'small');
});
