let _busy = false;

export function tryAcquire() {
  if (_busy) return false;
  _busy = true;
  return true;
}

export function release() {
  _busy = false;
}

export function resetLockState() {
  _busy = false;
}

/**
 * Execute an operation under the NLPWA operation lock.
 * Uses navigator.locks.request with ifAvailable: true across worker instances,
 * falling back to tryAcquire / release in memory.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {T|(() => T)} [fallback=false]
 * @returns {Promise<T>}
 */
export async function withLock(fn, fallback = false) {
  const getFallback = () => (typeof fallback === 'function' ? fallback() : fallback);

  const nav = typeof navigator !== 'undefined'
    ? navigator
    : typeof self !== 'undefined'
      ? self.navigator
      : null;

  if (nav?.locks?.request && typeof nav.locks.request === 'function') {
    let ran = false;
    try {
      return await nav.locks.request('nlpwa-operation-lock', { ifAvailable: true }, async (lock) => {
        if (!lock) return getFallback();
        if (!tryAcquire()) return getFallback();
        ran = true;
        try {
          return await fn();
        } finally {
          release();
        }
      });
    } catch (err) {
      if (ran) {
        throw err;
      }
      // Fall through to in-memory locking only if Web Locks API itself threw or is unsupported
    }
  }

  if (!tryAcquire()) return getFallback();
  try {
    return await fn();
  } finally {
    release();
  }
}
