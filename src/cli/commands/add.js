import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, printBanner } from '../ui/terminal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const AVAILABLE_PLUGINS = {
  sync: {
    id: 'sync',
    name: 'Background Sync & Offline Mutation',
    description: 'Enqueues and replays offline POST/PUT requests using IndexedDB with cross-browser fallback',
    files: [
      { src: 'plugins/sync.sw.js', dest: 'plugins/sync.sw.js' },
      { src: 'plugins/sync.client.js', dest: 'plugins/sync.client.js' },
    ],
    instructions: [
      '1. In your Service Worker (sw.js):',
      '   importScripts(\'/plugins/sync.sw.js\');',
      '   const sync = new NLPWASyncSW.BackgroundSyncPlugin({ queueName: \'forms\' });',
      '',
      '2. In your web page (index.html):',
      '   <script src="/plugins/sync.client.js"></script>',
      '   <script>',
      '     const { syncClient } = window.NLPWASyncClient;',
      '     syncClient.autoSyncOnOnline(\'forms\');',
      '   </script>',
    ],
  },
};

export async function cmdAdd(args) {
  printBanner();
  console.log(`${c.bold}nlpwa add${c.reset}\n`);

  const pluginName = args._[1]?.toLowerCase();

  if (!pluginName) {
    console.log(`${c.yellow}No plugin specified.${c.reset} Available plugins:\n`);
    for (const [id, info] of Object.entries(AVAILABLE_PLUGINS)) {
      console.log(`  ${c.green}${c.bold}${id}${c.reset} — ${info.name}`);
      console.log(`    ${c.dim}${info.description}${c.reset}\n`);
    }
    console.log(`Usage: nlpwa add <plugin-name> [--dir <target-directory>]\n`);
    return;
  }

  const plugin = AVAILABLE_PLUGINS[pluginName];
  if (!plugin) {
    console.error(`  ${c.red}Unknown plugin "${pluginName}".${c.reset}`);
    console.log(`\nAvailable plugins: ${Object.keys(AVAILABLE_PLUGINS).join(', ')}\n`);
    return;
  }

  const targetDir = resolve(args.dir ?? '.');
  const outDir = resolve(__dirname, '../../../out');

  console.log(`Installing ${c.bold}${plugin.name}${c.reset} into ${targetDir}...\n`);

  const missing = [];
  for (const item of plugin.files) {
    const srcPath = resolve(outDir, item.src);
    const destPath = resolve(targetDir, item.dest);

    if (existsSync(srcPath)) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      console.log(`  ${c.green}+${c.reset} ${c.bold}Installed:${c.reset} ${item.dest}`);
    } else {
      missing.push(item.src);
      console.error(`  ${c.red}X Source file missing:${c.reset} ${srcPath}`);
    }
  }

  if (missing.length > 0) {
    console.error(`\n${c.red}Add failed:${c.reset} missing files. Run \`npm run build\` first.\n`);
    return;
  }

  console.log(`\n${c.green}✓ Plugin "${pluginName}" added successfully!${c.reset}\n`);
  console.log(`${c.bold}Next Steps:${c.reset}`);
  for (const line of plugin.instructions) {
    console.log(`  ${line}`);
  }
  console.log();
}
