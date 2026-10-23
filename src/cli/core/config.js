import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Resolve project version from package.json in current working directory.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {string|null}
 */
export function resolvePackageVersion(cwd = process.cwd()) {
  try {
    const pkgPath = resolve(cwd, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Locate developer configuration file.
 *
 * @param {string} [explicitPath]
 * @param {string} [cwd=process.cwd()]
 * @param {string[]|string} [fallbackDirs=[]]
 * @returns {string|null}
 */
export function findConfigFile(explicitPath, cwd = process.cwd(), fallbackDirs = []) {
  const dirs = [cwd];
  if (Array.isArray(fallbackDirs)) {
    for (const d of fallbackDirs) {
      if (d && !dirs.includes(d)) dirs.push(d);
    }
  } else if (fallbackDirs && !dirs.includes(fallbackDirs)) {
    dirs.push(fallbackDirs);
  }

  if (explicitPath) {
    for (const dir of dirs) {
      const resolved = resolve(dir, explicitPath);
      if (existsSync(resolved)) return resolved;
    }
    return null;
  }

  const candidates = [
    './nlpwa.config.js',
    './nlpwa.config.mjs',
    './nlpwa.config.json',
    './config.js',
    './src/config.js',
    './config.json',
  ];

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const resolved = resolve(dir, candidate);
      if (existsSync(resolved)) return resolved;
    }
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
 * Update publicKey in nlpwa.config.js, nlpwa.config.mjs, or nlpwa.config.json.
 *
 * @param {string} configPath
 * @param {string} publicKey
 * @returns {boolean} True if successfully written, false otherwise
 */
export function syncSourceConfigPublicKey(configPath, publicKey) {
  if (!configPath || !existsSync(configPath) || !publicKey) return false;

  try {
    const content = readFileSync(configPath, 'utf8');
    if (configPath.endsWith('.json')) {
      const parsed = JSON.parse(content);
      parsed.publicKey = publicKey;
      if (parsed.verifyHashes === undefined) {
        parsed.verifyHashes = 'strict';
      }
      writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
      return true;
    }

    let updated = content;
    if (/['"]?publicKey['"]?\s*:\s*['"][^'"]*['"]/m.test(updated)) {
      updated = updated.replace(
        /(['"]?publicKey['"]?\s*:\s*['"])([^'"]+)(['"])/m,
        `$1${publicKey}$3`
      );
    } else {
      // Support export default {, module.exports = {, or const/let/var config = {
      const insertRegex = /(export\s+default\s*\{|module\.exports\s*=\s*\{|(?:const|let|var)\s+\w+\s*=\s*\{)/m;
      if (insertRegex.test(updated)) {
        // Only set verifyHashes: 'strict' if not already configured by developer
        const hasVerifyHashes = /['"]?verifyHashes['"]?\s*:/m.test(updated);
        const fieldsToAdd = hasVerifyHashes
          ? `  publicKey: '${publicKey}',`
          : `  publicKey: '${publicKey}',\n  verifyHashes: 'strict',`;
        updated = updated.replace(insertRegex, `$1\n${fieldsToAdd}`);
      }
    }

    if (updated !== content) {
      writeFileSync(configPath, updated, 'utf8');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}


/**
 * Injects or updates `self.__NLPWA_PUBLIC_KEY = '...'` in a service worker file.
 *
 * @param {string} swPath
 * @param {string} publicKey
 * @returns {boolean} True if successfully injected or updated
 */
export function injectPublicKeyToSwFile(swPath, publicKey) {
  if (!swPath || !existsSync(swPath) || !publicKey) return false;

  try {
    const content = readFileSync(swPath, 'utf8');
    const keyAssignment = `self.__NLPWA_PUBLIC_KEY = '${publicKey}';\n`;
    const regex = /^self\.__NLPWA_PUBLIC_KEY\s*=\s*['"][^'"]*['"];?\r?\n?/m;

    let updated;
    if (regex.test(content)) {
      updated = content.replace(regex, keyAssignment);
    } else {
      updated = keyAssignment + content;
    }

    if (updated !== content) {
      writeFileSync(swPath, updated, 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronize public key to an array of service worker candidate paths.
 *
 * @param {string[]} candidates
 * @param {string} publicKey
 * @returns {string[]} List of modified sw file paths
 */
export function syncPublicKeyToSwFiles(candidates, publicKey) {
  if (!Array.isArray(candidates) || !publicKey) return [];
  const modified = [];
  const seen = new Set();

  for (const swPath of candidates) {
    if (!swPath || seen.has(swPath)) continue;
    seen.add(swPath);
    if (existsSync(swPath)) {
      const ok = injectPublicKeyToSwFile(swPath, publicKey);
      if (ok) modified.push(swPath);
    }
  }

  return modified;
}

