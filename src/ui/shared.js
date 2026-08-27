/** Helpers shared by the popup, dashboard, and options pages. */

/** Promise wrapper over chrome.runtime.sendMessage that never rejects. */
export function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response from the extension worker.' });
    });
  });
}

export function renderWarnings(container, warnings) {
  container.innerHTML = '';
  for (const warning of warnings || []) {
    const el = document.createElement('div');
    el.className = 'notice';
    el.textContent = warning;
    container.appendChild(el);
  }
}

/**
 * Wrap an async click handler so the control cannot be re-entered.
 *
 * Disabling inside the handler is not enough on its own: a fast double-click can
 * queue a second event before the first handler runs, so the in-flight flag is
 * what actually prevents a duplicate run.
 */
export function guard(button, busyLabel, handler) {
  let running = false;
  const idleLabel = button.textContent;
  return async () => {
    if (running) return;
    running = true;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyLabel) button.textContent = busyLabel;
    try {
      await handler();
    } finally {
      running = false;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = idleLabel;
    }
  };
}

/** True when a failure is the worker dying mid-request rather than a real error. */
export function isChannelClosed(result) {
  return Boolean(
    result &&
      !result.ok &&
      typeof result.error === 'string' &&
      /message channel closed|message port closed|Receiving end does not exist/i.test(result.error),
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask for an analysis, surviving a service-worker restart.
 *
 * MV3 can tear down the worker mid-run, which closes the message channel before
 * a response arrives. The run itself usually completes and stores its report, so
 * rather than reporting a failure the caller cannot act on, wait for the run to
 * finish and pick the result up from storage.
 */
export async function requestAnalysis({ timeoutMs = 180000 } = {}) {
  const result = await send({ type: 'analyze' });
  if (!isChannelClosed(result)) return result;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const status = await send({ type: 'runStatus' });
    if (status.ok && !status.running) break;
  }

  const last = await send({ type: 'lastReport' });
  if (last.ok && last.report) return { ok: true, report: last.report, recovered: true };
  return {
    ok: false,
    error: 'The extension worker restarted during the run and no summary was stored. Try again.',
  };
}

/** Categorical slots, assigned in fixed order. Beyond these, sites fold into "Other". */
export const SERIES_SLOTS = 6;

export const seriesColor = (i) =>
  i < SERIES_SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)';

/**
 * Fold a report's site groups into at most SERIES_SLOTS named segments plus one
 * "Other", so the stacked bar reads the same way on every surface.
 *
 * Segments narrower than a couple of pixels are unreadable, so the tail is
 * summarized rather than drawn.
 */
export function budgetSegments(report, slots = SERIES_SLOTS) {
  const named = report.groups.slice(0, slots);
  const rest = report.groups.slice(slots);

  const segments = named.map((group, i) => ({
    name: group.name,
    minutes: group.minutes,
    count: group.count,
    breakdown: group.breakdown,
    color: seriesColor(i),
  }));

  if (rest.length) {
    segments.push({
      name: `${rest.length} other sites`,
      minutes: Math.round(rest.reduce((sum, g) => sum + g.minutes, 0) * 10) / 10,
      count: rest.reduce((sum, g) => sum + g.count, 0),
      breakdown: [],
      color: 'var(--series-other)',
    });
  }
  return segments.filter((s) => s.minutes > 0);
}
