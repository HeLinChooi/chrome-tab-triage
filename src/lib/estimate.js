/** Engine router: one entry point, two interchangeable estimators. */

import { estimateAll as local } from './estimator-local.js';
import { estimateAll as claude } from './estimator-claude.js';

export async function estimate(tabs, settings, opts = {}) {
  if (settings.engine === 'claude') return claude(tabs, { ...settings, token: opts.token });
  const result = await local(tabs, settings);
  // The local engine makes no network calls, so there is no transcript to show.
  return { ...result, warnings: result.warnings || [], transcript: null };
}
