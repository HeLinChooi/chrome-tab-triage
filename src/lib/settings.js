/** Settings storage. The only place that knows the shape of persisted config. */

export const DEFAULTS = {
  engine: 'local', // 'local' | 'claude'
  apiKey: '',
  model: 'claude-opus-5',
  wpm: 238,
  scope: 'all', // 'all' | 'currentWindow'
  readPageText: false, // requires the optional <all_urls> permission
  digestEnabled: true,
  digestTime: '08:30', // local time, 24h
  digestDelivery: 'notification', // 'notification' | 'tab' | 'both'
  ignorePinned: true,
};

export const STORAGE_KEYS = {
  settings: 'settings',
  lastReport: 'lastReport',
  contentCache: 'contentCache',
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULTS, ...(stored[STORAGE_KEYS.settings] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function getLastReport() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.lastReport);
  return stored[STORAGE_KEYS.lastReport] || null;
}

export async function saveLastReport(report) {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastReport]: report });
}

/**
 * Parse "HH:MM" into {hours, minutes}. Returns null on malformed input so the
 * caller can fall back to the default rather than scheduling at a garbage time.
 */
export function parseTimeOfDay(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/** Next occurrence of a local wall-clock time, strictly in the future. */
export function nextOccurrence(timeOfDay, from = new Date()) {
  const at = new Date(from);
  at.setHours(timeOfDay.hours, timeOfDay.minutes, 0, 0);
  if (at.getTime() <= from.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}
