#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs';
import { cmdUpdate } from '../src/cli/commands/update.js';

async function main() {
  try {
    if (existsSync('out/sw.js') && existsSync('example/sw.js')) {
      copyFileSync('out/sw.js', 'example/sw.js');
    }
    if (existsSync('out/client.js') && existsSync('example/client.js')) {
      copyFileSync('out/client.js', 'example/client.js');
    }

    await cmdUpdate({
      config: 'example/nlpwa.config.js',
      dir: 'example',
      version: '1.0.0',
      pretty: true,
      unsigned: true,
    });
    console.log('[NLPWA] Example assets and manifest synced successfully.');
  } catch (err) {
    console.warn('[NLPWA] sync-example warning:', err?.message || err);
  }
}

main();
