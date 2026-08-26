/** Small async utilities shared by the collector and the Claude estimator. */

/** Thrown when a run is cancelled by the user. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

/**
 * A cancellation token. Deliberately simpler than AbortSignal: the work being
 * cancelled here is Chrome API calls that take no signal, so all a token can do
 * is be checked between steps.
 */
export function createCancelToken() {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    get cancelled() {
      return cancelled;
    },
    throwIfCancelled() {
      if (cancelled) throw new CancelledError();
    },
  };
}

/**
 * Resolve to `fallback` if `promise` has not settled within `ms`.
 *
 * The underlying work is not aborted — it cannot be — so this bounds how long we
 * are willing to *wait*, which is what matters when one hung renderer would
 * otherwise stall a whole run.
 */
export function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Run async jobs with a fixed ceiling on parallelism, preserving input order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
