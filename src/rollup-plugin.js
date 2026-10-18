import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  findConfigFile,
  loadConfig,
  syncSourceConfigVersion,
  incrementPatch,
  deriveAppVersion,
  hashFile,
  collectTrackedFiles,
  resolveUpdateEndpoints,
  getApiDiskPath,
} from '../bin/build-utils.js';

/**
 * NLPWA Rollup / Vite plugin for automated version management and manifest emission.
 *
 * @param {Object} [options]
 * @param {string}  [options.config]           Path to config.js or config.json
 * @param {boolean} [options.autoIncrement]    Auto-increment patch version instead of content hash (default: false)
 * @param {boolean} [options.deriveVersion]    Derive app version suffix from manifest content hash (default: true)
 * @param {boolean} [options.syncSource]       Sync version back to source config file (default: false)
 * @param {string}  [options.version]          Explicit app version override
 * @param {boolean} [options.generateManifest] Emit manifest & update API on build (default: true)
 * @param {string}  [options.distDir]          Output directory for web files (default: './dist')
 * @param {boolean} [options.pretty]           Pretty-print JSON
 */
export function nlpwaPlugin(options = {}) {
  const virtualModuleId = 'virtual:nlpwa-version';
  const resolvedVirtualModuleId = '\0' + virtualModuleId;

  let targetVersion = null;
  let targetConfig = null;
  let targetConfigPath = null;

  async function resolveTargetVersion() {
    targetConfigPath = findConfigFile(options.config);
    targetConfig = await loadConfig(targetConfigPath);
    const prevVersion = targetConfig.version ?? '1.0.0';
    if (options.version) {
      targetVersion = options.version;
    } else if (options.autoIncrement === true) {
      targetVersion = incrementPatch(prevVersion);
    } else {
      targetVersion = prevVersion;
    }
    return { targetVersion, targetConfig, targetConfigPath };
  }

  return {
    name: 'nlpwa',

    async buildStart() {
      await resolveTargetVersion();
    },

    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
    },

    async load(id) {
      if (id === resolvedVirtualModuleId) {
        if (!targetVersion) {
          await resolveTargetVersion();
        }
        return `export const APP_VERSION = ${JSON.stringify(targetVersion)};\nexport const BASE_VERSION = ${JSON.stringify(targetVersion)};\nexport default APP_VERSION;\n`;
      }
    },

    async writeBundle(bundleOptions) {
      if (options.generateManifest === false) return;

      if (!targetVersion) {
        await resolveTargetVersion();
      }

      const configPath = targetConfigPath;
      const rawConfig = targetConfig || {};
      const distDir = resolve(process.cwd(), options.distDir ?? bundleOptions.dir ?? './dist');
      mkdirSync(distDir, { recursive: true });

      // 1. Track offline cached files, expanding any precache globs
      const { files, expandedPrecache } = collectTrackedFiles(rawConfig, distDir);

      // 2. Resolve version
      let appVersion;
      if (options.version) {
        appVersion = options.version;
      } else if (options.autoIncrement === true) {
        appVersion = targetVersion;
      } else if (options.deriveVersion === false) {
        appVersion = targetVersion;
      } else {
        appVersion = deriveAppVersion(rawConfig, files);
      }

      // Sync version back to source config if explicitly requested or if autoIncrement is enabled
      const shouldSyncSource = options.syncSource === true || (options.autoIncrement === true && options.syncSource !== false);
      if (shouldSyncSource && configPath && existsSync(configPath)) {
        syncSourceConfigVersion(configPath, appVersion);
      }

      const runtimeConfig = {
        ...rawConfig,
        version: appVersion,
        configPath: rawConfig.configPath || '/config.json',
        updateAPI: rawConfig.updateAPI || {
          version: '/api/update/version.json',
          info: '/api/update/info.json',
        },
        precache: expandedPrecache,
        routes: rawConfig.routes || [],
      };

      // 3. Emit config file in distDir with expanded precache list
      const cleanConfigPath = runtimeConfig.configPath.replace(/^\/+/, '');
      const configJsonPath = resolve(distDir, cleanConfigPath);
      mkdirSync(dirname(configJsonPath), { recursive: true });
      const jsonIndent = options.pretty ? 2 : 0;
      writeFileSync(configJsonPath, JSON.stringify(runtimeConfig, null, jsonIndent), 'utf8');

      // Update hash and size for config.json now that it is written
      const configEntry = files.find(f => f.path === runtimeConfig.configPath);
      const configSize = statSync(configJsonPath).size;
      if (configEntry) {
        configEntry.hash = hashFile(configJsonPath);
        configEntry.size = configSize;
      } else {
        files.unshift({
          path: runtimeConfig.configPath,
          hash: hashFile(configJsonPath),
          size: configSize,
        });
      }

      // 4. Emit update API outputs
      const { versionEndpoint, infoEndpoint } = resolveUpdateEndpoints(runtimeConfig);

      const versionOut = getApiDiskPath(distDir, versionEndpoint);
      const infoOut = getApiDiskPath(distDir, infoEndpoint);

      mkdirSync(dirname(versionOut), { recursive: true });
      mkdirSync(dirname(infoOut), { recursive: true });

      writeFileSync(versionOut, JSON.stringify({ version: appVersion }, null, jsonIndent), 'utf8');
      writeFileSync(infoOut, JSON.stringify({ version: appVersion, files }, null, jsonIndent), 'utf8');

      console.log(`[NLPWA] Emitted ${cleanConfigPath} and update API (v${appVersion}, ${files.length} tracked offline files)`);
    },
  };
}

export default nlpwaPlugin;
