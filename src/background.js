/**
 * Service worker: scheduling, messaging, and notifications.
 *
 * MV3 service workers are killed aggressively, so nothing is kept in memory
 * between events — every handler reads what it needs from storage.
 */

import { runAnalysis } from './lib/digest.js';
import { getSettings, getLastReport, parseTimeOfDay, nextOccurrence, DEFAULTS } from './lib/settings.js';
import { headline, subhead, formatMinutes } from './lib/format.js';
import { createCancelToken } from './lib/async.js';
import { matchLiveTabs } from './lib/match.js';

const DIGEST_ALARM = 'morning-digest';

/**
 * The run currently in flight, if any. A run can take a while when page reading
 * is on — dozens of tabs to wake and read — so it has to be interruptible, and
 * a second run must not start on top of the first.
 */
let activeRun = null;

/**
 * MV3 tears the service worker down when it looks idle, and a long run is exactly
 * when that hurts: the worker dies, sendResponse never fires, and the caller sees
 * "the message channel closed before a response was received". Touching an
 * extension API on a timer resets the idle countdown for as long as work is live.
 */
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/** Tell any open UI how far along a run is. No listener is a normal case. */
function broadcastProgress(update) {
  chrome.runtime.sendMessage({ type: 'analysisProgress', ...update }).catch(() => {});
}

/**
 * Run an analysis under a cancel token, refusing to start a second one.
 */
async function runCancellable(opts = {}) {
  if (activeRun) return { ok: false, busy: true, error: 'A summary is already running.' };

  const token = createCancelToken();
  activeRun = { token, startedAt: Date.now() };
  startKeepAlive();
  broadcastProgress({ phase: 'starting' });

  try {
    const report = await runAnalysis({
      ...opts,
      token,
      onProgress: broadcastProgress,
    });
    broadcastProgress({ phase: 'done' });
    return { ok: true, report };
  } catch (error) {
    if (error && error.cancelled) {
      broadcastProgress({ phase: 'cancelled' });
      return { ok: false, cancelled: true, error: 'Summary cancelled.' };
    }
    broadcastProgress({ phase: 'failed' });
    throw error;
  } finally {
    activeRun = null;
    stopKeepAlive();
  }
}
const DIGEST_NOTIFICATION = 'morning-digest-notification';

// --- Scheduling ---------------------------------------------------------

async function scheduleDigest() {
  await chrome.alarms.clear(DIGEST_ALARM);
  const settings = await getSettings();
  if (!settings.digestEnabled) return null;

  const timeOfDay = parseTimeOfDay(settings.digestTime) || parseTimeOfDay(DEFAULTS.digestTime);
  const when = nextOccurrence(timeOfDay);
  // Fires once, then reschedules on fire. A repeating alarm would drift out of
  // sync with local wall-clock time across DST changes.
  await chrome.alarms.create(DIGEST_ALARM, { when });
  return when;
}

/**
 * Run the digest and report what actually happened. Callers surface the result,
 * so a digest that was built but never shown does not read as a success.
 *
 * @returns {Promise<{notified: boolean, detail: string, report?: object}>}
 */
async function fireDigest(opts = {}) {
  try {
    const run = await runCancellable({ trigger: opts.manual ? 'manual-digest' : 'digest' });
    if (!run.ok) return { notified: false, detail: run.error };
    const report = run.report;
    await updateBadge(report);
    const outcome = await deliverDigest(report, opts);
    return { ...outcome, report };
  } catch (error) {
    console.error('[tab-triage] digest failed', error);
    return { notified: false, detail: `Digest failed: ${error && error.message ? error.message : String(error)}` };
  } finally {
    await scheduleDigest();
  }
}

/**
 * Deliver a finished digest by whichever route the user picked.
 *
 * A notification that Chrome accepts can still be swallowed by the operating
 * system without any error, so notification mode falls back to opening the
 * dashboard whenever the notification path reports a failure — and users who
 * have seen that happen can skip notifications entirely.
 */
async function deliverDigest(report, opts = {}) {
  // A scheduled digest reuses its tab so a week of them does not pile up. One the
  // user asked for by hand gets a fresh tab, so it never replaces what they were
  // already reading.
  const reuse = !opts.manual;

  if (report.totals.tabs === 0) {
    return { notified: false, detail: 'No tabs matched the current scope, so there was nothing to send.' };
  }

  const settings = await getSettings();
  const mode = settings.digestDelivery || DEFAULTS.digestDelivery;

  if (mode === 'tab') {
    await openDashboard({ reuse });
    return { notified: true, detail: `${headline(report)} — opened in the dashboard.` };
  }

  const outcome = await notifyDigest(report);

  if (mode === 'both') {
    await openDashboard({ active: false, reuse });
    return {
      notified: true,
      detail: outcome.notified
        ? `${headline(report)} — notification sent and dashboard opened.`
        : `${headline(report)} — opened in the dashboard (${outcome.detail}).`,
    };
  }

  if (!outcome.notified) {
    // Notifications are off or broken; show the digest rather than lose it.
    await openDashboard({ reuse });
    return { notified: true, detail: `${outcome.detail} Opened the dashboard instead.` };
  }

  return outcome;
}

