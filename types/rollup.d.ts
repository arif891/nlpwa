import type { Plugin } from 'rollup';

export interface RollupPluginOptions {
  /** Path to config.js or config.json (auto-detected if omitted) */
  config?: string;
  /** Auto-increment semver patch version on build (e.g. 1.0.0 -> 1.0.1). Default: false */
  autoIncrement?: boolean;
  /** Derive app version suffix from manifest content hash (e.g. 1.0.0-a1b2c3d4e5f6). Default: false */
  deriveVersion?: boolean;
  /** Sync updated version back into source config file (recommended for config.json). Default: false */
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
