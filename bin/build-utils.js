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
  if (!configPath || !existsSync(configPath)) return;

  try {
    const content = readFileSync(configPath, 'utf8');
    if (configPath.endsWith('.json')) {
      const parsed = JSON.parse(content);
      parsed.version = newVersion;
      writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
    } else {
      // Anchored to property line to avoid matching in comments or docstrings
      const updated = content.replace(/^([ \t]*['"]?version['"]?\s*:\s*['"])([^'"]+)(['"])/m, `$1${newVersion}$3`);
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
