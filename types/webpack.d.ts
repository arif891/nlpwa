export interface WebpackPluginOptions {
  /** Path to config.js or config.json (auto-detected if omitted) */
  config?: string;
  /** Auto-increment semver patch version on build (e.g. 1.0.0 -> 1.0.1). Default: false */
  autoIncrement?: boolean;
  /** Derive app version suffix from manifest content hash (e.g. 1.0.0-a1b2c3d4e5f6). Default: true */
  deriveVersion?: boolean;
  /** Sync updated version back into source config file (recommended for config.json). Default: false */
  syncSource?: boolean;
  /** Explicit app version override */
  version?: string;
  /** Emit manifest & update API on build (default: true) */
  generateManifest?: boolean;
  /** Output directory for web files (default: compiler output path or './dist') */
  distDir?: string;
  /** Pretty-print JSON (2-space indent) */
  pretty?: boolean;
}

export interface WebpackCompiler {
  hooks: {
    afterEmit: {
      tapPromise(name: string, fn: (compilation: unknown) => Promise<void>): void;
    };
  };
  options: {
    output?: {
      path?: string;
    };
  };
}

/**
 * NLPWA Webpack / Next.js / Rspack plugin for automated version management and manifest emission.
 */
export class NlpwaWebpackPlugin {
  constructor(options?: WebpackPluginOptions);
  apply(compiler: WebpackCompiler): void;
}

export default NlpwaWebpackPlugin;
