/**
 * The report as a Markdown table, for the clipboard. Pure.
 *
 * A Markdown table renders as a table in notes and chat apps, and the raw
 * text is still readable. The title links to the tab's URL.
 */

import { TASK_TYPES } from './taxonomy.js';
import { ageInDays } from './staleness.js';

const COLUMNS = [
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
];

/** A newline would end the row, and a pipe would start a new column. */
const clean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');

/**
 * Square brackets in a title would end the link text early. In the URL, a
 * space or parenthesis would end the link and a pipe would start a new column,
 * so those are percent-encoded, which leaves the URL working.
 */
const link = (title, url) => {
  const text = clean(title).replace(/[[\]]/g, '\\$&');
  const href = String(url ?? '').replace(/[\s()|]/g, (c) => encodeURIComponent(c).replace('(', '%28').replace(')', '%29'));
  return `[${text}](${href})`;
};

export function reportToMarkdown(report) {
  // Same rule as the dashboard: every copy after the first occurrence of a URL.
  const seen = new Set();
  const duplicate = new Set();
  for (const item of report.items) {
    const key = (item.url || '').split('#')[0];
    if (seen.has(key)) duplicate.add(item);
    else seen.add(key);
  }

  const rows = report.items
    .slice()
    .sort((a, b) => b.minutes - a.minutes)
    .map((item) => {
      const content = item.content || {};
      return [
        link(item.title, item.url),
        clean(item.site),
        (TASK_TYPES[item.taskType] || TASK_TYPES.unknown).label,
        Math.round(item.minutes),
        content.wordCount || '',
        content.videoSeconds ? Math.round(content.videoSeconds / 60) : '',
        item.lastAccessed ? Math.floor(ageInDays(item, report.generatedAt)) : '',
        item.stale ? 'yes' : 'no',
        duplicate.has(item) ? 'yes' : 'no',
        clean(item.reason),
      ];
    });

  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(COLUMNS), line(COLUMNS.map(() => '---')), ...rows.map(line)].join('\n');
}
