// rollup.config.js

/**
 * Builds two drop-in bundles:
 *
 *   build/sw.js      — Service Worker (ES module, use with `import`)
 *   build/client.js  — Client-side registration (IIFE, use with <script>)
 *
 * The SW is built as ES module format because modern browsers support
 * `type: 'module'` in ServiceWorker.register(). This keeps the output
 * readable and avoids IIFE wrapper issues with SW global scope.
 *
 * Usage in the app's own sw.js:
 *   import { initSW } from '/build/sw.js';
 *   initSW({ version: '1.0.0', precache: [...], routes: [...] });
 *
 * Usage in HTML:
 *   <script src="/build/client.js"></script>
 *   <script>
 *     NLPWAClient.register('/sw.js', { onUpdateReady: ({ version }) => ... });
 *   </script>
 */

export default [
  // ── Service Worker bundle ─────────────────────────────────────────────────
  {
    input: 'src/sw/index.js',
    output: {
      file:    'build/sw.js',
      format:  'es',
      banner:  '/* NLPWA Service Worker — https://github.com/your-org/nlpwa */',
    },
  },

  // ── Client bundle ─────────────────────────────────────────────────────────
  {
    input: 'src/client/register.js',
    output: {
      file:    'build/client.js',
      format:  'iife',
      name:    'NLPWAClient',
      banner:  '/* NLPWA Client — https://github.com/your-org/nlpwa */',
      exports: 'named',
    },
  },
];
