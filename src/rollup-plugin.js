import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { incrementPatch } from './shared/version.js';

/**
 * SHA-256 first 32 hex characters (128 bits).
 */
function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

/**
 * Locate developer configuration file.
 */
function findConfigFile(explicitPath) {
  if (explicitPath) {
    const resolved = resolve(explicitPath);
    if (existsSync(resolved)) return resolved;
  }

  const candidates = [
    './config.js',
    './nlpwa.config.js',
    './src/config.js',
    './config.json',
  ];

  for (const candidate of candidates) {
    const resolved = resolve(process.cwd(), candidate);
    if (existsSync(resolved)) return resolved;
  }

  return null;
}

/**
 * Load configuration from a JS or JSON file.
 */
async function loadConfig(configPath) {
  if (!configPath) return {};

  if (configPath.endsWith('.json')) {
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  }

  const fileUrl = pathToFileURL(configPath).href;
  const mod = await import(fileUrl);
  return mod.default ?? mod;
}

/**
 * NLPWA Rollup / Vite plugin for automated version management and manifest emission.
 *
 * @param {Object} [options]
 * @param {string}  [options.config]           Path to config.js or config.json
 * @param {boolean} [options.autoIncrement]    Auto-increment patch version (default: true)
 * @param {string}  [options.version]          Explicit app version override
 * @param {boolean} [options.generateManifest] Emit manifest & update API on build (default: true)
 * @param {string}  [options.distDir]          Output directory for web files (default: './dist')
 * @param {boolean} [options.pretty]           Pretty-print JSON
 */
export function nlpwaPlugin(options = {}) {
  const virtualModuleId = 'virtual:nlpwa-version';
  const resolvedVirtualModuleId = '\0' + virtualModuleId;

  return {
    name: 'nlpwa',

    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
    },

    async load(id) {
      if (id === resolvedVirtualModuleId) {
        const configPath = findConfigFile(options.config);
        const config = await loadConfig(configPath);
        const version = options.version ?? config.version ?? '1.0.0';
        return `export const APP_VERSION = ${JSON.stringify(version)};\nexport default APP_VERSION;\n`;
      }
    },

    async writeBundle(bundleOptions) {
      if (options.generateManifest === false) return;

      const configPath = findConfigFile(options.config);
      const rawConfig = await loadConfig(configPath);
      const distDir = resolve(process.cwd(), options.distDir ?? bundleOptions.dir ?? './dist');

      const prevVersion = rawConfig.version ?? '1.0.0';
      const autoInc = options.autoIncrement !== false && !options.version;
      const appVersion = options.version ?? (autoInc ? incrementPatch(prevVersion) : prevVersion);

      // 1. Sync version back to source config if auto-incremented
      if (autoInc && configPath && existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, 'utf8');
          if (configPath.endsWith('.json')) {
            const parsed = JSON.parse(content);
            parsed.version = appVersion;
            writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
          } else {
            const updated = content.replace(/(version\s*:\s*['"])([^'"]+)(['"])/, `$1${appVersion}$3`);
            if (updated !== content) {
              writeFileSync(configPath, updated, 'utf8');
            }
          }
        } catch {
          // Ignore write failure in read-only environment
        }
      }

      const runtimeConfig = {
        ...rawConfig,
        version: appVersion,
        configPath: rawConfig.configPath || '/config.json',
        updateAPI: rawConfig.updateAPI || {
          version: '/api/update/version.json',
          info: '/api/update/info.json',
        },
        precache: rawConfig.precache || [],
        routes: rawConfig.routes || [],
      };

      mkdirSync(distDir, { recursive: true });

      // 2. Emit config.json in distDir
      const configJsonPath = resolve(distDir, 'config.json');
      const jsonIndent = options.pretty ? 2 : 0;
      writeFileSync(configJsonPath, JSON.stringify(runtimeConfig, null, jsonIndent), 'utf8');

      // 3. Track ONLY offline cached files and the config file
      const trackedUrlPaths = Array.from(new Set([
        runtimeConfig.configPath,
        ...(runtimeConfig.precache || []),
      ]));

      const files = [];
      for (const urlPath of trackedUrlPaths) {
        let relPath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
        if (relPath === '' || relPath.endsWith('/')) {
          relPath += 'index.html';
        }

        const diskPath = resolve(distDir, relPath);
        if (existsSync(diskPath)) {
          files.push({ path: urlPath, hash: hashFile(diskPath) });
        }
      }

      // 4. Emit update API outputs
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

      function getApiDiskPath(endpoint) {
        let clean = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
        if (clean.endsWith('.json')) return resolve(distDir, clean);
        return resolve(distDir, clean, 'index.json');
      }

      const versionOut = getApiDiskPath(versionEndpoint);
      const infoOut = getApiDiskPath(infoEndpoint);

      mkdirSync(dirname(versionOut), { recursive: true });
      mkdirSync(dirname(infoOut), { recursive: true });

      writeFileSync(versionOut, JSON.stringify({ version: appVersion }, null, jsonIndent), 'utf8');
      writeFileSync(infoOut, JSON.stringify({ version: appVersion, files }, null, jsonIndent), 'utf8');

      console.log(`[NLPWA] Emitted config.json and update API (v${appVersion}, ${files.length} tracked offline files)`);
    },
  };
}

export default nlpwaPlugin;
