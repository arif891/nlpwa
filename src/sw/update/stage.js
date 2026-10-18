import { getConfig } from '../config/index.js';
import { openActive, getStaged, setStaged } from '../cache/store.js';
import { computeDiff, isSafePath } from './diff.js';
import { writeSnapshot } from './manifest.js';
import { sha256Hex, hashMatches } from '../../shared/hash.js';
import { MAX_RETRY_ATTEMPTS, FETCH_CONCURRENCY } from '../../shared/constants.js';

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** Is `path` already in the staging cache with the expected content? */
async function isAlreadyStaged(cache, path, expected, verify) {
  const hit = await cache.match(path);
  if (!hit) return false;
  if (!expected || verify === false) return true;
  return hashMatches(await sha256Hex(await hit.arrayBuffer()), expected);
}

/** Fetch a file fresh from the network and check it against its manifest hash. */
async function fetchVerified(path, expected, verify) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(30000)
    : undefined;
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  if (expected && verify !== false) {
    const actual = await sha256Hex(await response.clone().arrayBuffer());
    if (!hashMatches(actual, expected)) {
      const detail = `hash mismatch (expected ${expected}, got ${actual.slice(0, expected.length)})`;
      if (verify === 'strict') throw new Error(detail);
      console.warn(`[NLPWA] ${path}: ${detail} - storing anyway (verifyHashes: 'warn')`);
    }
  }
  return response;
}

/**
 * Build the new app version in a SEPARATE cache while the active one keeps
 * serving. Nothing here is visible to the running app until commitStaged().
 *
 * For every file in the manifest:
 *   1. already in the staging cache and verified  → reuse   (resume after failure)
 *   2. unchanged since the active version         → copy locally, no network
 *   3. otherwise                                  → fetch (no-store) and verify hash
 *
 * The snapshot is written last: a staging cache that contains its snapshot is
 * complete. If any file fails to download or verify, the update is never
 * finalized or committed (strict atomicity). Verified files are preserved in the
 * staging cache so subsequent checks can resume, entering exponential backoff
 * after MAX_RETRY_ATTEMPTS while the running app stays 100% untouched.
 *
 * @param {{ version: string, files: Array<{ path: string, hash: string }> }} manifest
 * @param {{ activeSnapshot?: Object|null, forceRefetch?: boolean }} [opts]
 *        forceRefetch: ignore the active copies and download everything (SW engine change)
 * @returns {Promise<
 *   { status: 'ready', partial: boolean, failed: string[], reused: number, copied: number, fetched: number } |
 *   { status: 'incomplete', failed: string[], retryCount: number }
 * >}
 */
export async function stageUpdate(manifest, { activeSnapshot = null, forceRefetch = false } = {}) {
  const config = getConfig();
  const verify = config.verifyHashes ?? 'strict';
  const files = manifest.files.filter((f) => isSafePath(f?.path));

  const diff = computeDiff(files, activeSnapshot?.files ?? null);
  const evict = [...diff.modified, ...diff.removed];

  // ── Resume a matching partial staging cache, or start a new one ──────────
  let staged = await getStaged();
  const resumable = staged && !staged.complete
    && staged.version === manifest.version && staged.swVersion === config.version;
  if (!resumable) {
    if (staged?.cache) await caches.delete(staged.cache);
    staged = {
      cache: `${config.caches.offline}@${manifest.version}-${Date.now().toString(36)}`,
      version: manifest.version,
      swVersion: config.version,
      complete: false,
      retryCount: 0,
    };
  }
  // Record the staging cache BEFORE creating it so a crash can never orphan it
  await setStaged(staged);

  const next = await caches.open(staged.cache);
  const activeCache = activeSnapshot ? await openActive(config.caches.offline) : null;
  const activeHashes = new Map((activeSnapshot?.files ?? []).map((f) => [f.path, f.hash]));
  const activeDegraded = new Set(activeSnapshot?.degraded ?? []);

  const stats = { reused: 0, copied: 0, fetched: 0 };
  const failed = [];

  await mapLimit(files, FETCH_CONCURRENCY, async ({ path, hash }) => {
    try {
      if (await isAlreadyStaged(next, path, hash, verify)) {
        stats.reused++;
        return;
      }
      if (!forceRefetch && !activeDegraded.has(path) && activeCache && hash && activeHashes.get(path) === hash) {
        const hit = await activeCache.match(path);
        if (hit) {
          await next.put(path, hit);
          stats.copied++;
          return;
        }
      }
      await next.put(path, await fetchVerified(path, hash, verify));
      stats.fetched++;
    } catch (err) {
      failed.push(path);
      console.warn(`[NLPWA] Staging failed: ${path} - ${err.message}`);
    }
  });

  const retryCount = failed.length ? staged.retryCount + 1 : 0;

  if (failed.length > 0) {
    // True all-or-nothing atomicity: never finalize or commit a partial or broken update.
    // Keep verified files in the staging cache so subsequent checks can resume.
    // Active cache remains 100% pure and untouched.
    let nextRetryAt = null;
    if (retryCount >= MAX_RETRY_ATTEMPTS) {
      const backoffMs = Math.min(60000 * Math.pow(2, Math.min(retryCount - MAX_RETRY_ATTEMPTS, 6)), 3600000);
      nextRetryAt = Date.now() + backoffMs;
      console.warn(
        `[NLPWA] Staging incomplete: ${failed.length} file(s) failed after ${retryCount} attempts: ` +
        `${failed.join(', ')}. Active version remains live.`
      );
    }

    await setStaged({
      ...staged,
      retryCount,
      failedFiles: failed,
      nextRetryAt,
      complete: false,
    });

    return { status: 'incomplete', failed, retryCount };
  }

  // ── Finalise: snapshot last, then mark the staged record complete ────────
  await writeSnapshot(next, {
    version: manifest.version,
    files,
  });

  await setStaged({
    ...staged,
    retryCount: 0,
    complete: true,
    partial: false,
    evict,
    clearRuntime: forceRefetch,
  });

  console.log(
    `[NLPWA] Staged v${manifest.version}: ${stats.fetched} fetched, ${stats.copied} copied, ` +
    `${stats.reused} reused`
  );

  return { status: 'ready', partial: false, failed: [], ...stats };
}
