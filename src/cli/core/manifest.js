import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { matchGlob } from '../../shared/glob.js';

/**
 * SHA-256 first 32 hex characters (128 bits).
 *
 * @param {string} filePath
 * @returns {string}
 */
export function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

export function canonicalizeConfig(obj, depth = 0) {
  if (obj === null || typeof obj !== 'object') {
    if (typeof obj === 'function') return obj.toString();
    return obj;
  }
  if (obj instanceof RegExp) {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => canonicalizeConfig(item, depth + 1));
  }
  const sorted = {};
  const keys = Object.keys(obj)
    .filter((k) => (depth > 0 || k !== 'version') && k !== 'plugins')
    .sort();
  for (const k of keys) {
    sorted[k] = canonicalizeConfig(obj[k], depth + 1);
  }
  return sorted;
}

/**
 * Compute a deterministic composite hash for tracked offline files and configuration rules.
 *
 * @param {Array<{ path: string, hash: string }>} files
 * @param {Object} [config]
 * @returns {string} 12-character hex hash
 */
export function computeManifestHash(files = [], config = {}) {
  const configPath = config?.configPath || '/api/update/config.json';

  const sortedFiles = files
    .filter((f) => f.path !== configPath)
    .sort((a, b) => a.path.localeCompare(b.path));

  const canonicalConfig = canonicalizeConfig(config);

  const hasher = createHash('sha256');
  for (const f of sortedFiles) {
    hasher.update(`${f.path}:${f.hash}\n`);
  }
  hasher.update(JSON.stringify(canonicalConfig));
  return hasher.digest('hex').slice(0, 12);
}

/**
 * Derive an application version string deterministically.
 *
 * @param {Object} rawConfig
 * @param {Array<{ path: string, hash: string }>} files
 * @param {string} [explicitVersion]
 * @returns {string}
 */
export function deriveAppVersion(rawConfig = {}, files = [], explicitVersion) {
  if (explicitVersion) return explicitVersion;

  const manifestHash = computeManifestHash(files, rawConfig);
  const base = rawConfig.version;

  if (!base || base === 'auto') {
    return manifestHash;
  }

  const cleanBase = base.includes('-') && /^[0-9a-f]{8,32}$/i.test(base.split('-').pop())
    ? base.slice(0, base.lastIndexOf('-'))
    : base;

  return `${cleanBase}-${manifestHash}`;
}

/**
 * Resolve disk path for an API endpoint.
 *
 * @param {string} baseDir
 * @param {string} endpoint
 * @param {string} [base]
 * @returns {string}
 */
export function getApiDiskPath(baseDir, endpoint, base = '') {
  let clean = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  if (base) {
    const cleanBase = base.replace(/^\/+|\/+$/g, '');
    if (cleanBase && (clean === cleanBase || clean.startsWith(cleanBase + '/'))) {
      clean = clean.slice(cleanBase.length).replace(/^\/+/, '');
    }
  }
  if (clean.endsWith('.json')) {
    return resolve(baseDir, clean);
  }
  return resolve(baseDir, clean, 'index.json');
}

function walkFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkFiles(full));
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  } catch {
    // ignore unreadable directories
  }
  return files;
}

/**
 * Collect and hash all tracked offline files for a given target directory.
 *
 * @param {Object} runtimeConfig
 * @param {string} targetDir
 * @returns {{
 *   files: Array<{ path: string, hash: string }>,
 *   missing: Array<{ path: string, diskPath: string }>,
 *   expandedPrecache: string[]
 * }}
 */
export function collectTrackedFiles(runtimeConfig, targetDir) {
  const configPath = runtimeConfig.configPath || '/api/update/config.json';
  const trackedUrlPaths = Array.from(new Set([
    configPath,
    ...(runtimeConfig.precache || []),
  ]));

  const filesMap = new Map();
  const missing = [];
  let allDiskFiles = null;

  const maxVerifyBytes = runtimeConfig.maxVerifyBytes ?? (25 * 1024 * 1024);
  const skipVerifyGlobs = Array.isArray(runtimeConfig.skipVerifyGlobs) ? runtimeConfig.skipVerifyGlobs : [];

  const shouldSkipVerify = (fileUrl, fileSize) => {
    if (maxVerifyBytes > 0 && fileSize > maxVerifyBytes) return true;
    return skipVerifyGlobs.some((g) => matchGlob(g.startsWith('/') ? g : '/' + g, fileUrl));
  };

  for (const urlPath of trackedUrlPaths) {
    if (typeof urlPath !== 'string') continue;
    const isGlob = urlPath.includes('*') || urlPath.includes('?');

    if (isGlob) {
      if (allDiskFiles === null) {
        allDiskFiles = walkFiles(targetDir);
      }
      const normPattern = urlPath.startsWith('/') ? urlPath : '/' + urlPath;
      let matchedCount = 0;

      for (const diskFile of allDiskFiles) {
        const rel = relative(targetDir, diskFile).split(sep).join('/');
        const fileUrlPath = '/' + rel;

        if (matchGlob(normPattern, fileUrlPath)) {
          matchedCount++;
          if (!filesMap.has(fileUrlPath)) {
            const fileSize = statSync(diskFile).size;
            const skipVerify = shouldSkipVerify(fileUrlPath, fileSize);
            filesMap.set(fileUrlPath, {
              path: fileUrlPath,
              hash: hashFile(diskFile),
              size: fileSize,
              ...(skipVerify ? { skipVerify: true } : {}),
            });
          }
        }
      }

      if (matchedCount === 0) {
        missing.push({
          path: urlPath,
          diskPath: resolve(targetDir, urlPath.replace(/^\/+/, '')),
        });
      }
    } else {
      let relPath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
      if (relPath === '' || relPath.endsWith('/')) {
        relPath += 'index.html';
      }

      const diskPath = resolve(targetDir, relPath);
      if (existsSync(diskPath)) {
        const fileSize = statSync(diskPath).size;
        const skipVerify = shouldSkipVerify(urlPath, fileSize);
        filesMap.set(urlPath, {
          path: urlPath,
          hash: hashFile(diskPath),
          size: fileSize,
          ...(skipVerify ? { skipVerify: true } : {}),
        });
      } else if (urlPath !== configPath) {
        missing.push({ path: urlPath, diskPath });
      }
    }
  }

  const files = Array.from(filesMap.values());
  const expandedPrecache = files
    .map((f) => f.path)
    .filter((p) => p !== configPath);

  return { files, missing, expandedPrecache };
}
