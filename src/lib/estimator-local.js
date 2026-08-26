/**
 * Local heuristic estimator.
 *
 * Estimates "minutes to clear" from what we can observe without a network call:
 * the URL, the title, how stale the tab is, and — when the user has granted page
 * access — the word count and media duration scraped from the page.
 */

import { classify, isInternalUrl } from './taxonomy.js';

export const DEFAULT_WPM = 238; // Brysbaert 2019, silent reading of non-fiction

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tabs untouched for this long are backlog, not work in progress. */
export const STALE_DAYS = 30;

/**
 * A stale tab is worth less of your time than a fresh one: you have already
 * decided, by not opening it for a month, that it is not urgent. We discount the
 * estimate rather than dropping the tab, and flag it so the UI can offer a bulk
 * close.
 */
function stalenessFactor(ageDays) {
  if (ageDays >= STALE_DAYS * 3) return 0.15;
  if (ageDays >= STALE_DAYS) return 0.3;
  if (ageDays >= 7) return 0.75;
  return 1;
}

function readingMinutes(wordCount, wpm) {
  return wordCount / Math.max(wpm, 50);
}

/**
 * @param {object} tab normalized tab record
 * @param {object} opts {wpm, now}
 * @returns {{minutes: number, taskType: string, confidence: string, reason: string, stale: boolean}}
 */
export function estimateTab(tab, opts = {}) {
  const wpm = opts.wpm || DEFAULT_WPM;
  const now = opts.now || Date.now();

  if (isInternalUrl(tab.url)) {
    return {
      minutes: 0,
      taskType: 'reference',
      confidence: 'high',
      reason: 'Browser page — nothing to clear',
      stale: false,
    };
  }

  const { type, ruleMinutes, source } = classify(tab);
  const content = tab.content;

  let minutes;
  let confidence;
  let reason;

  if (type === 'watch' && content && content.videoSeconds > 0) {
    minutes = content.videoSeconds / 60;
    confidence = 'high';
    reason = `${Math.round(minutes)} min of media on the page`;
  } else if (content && content.wordCount >= 120 && (type === 'read' || type === 'reference' || type === 'unknown')) {
    minutes = readingMinutes(content.wordCount, wpm);
    // Reference pages get skimmed, not read end to end.
    if (type === 'reference') minutes *= 0.45;
    confidence = 'high';
    reason = `${content.wordCount.toLocaleString()} words at ${wpm} wpm`;
  } else if (ruleMinutes != null) {
    minutes = ruleMinutes;
    confidence = source === 'domain' ? 'medium' : 'low';
    reason = source === 'domain' ? 'Typical for this site' : 'Guessed from the tab title';
  } else {
    minutes = 5;
    confidence = 'low';
    reason = 'No page signal available';
  }

  // A tab playing audio is being consumed right now — do not discount it.
  const ageDays = tab.lastAccessed ? Math.max(0, (now - tab.lastAccessed) / DAY_MS) : 0;
  const stale = ageDays >= STALE_DAYS && !tab.audible;
  const factor = tab.audible ? 1 : stalenessFactor(ageDays);
  if (factor < 1) {
    reason += `; discounted — untouched for ${Math.round(ageDays)} days`;
    if (confidence === 'high') confidence = 'medium';
  }

  return {
    minutes: Math.round(minutes * factor * 10) / 10,
    taskType: type,
    confidence,
    reason,
    stale,
  };
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
