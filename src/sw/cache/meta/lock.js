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
 * Uses navigator.locks.request with ifAvailable: true across worker instances by default,
 * or queues/waits when { wait: true } is specified for critical operations (e.g. rollbacks).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {T|(() => T)} [fallback=false]
 * @param {{ wait?: boolean, timeoutMs?: number }} [options={}]
 * @returns {Promise<T>}
 */
export async function withLock(fn, fallback = false, { wait = false, timeoutMs = 5000 } = {}) {
  const getFallback = () => (typeof fallback === 'function' ? fallback() : fallback);

  const nav = typeof navigator !== 'undefined'
    ? navigator
    : typeof self !== 'undefined'
      ? self.navigator
      : null;

  if (nav?.locks?.request && typeof nav.locks.request === 'function') {
    let ran = false;
    const lockOptions = wait ? {} : { ifAvailable: true };
    try {
      return await nav.locks.request('nlpwa-operation-lock', lockOptions, async (lock) => {
        if (!lock && !wait) return getFallback();
        if (wait) {
          const startWait = Date.now();
          while (!tryAcquire()) {
            if (Date.now() - startWait > timeoutMs) return getFallback();
            await new Promise((r) => setTimeout(r, 20));
          }
        } else {
          if (!tryAcquire()) return getFallback();
        }
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

  if (wait) {
    const startWait = Date.now();
    while (!tryAcquire()) {
      if (Date.now() - startWait > timeoutMs) return getFallback();
      await new Promise((r) => setTimeout(r, 20));
    }
  } else {
    if (!tryAcquire()) return getFallback();
  }

  try {
    return await fn();
  } finally {
    release();
  }
}
