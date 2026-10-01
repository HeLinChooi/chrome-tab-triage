/**
 * The report as tab-separated text, for the clipboard. Pure.
 *
 * Tab-separated text pastes into a spreadsheet as columns and still reads
 * plainly in a note or a chat message.
 */

import { TASK_TYPES } from './taxonomy.js';
import { ageInDays } from './staleness.js';

const COLUMNS = [
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
];

/** A tab or newline inside a value would start a new column or row. */
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function reportToTsv(report) {
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
        item.title,
        item.url,
        item.site,
        (TASK_TYPES[item.taskType] || TASK_TYPES.unknown).label,
        Math.round(item.minutes),
        content.wordCount || '',
        content.videoSeconds ? Math.round(content.videoSeconds / 60) : '',
        item.lastAccessed ? Math.floor(ageInDays(item, report.generatedAt)) : '',
        item.stale ? 'yes' : 'no',
        duplicate.has(item) ? 'yes' : 'no',
        item.reason,
      ];
    });

  return [COLUMNS, ...rows].map((row) => row.map(clean).join('\t')).join('\n');
}
