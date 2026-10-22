import { writeFileSync, existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, printBanner } from '../ui/terminal.js';
import { createPngIcon, createSvgIcon, createManifest } from '../core/icons.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveAppName(targetDir, explicitName) {
  if (explicitName) return explicitName;
  const pkgPath = resolve(targetDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.name) {
        return pkg.name
          .replace(/^@[^/]+\//, '')
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (ch) => ch.toUpperCase());
      }
    } catch {}
  }
  const dirName = basename(targetDir);
  if (dirName && dirName !== '.' && dirName !== '/') {
    return dirName
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return 'My Progressive Web App';
}

export async function cmdInit(args) {
  printBanner();
  console.log(`${c.bold}nlpwa init${c.reset}\n`);

  const targetDir = resolve(args.dir ?? '.');
  mkdirSync(targetDir, { recursive: true });

  const outDir = resolve(__dirname, '../../../out');
  const filesToCopy = [
    { src: 'sw.js',        dest: 'sw.js',        required: true },
    { src: 'client.js',    dest: 'client.js',    required: true },
  ];

  const missing = [];

  for (const item of filesToCopy) {
    const srcPath = resolve(outDir, item.src);
    const destPath = resolve(targetDir, item.dest);

    if (existsSync(srcPath)) {
      copyFileSync(srcPath, destPath);
      console.log(`  ${c.green}+${c.reset} ${c.bold}Installed:${c.reset} ${item.dest}`);
    } else if (item.required) {
      missing.push(item.src);
      console.error(`  ${c.red}X Source file missing:${c.reset} ${srcPath}`);
    }
  }

  // ── Manifest and PWA Icons Scaffolding ──────────────────────────────────────
  const shouldCreateManifest = args['no-manifest'] !== true;
  let manifestCreated = false;

  if (shouldCreateManifest) {
    const manifestDir = resolve(targetDir, 'assets', 'other');
    const manifestPath = resolve(manifestDir, 'manifest.webmanifest');
    const iconsDir = resolve(targetDir, 'assets', 'image', 'icon');

    const appName = resolveAppName(targetDir, args.name);
    const shortName = args.shortName || appName.split(' ')[0] || 'App';
    const themeColor = args.themeColor || '#0ea5e9';
    const bgColor = args.bgColor || '#0f172a';

    if (!existsSync(manifestPath)) {
      mkdirSync(manifestDir, { recursive: true });
      const manifestObj = createManifest({
        name: appName,
        shortName,
        themeColor,
        bgColor,
      });
      writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2), 'utf8');
      console.log(`  ${c.green}+${c.reset} ${c.bold}Generated:${c.reset} assets/other/manifest.webmanifest (${appName})`);
      manifestCreated = true;
    }

    mkdirSync(iconsDir, { recursive: true });

    const icon192Path = resolve(iconsDir, 'icon-192.png');
    if (!existsSync(icon192Path)) {
      const png192 = createPngIcon(192, { themeColor, bgColor });
      writeFileSync(icon192Path, png192);
      console.log(`  ${c.green}+${c.reset} ${c.bold}Generated:${c.reset} assets/image/icon/icon-192.png`);
    }

    const icon512Path = resolve(iconsDir, 'icon-512.png');
    if (!existsSync(icon512Path)) {
      const png512 = createPngIcon(512, { themeColor, bgColor });
      writeFileSync(icon512Path, png512);
      console.log(`  ${c.green}+${c.reset} ${c.bold}Generated:${c.reset} assets/image/icon/icon-512.png`);
    }

    const iconSvgPath = resolve(iconsDir, 'icon.svg');
    if (!existsSync(iconSvgPath)) {
      const svg = createSvgIcon({ name: appName, shortName, themeColor, bgColor });
      writeFileSync(iconSvgPath, svg, 'utf8');
      console.log(`  ${c.green}+${c.reset} ${c.bold}Generated:${c.reset} assets/image/icon/icon.svg`);
    }
  }

  // ── Starter nlpwa.config.js ────────────────────────────────────────────────
  const nlpwaConfigJsPath = resolve(targetDir, 'nlpwa.config.js');

  if (!existsSync(nlpwaConfigJsPath)) {
    const precacheList = [
      "'/'",
      "'/index.html'",
      "'/client.js'",
    ];

    if (shouldCreateManifest) {
      precacheList.push(
        "'/assets/other/manifest.webmanifest'",
        "'/assets/image/icon/icon-192.png'",
        "'/assets/image/icon/icon-512.png'",
        "'/assets/image/icon/icon.svg'",
      );
    }

    const starterConfigJs = `/**
 * NLPWA Configuration
 * https://github.com/arif891/nlpwa
 */
export default {
  version: '1.0.0',
  verifyHashes: 'warn',
  precache: [
    ${precacheList.join(',\n    ')},
  ],
  routes: [
    { match: '/assets/**', strategy: 'cache-first' },
    { match: '/api/**', strategy: 'network-first', networkTimeoutMs: 3000 },
  ],
};
`;
    writeFileSync(nlpwaConfigJsPath, starterConfigJs, 'utf8');
    console.log(`  ${c.green}+${c.reset} ${c.bold}Scaffolded starter config:${c.reset} nlpwa.config.js`);
  }

  // Ensure .env.nlpwa is protected in .gitignore
  const gitignorePath = resolve(targetDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      const gitignore = readFileSync(gitignorePath, 'utf8');
      if (!gitignore.includes('.env.nlpwa')) {
        appendFileSync(gitignorePath, '\n# NLPWA Signing Keys\n.env.nlpwa\n', 'utf8');
        console.log(`  ${c.green}+${c.reset} Added .env.nlpwa to .gitignore`);
      }
    } catch {}
  }

  if (missing.length > 0) {
    console.error(`
${c.red}${c.bold}  Init failed:${c.reset} ${missing.join(', ')} not found in ${outDir}
  If you are running from a git checkout, build first: ${c.cyan}npm install && npm run build${c.reset}
`);
    process.exit(1);
  }

  console.log(`
${c.bold}${c.green}  NLPWA files initialized successfully!${c.reset}

  ${c.bold}Next steps:${c.reset}
  1. Add PWA tags & client script to your HTML <head>:
     ${c.cyan}<link rel="manifest" href="/assets/other/manifest.webmanifest">
     <link rel="icon" href="/assets/image/icon/icon.svg" type="image/svg+xml">
     <link rel="apple-touch-icon" href="/assets/image/icon/icon-192.png">
     <meta name="theme-color" content="${args.themeColor || '#0ea5e9'}">
     <script src="/client.js"></script>${c.reset}
     ${c.dim}(client.js automatically registers /sw.js by default)${c.reset}

  2. Configure routes & offline precache in ${c.bold}nlpwa.config.js${c.reset}

  3. When deploying updates, run:
     ${c.cyan}npx nlpwa update${c.reset}
`);
}