async function notifyDigest(report) {
  // Chrome reports 'denied' when notifications are switched off for the browser
  // at the OS level — the most common reason a "sent" digest never appears.
  const level = await chrome.notifications.getPermissionLevel();
  if (level !== 'granted') {
    return {
      notified: false,
      detail: 'Chrome is not allowed to show notifications. Enable them for Chrome in your operating system settings.',
    };
  }

  try {
    await chrome.notifications.create(DIGEST_NOTIFICATION, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: headline(report),
      message: subhead(report) || 'Open the dashboard for the breakdown.',
      buttons: [{ title: 'Open dashboard' }],
      requireInteraction: false,
    });
  } catch (error) {
    return { notified: false, detail: `Chrome refused the notification: ${error && error.message ? error.message : String(error)}` };
  }

  return { notified: true, detail: headline(report) };
}

// --- Badge --------------------------------------------------------------

async function updateBadge(report) {
  const hours = report.totals.minutes / 60;
  const text = report.totals.tabs === 0 ? '' : hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(report.totals.minutes)}m`;
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: hours >= 8 ? '#b4341f' : '#5b6470' });
  await chrome.action.setTitle({
    title: `Tab Triage — ${report.totals.tabs} tabs, ${formatMinutes(report.totals.minutes)} to clear`,
  });
}

// --- Events -------------------------------------------------------------

/** The badge lives on the action, which is reset every time the worker restarts. */
async function restoreBadge() {
  const report = await getLastReport();
  if (report) await updateBadge(report);
}

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleDigest();
  await restoreBadge();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleDigest();
  await restoreBadge();
});

// Also runs on a plain service-worker wake-up, which is when the badge is blank.
restoreBadge();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DIGEST_ALARM) fireDigest();
});

/**
 * Open the dashboard.
 *
 * `reuse` refreshes a dashboard tab that is already open, which is what an
 * unattended daily digest wants; a manual run passes `reuse: false` so it always
 * lands in a new tab rather than navigating one the user is looking at.
 */
async function openDashboard({ active = true, reuse = true } = {}) {
  const url = chrome.runtime.getURL('dashboard.html');
  const [existing] = reuse ? await chrome.tabs.query({ url }) : [];

  if (existing) {
    await chrome.tabs.reload(existing.id); // pick up the report we just stored
    if (active) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return existing.id;
  }

  const tab = await chrome.tabs.create({ url, active });
  return tab.id;
}

chrome.notifications.onClicked.addListener((id) => {
  if (id !== DIGEST_NOTIFICATION) return;
  chrome.notifications.clear(id);
  openDashboard();
});

chrome.notifications.onButtonClicked.addListener((id) => {
  if (id !== DIGEST_NOTIFICATION) return;
  chrome.notifications.clear(id);
  openDashboard();
});

/**
 * Message router. Every handler returns a plain object; errors are returned as
 * `{ ok: false, error }` rather than thrown, so the UI never sees a dangling promise.
 */
const handlers = {
  async analyze() {
    const run = await runCancellable({ trigger: 'manual' });
    if (run.ok) await updateBadge(run.report);
    return run;
  },

  /** Re-read every page from scratch, ignoring anything already cached. */
  async analyzeFresh() {
    const run = await runCancellable({ trigger: 'manual', ignoreCache: true });
    if (run.ok) await updateBadge(run.report);
    return run;
  },

  async clearContentCache() {
    await chrome.storage.local.remove('contentCache');
    return { ok: true };
  },

  async cancelAnalysis() {
    if (!activeRun) return { ok: true, cancelled: false };
    activeRun.token.cancel();
    return { ok: true, cancelled: true };
  },

  async runStatus() {
    return { ok: true, running: Boolean(activeRun), startedAt: activeRun ? activeRun.startedAt : null };
  },

  async lastReport() {
    return { ok: true, report: await getLastReport() };
  },

  async rescheduleDigest() {
    const when = await scheduleDigest();
    return { ok: true, when };
  },

  /**
   * A report is a snapshot, so by the time the user acts on it some of its tabs
   * may already be gone, and after a browser restart every surviving tab has a
   * new id. Each record is matched to a live tab by id and URL first.
   * chrome.tabs.remove rejects the whole call if any id is invalid, so only
   * matched ids are passed to it.
   */
  async closeTabs({ tabs }) {
    const records = (tabs || []).filter((t) => t && Number.isInteger(t.id));
    if (!records.length) return { ok: true, closed: 0, missing: 0 };

    const matched = matchLiveTabs(records, await chrome.tabs.query({}));
    const ids = [...matched.values()].filter((id) => id != null);
    if (ids.length) await chrome.tabs.remove(ids);
    return { ok: true, closed: ids.length, missing: records.length - ids.length };
  },

  async focusTab({ tab: record }) {
    const tabId = matchLiveTabs([record], await chrome.tabs.query({})).get(record.id);
    // Closed since the report was taken. Not an error worth a dialog.
    if (tabId == null) return { ok: false, gone: true, error: 'That tab is no longer open.' };

    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return { ok: true };
  },

  async runDigestNow() {
    const outcome = await fireDigest({ manual: true });
    return { ok: outcome.notified, error: outcome.notified ? undefined : outcome.detail, detail: outcome.detail };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Our own broadcast to the UI; not a request awaiting a reply.
  if (message && message.type === 'analysisProgress') return false;

  const handler = handlers[message && message.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message: ${message && message.type}` });
    return false;
  }
  handler(message).then(sendResponse, (error) => {
    console.error('[tab-triage]', message.type, error);
    sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
  });
  return true; // keeps the message channel open for the async response
});
