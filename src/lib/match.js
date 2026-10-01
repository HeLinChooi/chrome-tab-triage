/**
 * Find the live tab each report record refers to. Pure.
 *
 * A report is stored and shown again later, but Chrome assigns new tab ids
 * every browser session. So an id alone is not enough: a record matches by id
 * only while that id still holds the same URL, and otherwise falls back to an
 * open tab with that URL. Each live tab is used at most once, so two copies of
 * a page resolve to two different tabs rather than the same one twice.
 *
 * @param {Array<{id: number, url: string}>} records from the report
 * @param {Array<{id: number, url: string}>} liveTabs from chrome.tabs.query
 * @returns {Map<number, number|null>} record id -> live tab id, or null if none
 */
export function matchLiveTabs(records, liveTabs) {
  const used = new Set();
  const result = new Map();

  // Exact matches first, so a URL fallback never takes a tab that an exact
  // match needs.
  const liveById = new Map(liveTabs.map((t) => [t.id, t]));
  for (const record of records) {
    const live = liveById.get(record.id);
    if (live && live.url === record.url) {
      result.set(record.id, live.id);
      used.add(live.id);
    }
  }

  for (const record of records) {
    if (result.has(record.id)) continue;
    const live = liveTabs.find((t) => !used.has(t.id) && t.url === record.url);
    result.set(record.id, live ? live.id : null);
    if (live) used.add(live.id);
  }
  return result;
}
