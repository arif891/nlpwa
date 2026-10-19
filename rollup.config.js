export default async () => {
  const isProd = Boolean(process.env.PROD);
  const plugins = [];

  if (isProd) {
    try {
      const { default: terser } = await import('@rollup/plugin-terser');
      plugins.push(terser());
    } catch {
      console.warn('[NLPWA] @rollup/plugin-terser not found, skipping minification. Run `npm install` to enable.');
    }
  }

  // ── Emit runtime config.json ──────────────────────────────────────────────
  const emitConfigPlugin = {
    name: 'emit-config-json',
    async writeBundle() {
      const { default: config } = await import('./src/config.js');
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync('out', { recursive: true });
      writeFileSync('out/config.json', JSON.stringify(config, null, 2), 'utf8');
    },
  };

  return [
  // ── Service Worker: standalone ────────────────────────────────────────────
  // Copied by `nlpwa init`. Calls initSW() itself, has no exports, and is an
  // IIFE so it registers as a classic or a module worker.
  {
    input: 'src/sw/standalone.js',
    output: {
      file:    'out/sw.js',
      format:  'iife',
      banner:  '/* NLPWA Service Worker — https://github.com/arif891/nlpwa */',
    },
    plugins: [...plugins, emitConfigPlugin],
  },

  // ── Service Worker: library (import { initSW } from 'nlpwa/sw') ───────────
  {
    input: 'src/sw/index.js',
    output: {
      file:    'out/sw.module.js',
      format:  'es',
      banner:  '/* NLPWA Service Worker (module) — https://github.com/arif891/nlpwa */',
    },
    plugins,
  },

  // ── Client: IIFE (<script src="/client.js"> → global NLPWAClient) ─────────
  {
    input: 'src/client/index.js',
    output: {
      file:    'out/client.js',
      format:  'iife',
      name:    'NLPWAClient',
      banner:  '/* NLPWA Client — https://github.com/arif891/nlpwa */',
      exports: 'named',
    },
    plugins,
  },

  // ── Client: ES module (import { register } from 'nlpwa/client') ───────────
  {
    input: 'src/client/index.js',
    output: {
      file:    'out/client.esm.js',
      format:  'es',
      banner:  '/* NLPWA Client (module) — https://github.com/arif891/nlpwa */',
    },
    plugins,
  },


  // ── Rollup plugin ─────────────────────────────────────────────────────────
  {
    input: 'src/rollup-plugin.js',
    output: {
      file:    'out/rollup-plugin.js',
      format:  'es',
      banner:  '/* NLPWA Rollup Plugin — https://github.com/arif891/nlpwa */',
    },
    external: [
      /^node:/,
    ],
    plugins,
  },

  // ── Webpack plugin ────────────────────────────────────────────────────────
  {
    input: 'src/webpack-plugin.js',
    output: {
      file:    'out/webpack-plugin.js',
      format:  'es',
      banner:  '/* NLPWA Webpack Plugin — https://github.com/arif891/nlpwa */',
    },
    external: [
      /^node:/,
    ],
    plugins,
  },

  // ── Sync Plugin: ES module (import from 'nlpwa/sync') ─────────────────────
  {
    input: 'src/plugins/sync/index.js',
    output: {
      file:    'out/plugins/sync.js',
      format:  'es',
      banner:  '/* NLPWA Background Sync Plugin (module) — https://github.com/arif891/nlpwa */',
    },
    plugins,
  },

  // ── Sync Client: ES module (import from 'nlpwa/sync/client') ──────────────
  {
    input: 'src/plugins/sync/client.js',
    output: {
      file:    'out/plugins/sync.client.esm.js',
      format:  'es',
      banner:  '/* NLPWA Sync Client (module) — https://github.com/arif891/nlpwa */',
    },
    plugins,
  },

  // ── Sync SW: Standalone drop-in IIFE ──────────────────────────────────────
  {
    input: 'src/plugins/sync/sw.js',
    output: {
      file:    'out/plugins/sync.sw.js',
      format:  'iife',
      name:    'NLPWASyncSW',
      banner:  '/* NLPWA Background Sync SW (standalone) — https://github.com/arif891/nlpwa */',
    },
    plugins,
  },

  // ── Sync Client: Standalone drop-in IIFE (<script src="/plugins/sync.client.js">)
  {
    input: 'src/plugins/sync/client.js',
    output: {
      file:    'out/plugins/sync.client.js',
      format:  'iife',
      name:    'NLPWASyncClient',
      banner:  '/* NLPWA Sync Client (standalone) — https://github.com/arif891/nlpwa */',
      exports: 'named',
    },
    plugins,
  },
];
};

