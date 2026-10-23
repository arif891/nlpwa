import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConfigFile, loadConfig } from '../src/cli/core/config.js';
import { cmdUpdate } from '../src/cli/commands/update.js';
import { cmdInit } from '../src/cli/commands/init.js';

test('cli: init --dir scaffolds into targetDir and update --dir finds it automatically', async () => {
  const origCwd = process.cwd();
  const testRoot = mkdtempSync(join(tmpdir(), 'nlpwa-cli-init-'));

  try {
    process.chdir(testRoot);

    await cmdInit({
      dir: './public',
      name: 'Test App',
      sign: true,
      'no-manifest': false,
    });

    // 1. Files scaffolded into ./public
    assert.ok(existsSync(join(testRoot, 'public', 'nlpwa.config.js')), 'nlpwa.config.js must exist in public/');
    assert.ok(existsSync(join(testRoot, 'public', '.env.nlpwa')), '.env.nlpwa must exist in public/');
    assert.ok(existsSync(join(testRoot, 'public', 'sw.js')), 'public/sw.js must exist');
    assert.ok(existsSync(join(testRoot, 'public', 'client.js')), 'public/client.js must exist');

    // 2. Running update --dir ./public must find the config in public/ without needing --config
    await cmdUpdate({
      dir: './public',
    });

    const infoPath = join(testRoot, 'public', 'api', 'update', 'info.json');
    assert.ok(existsSync(infoPath), 'info.json must exist');
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));

    // Should have tracked all precached files, NOT just 1 file
    assert.ok(info.files.length > 1, `Expected >1 files tracked, got ${info.files.length}`);
    assert.ok(info.files.some(f => f.path === '/client.js'));
  } finally {
    process.chdir(origCwd);
  }
});

test('cli: update --dir resolves config at project root and tracks all precache files', async () => {
  const origCwd = process.cwd();
  const testRoot = mkdtempSync(join(tmpdir(), 'nlpwa-cli-update-'));

  try {
    process.chdir(testRoot);

    const publicDir = join(testRoot, 'public');
    mkdirSync(publicDir, { recursive: true });

    // Create 3 asset files
    writeFileSync(join(publicDir, 'index.html'), '<html><body>Hello</body></html>');
    writeFileSync(join(publicDir, 'app.js'), 'console.log("app");');
    writeFileSync(join(publicDir, 'style.css'), 'body { margin: 0; }');

    // Create config at project root
    const configContent = `export default {
  version: '1.0.0',
  precache: [
    '/index.html',
    '/app.js',
    '/style.css'
  ]
};`;
    writeFileSync(join(testRoot, 'nlpwa.config.js'), configContent);

    await cmdUpdate({
      dir: './public',
    });

    const runtimeConfigPath = join(publicDir, 'api', 'update', 'config.json');
    assert.ok(existsSync(runtimeConfigPath), 'runtime config.json must exist');

    const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, 'utf8'));
    assert.ok(runtimeConfig.precache.includes('/index.html'));
    assert.ok(runtimeConfig.precache.includes('/app.js'));
    assert.ok(runtimeConfig.precache.includes('/style.css'));

    const infoPath = join(publicDir, 'api', 'update', 'info.json');
    assert.ok(existsSync(infoPath), 'info.json must exist');
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));
    // 3 precache files + 1 runtime config file = 4 tracked files
    assert.equal(info.files.length, 4);
  } finally {
    process.chdir(origCwd);
  }
});

test('cli: update --dir with no config emits empty manifest and warns without throwing', async () => {
  const origCwd = process.cwd();
  const testRoot = mkdtempSync(join(tmpdir(), 'nlpwa-cli-noconfig-'));

  try {
    process.chdir(testRoot);

    const publicDir = join(testRoot, 'public');
    mkdirSync(publicDir, { recursive: true });

    let warned = false;
    const origWarn = console.warn;
    console.warn = (...args) => {
      const msg = args.join(' ');
      if (msg.includes('No nlpwa configuration file found')) {
        warned = true;
      }
    };

    try {
      await cmdUpdate({
        dir: './public',
      });
    } finally {
      console.warn = origWarn;
    }

    assert.ok(warned, 'A warning must be logged when no config is found');
    const runtimeConfigPath = join(publicDir, 'api', 'update', 'config.json');
    assert.ok(existsSync(runtimeConfigPath), 'runtime config.json still generated');
    const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, 'utf8'));
    assert.deepEqual(runtimeConfig.precache, []);
  } finally {
    process.chdir(origCwd);
  }
});
