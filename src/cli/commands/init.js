import { writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, printBanner } from '../ui/terminal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function cmdInit(args) {
  printBanner();
  console.log(`${c.bold}nlpwa init${c.reset}\n`);

  const targetDir = resolve(args.dir ?? '.');
  mkdirSync(targetDir, { recursive: true });

  const outDir = resolve(__dirname, '../../../out');
  const filesToCopy = [
    { src: 'sw.js',        dest: 'sw.js',        required: true },
    { src: 'client.js',    dest: 'client.js',    required: true },
    { src: 'config.json',  dest: 'config.json',  required: false, checkExisting: true },
  ];

  const missing = [];

  for (const item of filesToCopy) {
    const srcPath = resolve(outDir, item.src);
    const destPath = resolve(targetDir, item.dest);

    if (item.checkExisting && existsSync(destPath)) {
      console.log(`  ${c.dim}-${c.reset} ${c.yellow}Already exists, kept:${c.reset} ${item.dest}`);
      continue;
    }

    if (existsSync(srcPath)) {
      copyFileSync(srcPath, destPath);
      console.log(`  ${c.green}+${c.reset} ${c.bold}Installed:${c.reset} ${item.dest}`);
    } else if (item.required) {
      missing.push(item.src);
      console.error(`  ${c.red}X Source file missing:${c.reset} ${srcPath}`);
    }
  }

  const configJsPath = resolve(targetDir, 'config.js');
  const nlpwaConfigJsPath = resolve(targetDir, 'nlpwa.config.js');
  const configJsonPath = resolve(targetDir, 'config.json');

  if (!existsSync(configJsPath) && !existsSync(nlpwaConfigJsPath) && !existsSync(configJsonPath)) {
    const starterConfigJs = `/**
 * NLPWA Configuration
 * https://github.com/arif891/nlpwa
 */
export default {
  version: '1.0.0',
  precache: [
    '/',
    '/index.html',
    '/client.js',
  ],
  routes: [
    { match: '/assets/**', strategy: 'cache-first' },
    { match: '/api/**', strategy: 'network-first', options: { networkTimeoutMs: 3000 } },
  ],
};
`;
    writeFileSync(configJsPath, starterConfigJs, 'utf8');
    console.log(`  ${c.green}+${c.reset} ${c.bold}Scaffolded starter config:${c.reset} config.js`);
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
  1. Add the client script to your HTML:
     ${c.cyan}<script src="/client.js"></script>${c.reset}

  2. Configure routes & offline precache in ${c.bold}config.json${c.reset}

  3. When deploying updates, run:
     ${c.cyan}npx nlpwa update${c.reset}
`);
}
