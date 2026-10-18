import type { Plugin } from 'rollup';

export interface RollupPluginOptions {
  /** Path to config.js or config.json (auto-detected if omitted) */
  config?: string;
  /** Derive app version from manifest content hash (default: false for autoIncrement, i.e. content-hash is used). Set true to bump semver patch. */
  autoIncrement?: boolean;
  /** Sync updated version back into source config.js file (default: false) */
  syncSource?: boolean;
  /** Explicit app version override */
  version?: string;
  /** Emit manifest & update API on build (default: true) */
  generateManifest?: boolean;
  /** Output directory for web files (default: './dist') */
  distDir?: string;
  /** Pretty-print JSON (2-space indent) */
  pretty?: boolean;
}

/**
 * NLPWA Rollup / Vite plugin for automated version management and manifest emission.
 *
 * @param options Plugin configuration options
 */
export function nlpwaPlugin(options?: RollupPluginOptions): Plugin;

export default nlpwaPlugin;
