/** Orchestration: tabs in, finished report out. */

/**
 * Turn the scrape counters into a sentence that says what to do about it.
 *
 * Sleeping tabs dominate this on a long-running profile: Chrome's memory saver
 * discards background tabs, and a discarded tab has no live page to read.
 */
function explainSkips(info, settings, unmeasured) {
  const parts = [];
  if (info.asleep) {
    parts.push(
      `${info.asleep} were asleep — Chrome discards background tabs to save memory, and a discarded tab has no page left to read` +
        (settings.wakeSleepingTabs ? '' : '. Enable "Wake sleeping tabs" in Settings to reload and read them'),
    );
  }
  if (info.wakeFailed) parts.push(`${info.wakeFailed} would not come back when reloaded`);
  if (info.restricted) parts.push(`${info.restricted} are pages extensions may not read, such as PDFs or the Chrome Web Store`);
  if (info.loading) parts.push(`${info.loading} were still loading`);
  if (info.timedOut) parts.push(`${info.timedOut} took too long to read`);
  if (info.pastDeadline) parts.push(`${info.pastDeadline} were past the run's time limit`);
  if (info.thin) parts.push(`${info.thin} were read but the page carried no measurable text or media`);

  // Tabs we read successfully can still lack a usable signal — a page with a
  // handful of words and no media gives nothing to measure. Account for them
  // explicitly rather than leaving the numbers not adding up.
  const accountedFor = parts.length
    ? info.asleep +
      info.wakeFailed +
      info.restricted +
      info.loading +
      info.timedOut +
      info.pastDeadline +
      info.thin
    : 0;
  const unexplained = Math.max(0, unmeasured - accountedFor);
  if (unexplained) {
    parts.push(`${unexplained} were measured but the reading was too weak to trust over the per-site rule`);
  }

  if (!parts.length) return '';
  return `Of those: ${parts.join('; ')}.`;
}

import { collectTabs, enrichWithContent } from './collect.js';
import { estimate } from './estimate.js';
import { buildReport } from './group.js';
import { getSettings, saveLastReport } from './settings.js';

/**
 * Run one full analysis.
 * @param {{persist?: boolean, trigger?: string, token?: object, onProgress?: Function}} opts
 */
export async function runAnalysis(opts = {}) {
  const { token, onProgress } = opts;
  const report_ = (phase, extra) => onProgress && onProgress({ phase, ...extra });

  const settings = await getSettings();
  report_('collecting');
  const tabs = await collectTabs(settings);
  if (token) token.throwIfCancelled();

  let scrapeInfo = { scraped: 0, cached: 0, skipped: 0, timedOut: 0 };
  if (settings.readPageText) {
    scrapeInfo = await enrichWithContent(tabs, {
      token,
      onProgress,
      wakeSleeping: settings.wakeSleepingTabs,
      ignoreCache: opts.ignoreCache,
    });
    if (token) token.throwIfCancelled();
  }

  report_('estimating', { total: tabs.length });
  const { engine, estimates, warnings = [], transcript = null } = await estimate(tabs, settings, { token });
  if (token) token.throwIfCancelled();
  const report = buildReport(tabs, estimates, { engine, warnings });

  // What was actually sent to and returned by the API, for the transcript panel.
  report.transcript = transcript;

  // Say plainly when estimates rest on rules of thumb instead of measurements,
  // and name the actual reason rather than listing every possibility.
  if (report.totals.unmeasured > 0) {
    const share = Math.round((report.totals.unmeasured / report.totals.tabs) * 100);
    const head = `${report.totals.unmeasured} of ${report.totals.tabs} tabs (${share}%) were estimated from per-site rules rather than the real page.`;

    report.warnings = [
      ...report.warnings,
      settings.readPageText
        ? `${head} ${explainSkips(scrapeInfo, settings, report.totals.unmeasured)}`
        : `${head} Turn on "Read page text" in Settings to estimate from real word counts and video lengths; without it a 45-minute video and a 3-minute one both score the same flat guess.`,
    ];
  }

  if (scrapeInfo.woken > 0) {
    report.warnings = [
      ...report.warnings,
      `Reloaded ${scrapeInfo.woken} sleeping tab(s) in order to read them.`,
    ];
  }

  report.trigger = opts.trigger || 'manual';
  report.scope = settings.scope;
  report.readLog = scrapeInfo.log || [];
  report.pageAccess = {
    enabled: Boolean(settings.readPageText),
    scraped: scrapeInfo.scraped,
    cached: scrapeInfo.cached,
    skipped: scrapeInfo.skipped,
    timedOut: scrapeInfo.timedOut,
  };



  if (opts.persist !== false) await saveLastReport(report);
  return report;
}
