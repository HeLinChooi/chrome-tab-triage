/** Orchestration: tabs in, finished report out. */

import { collectTabs, enrichWithContent } from './collect.js';
import { estimate } from './estimate.js';
import { buildReport } from './group.js';
import { getSettings, saveLastReport } from './settings.js';

/**
 * Run one full analysis.
 * @param {{persist?: boolean, trigger?: string}} opts
 */
export async function runAnalysis(opts = {}) {
  const settings = await getSettings();
  const tabs = await collectTabs(settings);

  let scrapeInfo = { scraped: 0, cached: 0 };
  if (settings.readPageText) {
    scrapeInfo = await enrichWithContent(tabs);
  }

  const { engine, estimates, warnings = [], transcript = null } = await estimate(tabs, settings);
  const report = buildReport(tabs, estimates, { engine, warnings });

  // What was actually sent to and returned by the API, for the transcript panel.
  report.transcript = transcript;

  report.trigger = opts.trigger || 'manual';
  report.scope = settings.scope;
  report.pageAccess = {
    enabled: Boolean(settings.readPageText),
    scraped: scrapeInfo.scraped,
    cached: scrapeInfo.cached,
  };

  if (opts.persist !== false) await saveLastReport(report);
  return report;
}
