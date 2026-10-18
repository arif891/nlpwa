import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  findConfigFile,
  loadConfig,
  syncSourceConfigVersion,
  incrementPatch,
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
 * @param {boolean} [options.autoIncrement]    Auto-increment patch version (default: true)
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
    const autoInc = options.autoIncrement !== false && !options.version;
    targetVersion = options.version ?? (autoInc ? incrementPatch(prevVersion) : prevVersion);
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
        return `export const APP_VERSION = ${JSON.stringify(targetVersion)};\nexport default APP_VERSION;\n`;
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

      const appVersion = targetVersion;
      const autoInc = options.autoIncrement !== false && !options.version;

      // 1. Sync version back to source config if auto-incremented
      if (autoInc && configPath && existsSync(configPath)) {
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
        precache: rawConfig.precache || [],
        routes: rawConfig.routes || [],
      };

      mkdirSync(distDir, { recursive: true });

      // 2. Track offline cached files, expanding any precache globs
      const { files, expandedPrecache } = collectTrackedFiles(runtimeConfig, distDir);

      // 3. Emit config file in distDir with expanded precache list
      const cleanConfigPath = runtimeConfig.configPath.replace(/^\/+/, '');
      const configJsonPath = resolve(distDir, cleanConfigPath);
      mkdirSync(dirname(configJsonPath), { recursive: true });
      const jsonIndent = options.pretty ? 2 : 0;
      const configToEmit = {
        ...runtimeConfig,
        precache: expandedPrecache,
      };
      writeFileSync(configJsonPath, JSON.stringify(configToEmit, null, jsonIndent), 'utf8');

      // Update hash for config.json now that it is written
      const configEntry = files.find(f => f.path === runtimeConfig.configPath);
      if (configEntry) {
        configEntry.hash = hashFile(configJsonPath);
      } else {
        files.unshift({ path: runtimeConfig.configPath, hash: hashFile(configJsonPath) });
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
