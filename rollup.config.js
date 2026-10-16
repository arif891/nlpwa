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

  return [
  // ── Service Worker bundle ─────────────────────────────────────────────────
  {
    input: 'src/sw/index.js',
    output: {
      file:    'out/sw.js',
      format:  'es',
      banner:  '/* NLPWA Service Worker — https://github.com/arif891/nlpwa */',
    },
    plugins,
  },

  // ── Client bundle ─────────────────────────────────────────────────────────
  {
    input: 'src/client/register.js',
    output: {
      file:    'out/client.js',
      format:  'iife',
      name:    'NLPWAClient',
      banner:  '/* NLPWA Client — https://github.com/arif891/nlpwa */',
      exports: 'named',
    },
    plugins,
  },

  // ── Config starter bundle ─────────────────────────────────────────────────
  {
    input: 'src/config.js',
    output: {
      file:    'out/config.js',
      format:  'es',
      banner:  '/* NLPWA Default Config — https://github.com/arif891/nlpwa */',
    },
    plugins: [
      {
        name: 'emit-config-json',
        async writeBundle() {
          const { default: config } = await import('./src/config.js');
          const { writeFileSync } = await import('node:fs');
          writeFileSync('out/config.json', JSON.stringify(config, null, 2), 'utf8');
        },
      },
    ],
  },
];
};
