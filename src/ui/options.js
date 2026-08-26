import { getSettings, saveSettings, parseTimeOfDay, nextOccurrence, DEFAULTS } from '../lib/settings.js';
import { ALL_URLS } from '../lib/collect.js';
import { send, guard } from './shared.js';

const API_ORIGIN = { origins: ['https://api.anthropic.com/*'] };

const els = {};
for (const id of [
  'apiKey', 'model', 'scope', 'ignorePinned', 'readPageText', 'wakeSleepingTabs', 'wpm',
  'digestEnabled', 'digestTime', 'digestDelivery', 'save', 'saveStatus', 'digestStatus',
  'nextRun', 'testDigest', 'clearCache', 'cacheStatus',
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
  els.wpm.value = settings.wpm;
  els.digestEnabled.checked = settings.digestEnabled;
  els.digestTime.value = settings.digestTime;
  els.digestDelivery.value = settings.digestDelivery;
  syncEngineVisibility();
  showNextRun();
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
    wpm: Number(els.wpm.value) || DEFAULTS.wpm,
    digestEnabled: els.digestEnabled.checked,
    digestTime: els.digestTime.value || DEFAULTS.digestTime,
    digestDelivery: els.digestDelivery.value,
  });
  await send({ type: 'rescheduleDigest' });
  showNextRun();
  return true;
}

els.save.addEventListener(
  'click',
  guard(els.save, 'Saving…', async () => {
    if (await persist()) status('Saved.');
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
