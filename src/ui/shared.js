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
