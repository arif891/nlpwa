import type { Plugin } from 'rollup';
import type { RollupPluginOptions } from './rollup';

export type VitePluginOptions = RollupPluginOptions;

/**
 * NLPWA Vite plugin for automated version management and manifest emission.
 *
 * @param options Plugin configuration options
 */
export function nlpwaPlugin(options?: VitePluginOptions): Plugin;

export default nlpwaPlugin;
