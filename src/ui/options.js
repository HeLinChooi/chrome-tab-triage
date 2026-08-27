import { getSettings, saveSettings, parseTimeOfDay, nextOccurrence, DEFAULTS } from '../lib/settings.js';
import { ALL_URLS } from '../lib/collect.js';
import { send, guard } from './shared.js';

const API_ORIGIN = { origins: ['https://api.anthropic.com/*'] };

const els = {};
for (const id of [
  'apiKey', 'model', 'scope', 'ignorePinned', 'readPageText', 'wakeSleepingTabs', 'reviveFrozenTabs', 'wpm',
  'digestEnabled', 'digestTime', 'digestDelivery', 'save', 'saveStatus', 'digestStatus',
  'nextRun', 'testDigest', 'clearCache', 'cacheStatus', 'unsaved',
  'claude-settings',
]) {
  els[id] = document.getElementById(id);
}

function engineInputs() {
  return [...document.querySelectorAll('input[name="engine"]')];
}

function selectedEngine() {
  const checked = engineInputs().find((i) => i.checked);
  return checked ? checked.value : 'local';
}

/**
 * Unsaved-change tracking.
 *
 * Most of this form only reaches storage when Save is pressed, but the two
 * permission toggles write immediately — they have to, because the permission
 * itself is granted or revoked at the moment the box is ticked, and storage that
 * disagrees with the real permission is worse than an unsaved field. So the
 * baseline is a value per field rather than one snapshot: an immediate write
 * updates only its own field and leaves everything else dirty.
 */
