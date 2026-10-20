import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findConfigFile,
  loadConfig,
  incrementPatch,
  computeManifestHash,
  collectTrackedFiles,
  emitBuildManifests,
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
  let cachedContentHash = '';

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
        // virtual:nlpwa-version provides:
        // - BASE_VERSION: the base configured version (e.g. '1.0.0')
        // - APP_VERSION: the base app version at build time (e.g. '1.0.0').
        // - CONTENT_HASH: composite 12-char content hash of tracked files & config available at transform time
        // Note: During the load() hook, Rollup has not yet emitted current bundle chunks to distDir.
        // Therefore, CONTENT_HASH here reflects pre-existing static files in distDir. The definitive
        // post-build version and manifest hashes are emitted in version.json/info.json during writeBundle.
        // If deriveVersion is false or autoIncrement is true, APP_VERSION matches the manifest version exactly.
        let contentHash = cachedContentHash;
        if (!contentHash) {
          try {
            const distDir = resolve(process.cwd(), options.distDir ?? './dist');
            if (existsSync(distDir)) {
              const { files } = collectTrackedFiles(targetConfig || {}, distDir);
              contentHash = computeManifestHash(files, targetConfig || {});
              cachedContentHash = contentHash;
            }
          } catch {}
        }
        return `export const APP_VERSION = ${JSON.stringify(targetVersion)};\nexport const BASE_VERSION = ${JSON.stringify(targetVersion)};\nexport const CONTENT_HASH = ${JSON.stringify(contentHash)};\nexport default APP_VERSION;\n`;
      }
    },

    async writeBundle(bundleOptions = {}) {
      if (options.generateManifest === false) return;

      if (!targetVersion) {
        await resolveTargetVersion();
      }

      const defaultDistDir = bundleOptions?.dir ?? './dist';
      const { appVersion, cleanConfigPath, files, contentHash } = emitBuildManifests({
        options,
        defaultDistDir,
        rawConfig: targetConfig || {},
        targetConfigPath,
        targetVersion,
      });

      cachedContentHash = contentHash;
      console.log(`[NLPWA] Emitted ${cleanConfigPath} and update API (v${appVersion}, ${files.length} tracked offline files)`);
    },
  };
}

export default nlpwaPlugin;
