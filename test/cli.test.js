import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256Hex, hashMatches } from '../src/shared/hash.js';

const CLI = fileURLToPath(new URL('../bin/nlpwa.js', import.meta.url));

/** A throwaway project with an nlpwa.config.js source and a dist/ holding one precached file. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-cli-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'index.html'), '<h1>hello</h1>');
  writeFileSync(
    join(root, 'nlpwa.config.js'),
    `export default { version: '1.0.0', precache: ['/index.html'] };\n`,
  );
  return root;
}

function runUpdate(root, extra = []) {
  return spawnSync(
    process.execPath,
    [CLI, 'update', '--config', join(root, 'nlpwa.config.js'), '--dir', join(root, 'dist'), ...extra],
    { cwd: root, encoding: 'utf8' },
  );
}

test('cli update: emits manifest-hash derived version and preserves source config', () => {
  const root = makeProject();
  const res = runUpdate(root);
  assert.equal(res.status, 0, res.stderr);

  const version = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8'));
  const info = JSON.parse(readFileSync(join(root, 'dist/api/update/info.json'), 'utf8'));
  assert.match(version.version, /^1\.0\.0-[0-9a-f]{12}$/);
  assert.equal(version.version, info.version);
  assert.deepEqual(info.files.map((f) => f.path).sort(), ['/api/update/config.json', '/index.html']);
  for (const file of info.files) {
    assert.equal(typeof file.size, 'number', `file ${file.path} has size property`);
    assert.ok(file.size > 0, `file ${file.path} has positive size`);
  }

  // Source nlpwa.config.js must NOT be mutated
  const sourceConfig = readFileSync(join(root, 'nlpwa.config.js'), 'utf8');
  assert.ok(sourceConfig.includes("version: '1.0.0'"), 'source nlpwa.config.js was not mutated');
});

test('cli update: rebuilds of identical content are strictly idempotent', () => {
  const root = makeProject();
  runUpdate(root);
  const v1 = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8')).version;

  runUpdate(root);
  const v2 = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8')).version;
  assert.equal(v1, v2, 'identical files produced the exact same version string');
});

test('cli update: modifying a file updates version, reverting restores original version (rollback)', () => {
  const root = makeProject();
  runUpdate(root);
  const vInitial = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8')).version;

  // Modify file
  writeFileSync(join(root, 'dist/index.html'), '<h1>hello v2</h1>');
  runUpdate(root);
  const vModified = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8')).version;
  assert.notEqual(vInitial, vModified, 'version changed after file modification');

  // Revert file to original content (rollback)
  writeFileSync(join(root, 'dist/index.html'), '<h1>hello</h1>');
  runUpdate(root);
  const vReverted = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8')).version;
  assert.equal(vReverted, vInitial, 'version reverted to exact original hash upon rollback');
});

test('cli update: changing config settings (throwOnFailure, timeouts, intervals) updates version hash', () => {
  const root = makeProject();
  runUpdate(root);
  const vInitial = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8')).version;

  // Change config fields without touching any tracked files
  writeFileSync(
    join(root, 'nlpwa.config.js'),
    `export default ${JSON.stringify({
      version: '1.0.0',
      precache: ['/index.html'],
      throwOnFailure: true,
      networkTimeoutMs: 5000,
      navigationFallback: '/offline.html',
    })};`,
  );

  runUpdate(root);
  const vModified = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8')).version;
  assert.notEqual(vInitial, vModified, 'version hash updated after changing config fields');
});

test('cli update: --bump-patch explicitly increments semver patch', () => {
  const root = makeProject();
  const res = runUpdate(root, ['--bump-patch']);
  assert.equal(res.status, 0, res.stderr);

  const version = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8'));
  assert.equal(version.version, '1.0.1');
});

test('cli update: manifest hashes are 32 hex chars and match the file', async () => {
  const root = makeProject();
  runUpdate(root);

  const info = JSON.parse(readFileSync(join(root, 'dist/api/update/info.json'), 'utf8'));
  const entry = info.files.find((f) => f.path === '/index.html');
  assert.match(entry.hash, /^[0-9a-f]{32}$/);

  const full = await sha256Hex(readFileSync(join(root, 'dist', 'index.html')));
  assert.ok(hashMatches(full, entry.hash));
});

test('cli update: output is compact unless --pretty is passed', () => {
  const compactRoot = makeProject();
  runUpdate(compactRoot);
  const compact = readFileSync(join(compactRoot, 'dist/api/update/info.json'), 'utf8');
  assert.ok(!compact.includes('\n'), 'expected single-line JSON');

  const prettyRoot = makeProject();
  runUpdate(prettyRoot, ['--pretty']);
  const pretty = readFileSync(join(prettyRoot, 'dist/api/update/info.json'), 'utf8');
  assert.ok(pretty.includes('\n  '), 'expected 2-space indented JSON');
});

test('cli build: acts as alias for update', () => {
  const root = makeProject();
  const res = spawnSync(
    process.execPath,
    [CLI, 'build', '--config', join(root, 'nlpwa.config.js'), '--dir', join(root, 'dist')],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);

  const version = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8'));
  assert.match(version.version, /^1\.0\.0-[0-9a-f]{12}$/);
});

test('cli update: expands glob patterns in precache across directories', () => {
  const root = makeProject();
  mkdirSync(join(root, 'dist/assets/icons'), { recursive: true });
  writeFileSync(join(root, 'dist/assets/icons/icon-192.png'), 'png192');
  writeFileSync(join(root, 'dist/assets/icons/icon-512.png'), 'png512');
  writeFileSync(
    join(root, 'nlpwa.config.js'),
    `export default ${JSON.stringify({
      version: '1.0.0',
      precache: ['/index.html', '/assets/icons/**'],
    })};`,
  );

  const res = runUpdate(root);
  assert.equal(res.status, 0, res.stderr);

  const info = JSON.parse(readFileSync(join(root, 'dist/api/update/info.json'), 'utf8'));
  const paths = info.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    '/api/update/config.json',
    '/assets/icons/icon-192.png',
    '/assets/icons/icon-512.png',
    '/index.html',
  ]);

  const configJson = JSON.parse(readFileSync(join(root, 'dist/api/update/config.json'), 'utf8'));
  assert.deepEqual(configJson.precache.sort(), [
    '/assets/icons/icon-192.png',
    '/assets/icons/icon-512.png',
    '/index.html',
  ]);
});

test('cli help: init documents copying nlpwa.config.js', () => {
  const res = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /init\s+Scaffolds or copies sw\.js, client\.js, and nlpwa\.config\.js/);
});

test('cli add: lists available plugins when no plugin name is provided', () => {
  const res = spawnSync(process.execPath, [CLI, 'add'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Available plugins:/);
  assert.match(res.stdout, /sync — Background Sync/);
});

test('cli add: warns on unknown plugin', () => {
  const res = spawnSync(process.execPath, [CLI, 'add', 'nonexistent'], { encoding: 'utf8' });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /Unknown plugin "nonexistent"/);
});

test('cli add: installs sync plugin into target directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-add-'));
  const outDir = fileURLToPath(new URL('../out', import.meta.url));
  const syncSw = join(outDir, 'plugins/sync.sw.js');
  const syncClient = join(outDir, 'plugins/sync.client.js');

  // Ensure source files exist in out/ even if tests run before npm run build
  if (!existsSync(syncSw) || !existsSync(syncClient)) {
    mkdirSync(join(outDir, 'plugins'), { recursive: true });
    if (!existsSync(syncSw)) writeFileSync(syncSw, '/* NLPWASyncSW */');
    if (!existsSync(syncClient)) writeFileSync(syncClient, '/* NLPWASyncClient */');
  }

  const res = spawnSync(process.execPath, [CLI, 'add', 'sync', '--dir', root], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Plugin "sync" added successfully/);

  const swFile = readFileSync(join(root, 'plugins/sync.sw.js'), 'utf8');
  const clientFile = readFileSync(join(root, 'plugins/sync.client.js'), 'utf8');
  assert.ok(swFile.length > 0);
  assert.ok(clientFile.length > 0);
  assert.match(swFile, /NLPWASyncSW/);
  assert.match(clientFile, /NLPWASyncClient/);
});

