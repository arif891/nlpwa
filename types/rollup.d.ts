import type { Plugin } from 'rollup';

export interface RollupPluginOptions {
  /** Path to config.js or config.json (auto-detected if omitted) */
  config?: string;
  /** Auto-increment patch version (default: true) */
  autoIncrement?: boolean;
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
