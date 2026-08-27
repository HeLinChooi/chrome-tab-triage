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
  if (info.frozen) {
    parts.push(
      `${info.frozen} were frozen by Chrome — a frozen tab runs no JavaScript at all, so nothing can read it, and Chrome most often freezes tabs sitting in a collapsed tab group` +
        (settings.reviveFrozenTabs
          ? ', and they did not come back when activated'
          : '. Expanding that group unfreezes them, or enable "Measure frozen tabs" in Settings to have them activated briefly'),
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
      info.thin +
      info.frozen
    : 0;
  const unexplained = Math.max(0, unmeasured - accountedFor);
  if (unexplained) {
    parts.push(`${unexplained} for reasons not recorded`);
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
      reviveFrozen: settings.reviveFrozenTabs,
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

  /*
   * Report what could not be read. A page that was read but priced by a per-site
   * rule is not a failure — for an inbox or a checkout, reading time is simply
   * the wrong model — so it does not belong in a warning.
   */
  if (!settings.readPageText) {
    report.warnings = [
      ...report.warnings,
      `Estimates come from titles and URLs alone. Turn on "Read page text" in Settings to use real word counts and video lengths; without it a 45-minute video and a 3-minute one score the same flat guess.`,
    ];
  } else if (report.totals.unread > 0) {
    const share = Math.round((report.totals.unread / report.totals.tabs) * 100);
    report.warnings = [
      ...report.warnings,
      `${report.totals.unread} of ${report.totals.tabs} tabs (${share}%) could not be read. ${explainSkips(scrapeInfo, settings, report.totals.unread)}`,
    ];
  }

  if (scrapeInfo.revived > 0) {
    report.warnings = [
      ...report.warnings,
      `Briefly activated ${scrapeInfo.revived} frozen tab(s) so their pages could be read, then restored your original tab.`,
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
