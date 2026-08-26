/**
 * Staleness: the one adjustment both estimators share.
 *
 * Keeping this out of the engines is what makes their numbers comparable. An
 * engine's job is to estimate the effort a tab needs *fresh*; how much of that
 * effort you would realistically still spend on a tab you have ignored for two
 * months is a separate, uniform judgement applied afterwards.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tabs untouched for this long are backlog, not work in progress. */
export const STALE_DAYS = 30;

export function ageInDays(tab, now = Date.now()) {
  if (!tab.lastAccessed) return 0;
  return Math.max(0, (now - tab.lastAccessed) / DAY_MS);
}

/**
 * A stale tab is worth less of your time than a fresh one: you have already
 * decided, by not opening it for a month, that it is not urgent.
 */
export function stalenessFactor(ageDays) {
  if (ageDays >= STALE_DAYS * 3) return 0.15;
  if (ageDays >= STALE_DAYS) return 0.3;
  if (ageDays >= 7) return 0.75;
  return 1;
}

/**
 * Apply the discount to a fresh-effort estimate.
 *
 * A tab playing audio is being consumed right now, so it is never discounted
 * however long ago Chrome thinks it was last activated.
 *
 * @returns {{minutes: number, stale: boolean, factor: number, ageDays: number}}
 */
export function applyStaleness(minutes, tab, now = Date.now()) {
  const ageDays = ageInDays(tab, now);
  const factor = tab.audible ? 1 : stalenessFactor(ageDays);
  return {
    minutes: Math.round(minutes * factor * 10) / 10,
    stale: ageDays >= STALE_DAYS && !tab.audible,
    factor,
    ageDays,
  };
}
