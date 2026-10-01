import test from 'node:test';
import assert from 'node:assert/strict';
import { reportToMarkdown } from '../src/lib/export.js';

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

/** Cells of each line, without the separator line under the header. */
const rows = (report) =>
  reportToMarkdown(report)
    .split('\n')
    .filter((_, i) => i !== 1)
    .map((line) => line.slice(2, -2).split(' | '));

test('the first line names every column', () => {
  const [header] = rows({ generatedAt: NOW, items: [] });
  assert.deepEqual(header, [
    'Tab',
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
    '[A page](https://a.test/)',
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
  assert.equal(row[5], '26');
});

test('a tab whose page was not read leaves words and media empty', () => {
  const [, row] = rows({ generatedAt: NOW, items: [item({ content: null })] });
  assert.equal(row[4], '');
  assert.equal(row[5], '');
});

test('the second copy of a URL is marked as a duplicate', () => {
  const report = { generatedAt: NOW, items: [item({ id: 1 }), item({ id: 2 })] };
  const [, first, second] = rows(report);
  assert.equal(first[8], 'no');
  assert.equal(second[8], 'yes');
});

test('the header is followed by the separator line Markdown needs', () => {
  const lines = reportToMarkdown({ generatedAt: NOW, items: [] }).split('\n');
  assert.equal(lines[1], '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
});

test('a newline inside a title cannot break the row', () => {
  const lines = reportToMarkdown({ generatedAt: NOW, items: [item({ title: 'one\ntwo' })] }).split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[2].startsWith('| [one two](https://a.test/) |'));
});

test('a pipe in a title or reason is escaped so it stays in its column', () => {
  const text = reportToMarkdown({ generatedAt: NOW, items: [item({ title: 'a | b', reason: 'x | y' })] });
  assert.ok(text.includes('[a \\| b](https://a.test/)'));
  assert.ok(text.includes('| x \\| y |'));
});

test('square brackets in a title do not end the link early', () => {
  const text = reportToMarkdown({ generatedAt: NOW, items: [item({ title: '[WIP] fix' })] });
  assert.ok(text.includes('[\\[WIP\\] fix](https://a.test/)'));
});

test('spaces, parentheses and pipes in a URL are percent-encoded', () => {
  const text = reportToMarkdown({ generatedAt: NOW, items: [item({ url: 'https://a.test/x (y)|z' })] });
  assert.ok(text.includes('(https://a.test/x%20%28y%29%7Cz)'));
});

test('rows are ordered by estimate, largest first', () => {
  const report = {
    generatedAt: NOW,
    items: [item({ id: 1, title: 'small', minutes: 2 }), item({ id: 2, title: 'big', minutes: 40 })],
  };
  const [, first, second] = rows(report);
  assert.ok(first[0].startsWith('[big]'));
  assert.ok(second[0].startsWith('[small]'));
});
