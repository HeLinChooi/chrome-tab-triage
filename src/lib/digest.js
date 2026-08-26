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

  // Say plainly when estimates rest on rules of thumb instead of measurements.
  if (report.totals.unmeasured > 0) {
    const share = Math.round((report.totals.unmeasured / report.totals.tabs) * 100);
    report.warnings = [
      ...report.warnings,
      settings.readPageText
        ? `${report.totals.unmeasured} of ${report.totals.tabs} tabs (${share}%) could not be read — discarded, still loading, or a restricted page — so their estimates come from per-site rules rather than the real page length.`
        : `${report.totals.unmeasured} of ${report.totals.tabs} tabs (${share}%) were estimated from the title and URL alone. Turn on "Read page text" in Settings to estimate from real word counts and video lengths; without it a 45-minute video and a 3-minute one both score the same flat guess.`,
    ];
  }

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
