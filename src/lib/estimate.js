/** Engine router: one entry point, two interchangeable estimators. */

import { estimateAll as local } from './estimator-local.js';
import { estimateAll as claude } from './estimator-claude.js';

export async function estimate(tabs, settings) {
  if (settings.engine === 'claude') return claude(tabs, settings);
  const result = await local(tabs, settings);
  return { ...result, warnings: result.warnings || [] };
}
