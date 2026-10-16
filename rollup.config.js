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
      file:    'build/sw.js',
      format:  'es',
      banner:  '/* NLPWA Service Worker — https://github.com/your-org/nlpwa */',
    },
    plugins,
  },

  // ── Client Registration bundle ────────────────────────────────────────────
  {
    input: 'src/client/register.js',
    output: [
      {
        file:    'build/register.js',
        format:  'iife',
        name:    'NLPWAClient',
        banner:  '/* NLPWA Client — https://github.com/your-org/nlpwa */',
        exports: 'named',
      },
      {
        file:    'build/client.js',
        format:  'iife',
        name:    'NLPWAClient',
        banner:  '/* NLPWA Client — https://github.com/your-org/nlpwa */',
        exports: 'named',
      },
    ],
    plugins,
  },

  // ── Config starter bundle ─────────────────────────────────────────────────
  {
    input: 'src/config.template.js',
    output: {
      file:    'build/config.js',
      format:  'es',
      banner:  '/* NLPWA Default Config — https://github.com/your-org/nlpwa */',
    },
    plugins: [],
  },
];
};