test('cli update: marks oversized files and skipVerifyGlobs with skipVerify: true in info.json', () => {
  const root = makeProject();
  writeFileSync(join(root, 'dist', 'model.wasm'), Buffer.alloc(100, 'w'));
  writeFileSync(
    join(root, 'nlpwa.config.js'),
    `export default ${JSON.stringify({
      version: '1.0.0',
      maxVerifyBytes: 50,
      skipVerifyGlobs: ['**/*.wasm'],
      precache: ['/index.html', '/model.wasm'],
    })};`,
  );

  const res = runUpdate(root);
  assert.equal(res.status, 0, res.stderr);

  const info = JSON.parse(readFileSync(join(root, 'dist/api/update/info.json'), 'utf8'));
  const wasmEntry = info.files.find((f) => f.path === '/model.wasm');
  assert.ok(wasmEntry, 'model.wasm must be in info.json');
  assert.equal(wasmEntry.skipVerify, true, 'model.wasm should have skipVerify: true');

  const htmlEntry = info.files.find((f) => f.path === '/index.html');
  assert.ok(htmlEntry);
  assert.equal(htmlEntry.skipVerify, undefined, 'normal files should not have skipVerify: true');
});

test('cli init: scaffolds nlpwa.config.js and copies sw.js and client.js', () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-init-'));
  const outDir = fileURLToPath(new URL('../out', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(join(outDir, 'sw.js'))) writeFileSync(join(outDir, 'sw.js'), '// sw');
  if (!existsSync(join(outDir, 'client.js'))) writeFileSync(join(outDir, 'client.js'), '// client');

  const res = spawnSync(process.execPath, [CLI, 'init', '--dir', root], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(root, 'nlpwa.config.js')), 'scaffolded nlpwa.config.js');
  assert.ok(existsSync(join(root, 'sw.js')), 'copied sw.js');
  assert.ok(existsSync(join(root, 'client.js')), 'copied client.js');
  assert.ok(!existsSync(join(root, 'config.json')), 'did not copy root config.json');
});

test('cli update: --patch flag auto-increments base semver patch', () => {
  const root = makeProject();
  const res = runUpdate(root, ['--patch']);
  assert.equal(res.status, 0, res.stderr);

  const version = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8'));
  assert.match(version.version, /^1\.0\.1/);
});

test('cli update: --clean flag emits directory-style endpoints (index.json)', () => {
  const root = makeProject();
  const res = runUpdate(root, ['--clean']);
  assert.equal(res.status, 0, res.stderr);

  assert.ok(existsSync(join(root, 'dist/api/update/version/index.json')), 'version/index.json exists');
  assert.ok(existsSync(join(root, 'dist/api/update/info/index.json')), 'info/index.json exists');
});

test('canonicalizeConfig: strips plugins property so plugin class instances do not affect hashing', async () => {
  const { canonicalizeConfig } = await import('../src/cli/core/manifest.js');
  class MockPlugin {
    constructor() { this.queue = { name: 'q' }; }
  }

  const config1 = { version: '1.0.0', plugins: [new MockPlugin()] };
  const config2 = { version: '1.0.0' };

  assert.deepEqual(canonicalizeConfig(config1), canonicalizeConfig(config2));
});




