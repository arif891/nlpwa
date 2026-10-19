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
  computeManifestHash,
} from '../bin/build-utils.js';

/**
 * NLPWA Webpack / Next.js / Rspack plugin for automated version management and manifest emission.
 *
 * @param {Object} [options]
 * @param {string}  [options.config]           Path to config.js or config.json
 * @param {boolean} [options.autoIncrement]    Auto-increment patch version instead of content hash (default: false)
 * @param {boolean} [options.deriveVersion]    Derive app version suffix from manifest content hash (default: true)
 * @param {boolean} [options.syncSource]       Sync version back to source config file (default: false)
 * @param {string}  [options.version]          Explicit app version override
 * @param {boolean} [options.generateManifest] Emit manifest & update API on build (default: true)
 * @param {string}  [options.distDir]          Output directory for web files (default: compiler output path or './dist')
 * @param {boolean} [options.pretty]           Pretty-print JSON
 */
export class NlpwaWebpackPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    const pluginName = 'NlpwaWebpackPlugin';

    compiler.hooks.afterEmit.tapPromise(pluginName, async (compilation) => {
      if (this.options.generateManifest === false) return;

      const targetConfigPath = findConfigFile(this.options.config);
      const rawConfig = await loadConfig(targetConfigPath);
      const prevVersion = rawConfig.version ?? '1.0.0';

      const distDir = resolve(
        process.cwd(),
        this.options.distDir || compiler.options.output?.path || './dist'
      );
      mkdirSync(distDir, { recursive: true });

      // 1. Track offline cached files, expanding any precache globs
      const { files, expandedPrecache } = collectTrackedFiles(rawConfig, distDir);

      // 2. Resolve version
      let appVersion;
      if (this.options.version) {
        appVersion = this.options.version;
      } else if (this.options.autoIncrement === true) {
        appVersion = incrementPatch(prevVersion);
      } else if (this.options.deriveVersion === false) {
        appVersion = prevVersion;
      } else {
        appVersion = deriveAppVersion(rawConfig, files);
      }

      // Sync version back to source config if requested
      const shouldSyncSource =
        this.options.syncSource === true ||
        (this.options.autoIncrement === true && this.options.syncSource !== false);
      if (shouldSyncSource && targetConfigPath && existsSync(targetConfigPath)) {
        syncSourceConfigVersion(targetConfigPath, appVersion);
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

      // 3. Emit config file in distDir
      const cleanConfigPath = runtimeConfig.configPath.replace(/^\/+/, '');
      const configJsonPath = resolve(distDir, cleanConfigPath);
      mkdirSync(dirname(configJsonPath), { recursive: true });
      const jsonIndent = this.options.pretty ? 2 : 0;
      writeFileSync(configJsonPath, JSON.stringify(runtimeConfig, null, jsonIndent), 'utf8');

      // Update hash and size for config.json now that it is written
      const configEntry = files.find((f) => f.path === runtimeConfig.configPath);
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

      const versionOut = getApiDiskPath(distDir, versionEndpoint, runtimeConfig.base);
      const infoOut = getApiDiskPath(distDir, infoEndpoint, runtimeConfig.base);

      mkdirSync(dirname(versionOut), { recursive: true });
      mkdirSync(dirname(infoOut), { recursive: true });

      const versionPayload = {
        version: appVersion,
        ...(rawConfig.minVersion ? { minVersion: rawConfig.minVersion } : {}),
      };
      const infoPayload = {
        version: appVersion,
        ...(rawConfig.minVersion ? { minVersion: rawConfig.minVersion } : {}),
        files,
      };

      writeFileSync(versionOut, JSON.stringify(versionPayload, null, jsonIndent), 'utf8');
      writeFileSync(infoOut, JSON.stringify(infoPayload, null, jsonIndent), 'utf8');

      console.log(`[NLPWA] Emitted ${cleanConfigPath} and update API (v${appVersion}, ${files.length} tracked offline files)`);
    });
  }
}

export default NlpwaWebpackPlugin;
