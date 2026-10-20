import {
  findConfigFile,
  loadConfig,
  incrementPatch,
  emitBuildManifests,
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

    compiler.hooks.afterEmit.tapPromise(pluginName, async () => {
      if (this.options.generateManifest === false) return;

      const targetConfigPath = findConfigFile(this.options.config);
      const rawConfig = await loadConfig(targetConfigPath);
      const prevVersion = rawConfig.version ?? '1.0.0';

      let targetVersion;
      if (this.options.version) {
        targetVersion = this.options.version;
      } else if (this.options.autoIncrement === true) {
        targetVersion = incrementPatch(prevVersion);
      } else {
        targetVersion = prevVersion;
      }

      const defaultDistDir = compiler.options.output?.path || './dist';
      const { appVersion, cleanConfigPath, files } = emitBuildManifests({
        options: this.options,
        defaultDistDir,
        rawConfig,
        targetConfigPath,
        targetVersion,
      });

      console.log(`[NLPWA] Emitted ${cleanConfigPath} and update API (v${appVersion}, ${files.length} tracked offline files)`);
    });
  }
}

export default NlpwaWebpackPlugin;
