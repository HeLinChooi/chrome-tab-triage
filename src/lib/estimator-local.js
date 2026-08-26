/**
 * Local heuristic estimator.
 *
 * Estimates "minutes to clear" from what we can observe without a network call:
 * the URL, the title, and — when the user has granted page access — the word
 * count and media duration scraped from the page.
 *
 * `baseEstimate` returns fresh effort. The staleness discount is applied on top
 * by `estimateTab`, using the same shared rule the Claude engine uses, so the
 * two engines stay comparable.
 */

import { classify, isInternalUrl } from './taxonomy.js';
import { applyStaleness } from './staleness.js';

export const DEFAULT_WPM = 238; // Brysbaert 2019, silent reading of non-fiction

export { STALE_DAYS } from './staleness.js';

function readingMinutes(wordCount, wpm) {
  return wordCount / Math.max(wpm, 50);
}

/**
 * Fresh effort for a tab, before any staleness discount.
 * @returns {{minutes: number, taskType: string, confidence: string, reason: string}}
 */
export function baseEstimate(tab, opts = {}) {
  const wpm = opts.wpm || DEFAULT_WPM;

  if (isInternalUrl(tab.url)) {
    return { minutes: 0, taskType: 'reference', confidence: 'high', reason: 'Browser page — nothing to clear' };
  }

  const { type, ruleMinutes, source } = classify(tab);
  const content = tab.content;

  if (type === 'watch' && content && content.videoSeconds > 0) {
    const minutes = content.videoSeconds / 60;
    return { minutes, taskType: type, confidence: 'high', reason: `${Math.round(minutes)} min of media on the page` };
  }

  if (content && content.wordCount >= 120 && (type === 'read' || type === 'reference' || type === 'unknown')) {
    // Reference pages get skimmed, not read end to end.
    const minutes = readingMinutes(content.wordCount, wpm) * (type === 'reference' ? 0.45 : 1);
    return {
      minutes,
      taskType: type,
      confidence: 'high',
      reason: `${content.wordCount.toLocaleString()} words at ${wpm} wpm`,
    };
  }

  if (ruleMinutes != null) {
    return {
      minutes: ruleMinutes,
      taskType: type,
      confidence: source === 'domain' ? 'medium' : 'low',
      reason: source === 'domain' ? 'Typical for this site' : 'Guessed from the tab title',
    };
  }

  return { minutes: 5, taskType: type, confidence: 'low', reason: 'No page signal available' };
}

/**
 * @param {object} tab normalized tab record
 * @param {object} opts {wpm, now}
 * @returns {{minutes: number, taskType: string, confidence: string, reason: string, stale: boolean}}
 */
export function estimateTab(tab, opts = {}) {
  const now = opts.now || Date.now();
  const base = baseEstimate(tab, opts);

  if (base.minutes === 0) {
    return { ...base, minutes: 0, stale: false };
  }

  const { minutes, stale, factor, ageDays } = applyStaleness(base.minutes, tab, now);
  let { reason, confidence } = base;
  if (factor < 1) {
    reason += `; discounted — untouched for ${Math.round(ageDays)} days`;
    if (confidence === 'high') confidence = 'medium';
  }

  return { minutes, taskType: base.taskType, confidence, reason, stale };
}

/** Estimate a whole set of tabs. Always resolves — this engine cannot fail. */
export async function estimateAll(tabs, settings = {}) {
  const now = Date.now();
  const wpm = settings.wpm || DEFAULT_WPM;
  return {
    engine: 'local',
    estimates: tabs.map((tab) => ({ tabId: tab.id, ...estimateTab(tab, { wpm, now }) })),
  };
}
