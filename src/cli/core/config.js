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