function formValues() {
  return {
    engine: selectedEngine(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    scope: els.scope.value,
    ignorePinned: els.ignorePinned.checked,
    readPageText: els.readPageText.checked,
    wakeSleepingTabs: els.wakeSleepingTabs.checked,
    reviveFrozenTabs: els.reviveFrozenTabs.checked,
    wpm: String(els.wpm.value),
    digestEnabled: els.digestEnabled.checked,
    digestTime: els.digestTime.value,
    digestDelivery: els.digestDelivery.value,
  };
}

let baseline = null;

function changedFields() {
  if (!baseline) return [];
  const now = formValues();
  return Object.keys(now).filter((k) => now[k] !== baseline[k]);
}

const isDirty = () => changedFields().length > 0;

/** Record the whole form as saved. */
function markClean() {
  baseline = formValues();
  showDirtyState();
}

/** Record a single field as saved, leaving any other edits dirty. */
function markFieldClean(field) {
  if (baseline) baseline[field] = formValues()[field];
  showDirtyState();
}

function showDirtyState() {
  const changed = changedFields();
  els.unsaved.hidden = changed.length === 0;
  if (changed.length) {
    els.unsaved.textContent =
      changed.length <= 2
        ? `unsaved: ${changed.join(', ')}`
        : `${changed.length} unsaved changes`;
    els.unsaved.title = `Not saved yet: ${changed.join(', ')}`;
    // "Saved." next to "1 unsaved change" is a contradiction; the older of the
    // two statements is the one that stopped being true.
    if (els.saveStatus.textContent === 'Saved.') els.saveStatus.textContent = '';
  }
  // The tab title carries it too, for when the page is not the one in front.
  document.title = changed.length ? '• Tab Triage settings' : 'Tab Triage settings';
}

/**
 * Chrome will only show this prompt if the user has interacted with the page,
 * and always uses its own wording — the string is required but never displayed.
 */
window.addEventListener('beforeunload', (event) => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

function syncEngineVisibility() {
  els['claude-settings'].hidden = selectedEngine() !== 'claude';
}

function showNextRun() {
  if (!els.digestEnabled.checked) {
    els.nextRun.textContent = 'Digest is off.';
    return;
  }
  const time = parseTimeOfDay(els.digestTime.value) || parseTimeOfDay(DEFAULTS.digestTime);
  els.nextRun.textContent = `Next digest: ${new Date(nextOccurrence(time)).toLocaleString()}`;
}

async function load() {
  const settings = await getSettings();
  for (const input of engineInputs()) input.checked = input.value === settings.engine;
  els.apiKey.value = settings.apiKey;
  els.model.value = settings.model;
  els.scope.value = settings.scope;
  els.ignorePinned.checked = settings.ignorePinned;
  els.readPageText.checked = settings.readPageText && (await chrome.permissions.contains(ALL_URLS));
  els.wakeSleepingTabs.checked = settings.wakeSleepingTabs;
  els.reviveFrozenTabs.checked = settings.reviveFrozenTabs;
  els.wpm.value = settings.wpm;
  els.digestEnabled.checked = settings.digestEnabled;
  els.digestTime.value = settings.digestTime;
  els.digestDelivery.value = settings.digestDelivery;
  syncEngineVisibility();
  showNextRun();
  markClean();
}

/** Status text belongs next to the control that produced it, not in one shared slot. */
function setStatus(target, message, tone = 'muted') {
  target.textContent = message;
  target.style.color = tone === 'error' ? 'var(--accent)' : '';
}

const status = (message, tone) => setStatus(els.saveStatus, message, tone);
const digestStatus = (message, tone) => setStatus(els.digestStatus, message, tone);

/**
 * Permission requests must happen inside a user gesture, so they are wired to
 * the checkbox and the radio directly rather than deferred to Save.
 */
els.readPageText.addEventListener('change', async () => {
  if (!els.readPageText.checked) {
    // Actually hand the permission back, and verify Chrome took it.
    await chrome.permissions.remove(ALL_URLS);
    const stillGranted = await chrome.permissions.contains(ALL_URLS);
    els.readPageText.checked = stillGranted;
    await saveSettings({ readPageText: stillGranted });
    markFieldClean('readPageText');
    status(
      stillGranted
        ? 'Chrome did not release the permission. Remove it under chrome://extensions → Details → Site access.'
        : 'Page reading off. Access to your pages has been revoked.',
      stillGranted ? 'error' : 'muted',
    );
    return;
  }

  const granted = await chrome.permissions.request(ALL_URLS);
  els.readPageText.checked = granted;
  await saveSettings({ readPageText: granted });
  markFieldClean('readPageText');
  status(
    granted ? 'Page reading enabled.' : 'Permission declined — staying with URL-only estimates.',
    granted ? 'muted' : 'error',
  );
});

for (const input of engineInputs()) {
  input.addEventListener('change', async () => {
    syncEngineVisibility();
    if (input.value !== 'claude' || !input.checked) return;
    const granted = await chrome.permissions.request(API_ORIGIN);
    if (!granted) {
      engineInputs().find((i) => i.value === 'local').checked = true;
      syncEngineVisibility();
      status('Access to api.anthropic.com is required for the Claude estimator.', 'error');
    }
  });
}

for (const event of ['input', 'change']) {
  document.addEventListener(event, showDirtyState, true);
}

els.digestEnabled.addEventListener('change', showNextRun);
els.digestTime.addEventListener('change', showNextRun);

/**
 * Validate and persist the form.
 * @returns {Promise<boolean>} false if the form was rejected, with status already set.
 */
async function persist() {
  const time = parseTimeOfDay(els.digestTime.value);
  if (els.digestEnabled.checked && !time) {
    status('That digest time is not valid.', 'error');
    return false;
  }
  const engine = selectedEngine();
  if (engine === 'claude' && !els.apiKey.value.trim()) {
    status('Add an API key, or switch back to local heuristics.', 'error');
    return false;
  }

  await saveSettings({
    engine,
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim() || DEFAULTS.model,
    scope: els.scope.value,
    ignorePinned: els.ignorePinned.checked,
    readPageText: els.readPageText.checked,
    wakeSleepingTabs: els.wakeSleepingTabs.checked,
    reviveFrozenTabs: els.reviveFrozenTabs.checked,
    wpm: Number(els.wpm.value) || DEFAULTS.wpm,
    digestEnabled: els.digestEnabled.checked,
    digestTime: els.digestTime.value || DEFAULTS.digestTime,
    digestDelivery: els.digestDelivery.value,
  });
  // The settings ARE saved once storage resolves. Everything after this is a
  // side effect, so clear the indicator here rather than behind a message
  // round-trip to a service worker that may be asleep — a hung reschedule must
  // not leave the form looking unsaved when it is not.
  markClean();
  showNextRun();

  /*
   * Rescheduling the alarm is a side effect of saving, not part of it, and the
   * next-run time is computed here from the form rather than reported by the
   * worker. So do not make the user wait on a message round-trip: a sleeping
   * service worker would otherwise leave Save stuck on "Saving…" long after the
   * settings were safely stored.
   */
  send({ type: 'rescheduleDigest' }, { timeoutMs: 15000 }).then((res) => {
    if (!res.ok) {
      status(`Saved, but the digest alarm was not rescheduled: ${res.error}`, 'error');
    }
  });

  return true;
}

els.save.addEventListener(
  'click',
  guard(els.save, 'Saving…', async () => {
    try {
      if (await persist()) status('Saved.');
    } catch (error) {
      // Without this the rejection is unhandled and the page just sits there
      // still showing unsaved changes with no explanation.
      console.error('[tab-triage] save failed', error);
      status(`Could not save: ${error && error.message ? error.message : error}`, 'error');
    }
  }),
);

els.clearCache.addEventListener(
  'click',
  guard(els.clearCache, 'Clearing…', async () => {
    const res = await send({ type: 'clearContentCache' });
    setStatus(
      els.cacheStatus,
      res.ok ? 'Cleared. The next summary will read every page again.' : res.error,
      res.ok ? 'muted' : 'error',
    );
  }),
);

els.testDigest.addEventListener(
  'click',
  guard(els.testDigest, 'Building…', async () => {
    digestStatus('Building a digest…');
    if (!(await persist())) {
      digestStatus('Fix the settings above first.', 'error');
      return;
    }
    const res = await send({ type: 'runDigestNow' });
    digestStatus(res.ok ? res.detail : res.error || res.detail, res.ok ? 'muted' : 'error');
  }),
);

load();
