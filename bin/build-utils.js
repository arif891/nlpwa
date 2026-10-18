import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/**
 * Increment semver patch version helper (x.y.z -> x.y.(z+1)).
 *
 * @param {string} version
 * @returns {string}
 */
export function incrementPatch(version) {
  const base = String(version || '1.0.0').split('-')[0];
  const parts = base.split('.').map(s => parseInt(s, 10) || 0);
  return `${parts[0] ?? 0}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`;
}

function canonicalizeConfig(obj) {
  if (obj === null || typeof obj !== 'object') {
    if (typeof obj === 'function') return obj.toString();
    return obj;
  }
  if (obj instanceof RegExp) {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalizeConfig);
  }
  const sorted = {};
  const keys = Object.keys(obj).filter((k) => k !== 'version').sort();
  for (const k of keys) {
    sorted[k] = canonicalizeConfig(obj[k]);
  }
  return sorted;
}

/**
 * Compute a deterministic composite hash for tracked offline files and configuration rules.
 * Excludes any existing version and the config.json file itself to prevent circular hash dependencies.
 *
 * @param {Array<{ path: string, hash: string }>} files
 * @param {Object} [config]
 * @returns {string} 12-character hex hash
 */
export function computeManifestHash(files = [], config = {}) {
  const configPath = config?.configPath || '/config.json';

  // 1. Sort tracked files by path (excluding config.json)
  const sortedFiles = files
    .filter((f) => f.path !== configPath)
    .sort((a, b) => a.path.localeCompare(b.path));

  // 2. Canonicalize the entire config object excluding only the version field
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
 * Behavior:
 * - If explicitVersion is given (e.g. from CLI --version or plugin options.version), use it directly.
 * - If rawConfig.version is specified (e.g. '1.0.0'):
 *   Extract the semver base (stripping any existing hash suffix), and format as `${baseVersion}-${manifestHash}`.
 * - If rawConfig.version is 'auto' or omitted:
 *   Format as `${manifestHash}`.
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

  // If base already contains a hyphenated hash suffix (e.g. '1.0.0-a1b2c3d4e5f6'), strip the suffix
  const cleanBase = base.includes('-') && /^[0-9a-f]{8,32}$/i.test(base.split('-').pop())
    ? base.slice(0, base.lastIndexOf('-'))
    : base;

  return `${cleanBase}-${manifestHash}`;
}

/**
 * Locate developer configuration file.
 *
 * @param {string} [explicitPath]
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function findConfigFile(explicitPath, cwd = process.cwd()) {
  if (explicitPath) {
    const resolved = resolve(cwd, explicitPath);
    if (existsSync(resolved)) return resolved;
    return null;
  }

  const candidates = [
    './config.js',
    './nlpwa.config.js',
    './src/config.js',
    './config.json',
    './nlpwa.config.json',
  ];

  for (const candidate of candidates) {
    const resolved = resolve(cwd, candidate);
    if (existsSync(resolved)) return resolved;
  }

  return null;
}

/**
 * Load configuration from a JS or JSON file.
 *
 * @param {string|null} configPath
 * @returns {Promise<Object>}
 */
export async function loadConfig(configPath) {
  if (!configPath) return {};

  if (configPath.endsWith('.json')) {
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  }

  const fileUrl = pathToFileURL(configPath).href;
  const mod = await import(`${fileUrl}?t=${Date.now()}`);
  return mod.default ?? mod;
}

/**
 * Update version string inside config.js or config.json source file.
 * Uses a line-anchored regex to prevent matching `version:` inside comments or docstrings.
 *
 * @param {string} configPath
 * @param {string} newVersion
 */
export function syncSourceConfigVersion(configPath, newVersion) {
  if (!configPath || !existsSync(configPath) || !newVersion) return;

  try {
    const content = readFileSync(configPath, 'utf8');
    if (configPath.endsWith('.json')) {
      const parsed = JSON.parse(content);
      parsed.version = newVersion;
      writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
    } else {
      // Match top-level version property only:
      // 1. Indented by 1-4 spaces or 1 tab (direct child of config object), not deeply nested
      // 2. Value must NOT start with '/' or 'http' (prevents overwriting updateAPI.version or other endpoint URLs)
      const updated = content.replace(
        /^([ \t]{1,4}['"]?version['"]?\s*:\s*['"])(?!\/|https?:\/\/)([^'"]+)(['"])/m,
        `$1${newVersion}$3`
      );
      if (updated !== content) {
        writeFileSync(configPath, updated, 'utf8');
      }
    }
  } catch {
    // Ignore write failure in read-only environment
  }
}

/**
 * Resolve version and info API endpoint paths from runtime config.
 *
 * @param {Object} runtimeConfig
 * @returns {{ versionEndpoint: string, infoEndpoint: string }}
 */
export function resolveUpdateEndpoints(runtimeConfig = {}) {
  let versionEndpoint = '/api/update/version.json';
  let infoEndpoint = '/api/update/info.json';

  if (runtimeConfig.updateAPI) {
    if (typeof runtimeConfig.updateAPI === 'object' && !Array.isArray(runtimeConfig.updateAPI)) {
      versionEndpoint = runtimeConfig.updateAPI.version || versionEndpoint;
      infoEndpoint = runtimeConfig.updateAPI.info || infoEndpoint;
    } else if (Array.isArray(runtimeConfig.updateAPI)) {
      const v = runtimeConfig.updateAPI.find(e => e.type === 'version');
      const i = runtimeConfig.updateAPI.find(e => e.type === 'info');
      if (v?.endpoint) versionEndpoint = v.endpoint;
      if (i?.endpoint) infoEndpoint = i.endpoint;
    }
  }

  return { versionEndpoint, infoEndpoint };
}

/**
 * Resolve disk path for an API endpoint.
 *
 * @param {string} baseDir
 * @param {string} endpoint
 * @returns {string}
 */
export function getApiDiskPath(baseDir, endpoint) {
  let clean = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  if (clean.endsWith('.json')) {
    return resolve(baseDir, clean);
  }
  return resolve(baseDir, clean, 'index.json');
}

function globToRegex(pattern) {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\/\*\*\//g, '\x00GLOBSTARSLASH\x00')
    .replace(/\*\*/g, '\x00GLOBSTAR\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x00GLOBSTARSLASH\x00/g, '/(?:.*/)?')
    .replace(/\x00GLOBSTAR\x00/g, '.*');
  return new RegExp('^' + regexStr + '$');
}

function matchGlob(pattern, path) {
  return globToRegex(pattern).test(path);
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
 * Supports glob patterns in precache (e.g. '/assets/icons/**', '/img/*.png').
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
  const configPath = runtimeConfig.configPath || '/config.json';
  const trackedUrlPaths = Array.from(new Set([
    configPath,
    ...(runtimeConfig.precache || []),
  ]));

  const filesMap = new Map();
  const missing = [];
  let allDiskFiles = null;

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
            filesMap.set(fileUrlPath, {
              path: fileUrlPath,
              hash: hashFile(diskFile),
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
        filesMap.set(urlPath, { path: urlPath, hash: hashFile(diskPath) });
      } else {
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
