import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256Hex, hashMatches } from '../src/shared/hash.js';

const CLI = fileURLToPath(new URL('../bin/nlpwa.js', import.meta.url));

/** A throwaway project with a config.json source and a dist/ holding one precached file. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-cli-'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'index.html'), '<h1>hello</h1>');
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ version: '1.0.0', precache: ['/index.html'] }),
  );
  return root;
}

function runUpdate(root, extra = []) {
  return spawnSync(
    process.execPath,
    [CLI, 'update', '--config', join(root, 'config.json'), '--dir', join(root, 'dist'), ...extra],
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
  assert.deepEqual(info.files.map((f) => f.path).sort(), ['/config.json', '/index.html']);

  // Source config.json must NOT be mutated
  const sourceConfig = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  assert.equal(sourceConfig.version, '1.0.0', 'source config.json was not mutated');
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
    [CLI, 'build', '--config', join(root, 'config.json'), '--dir', join(root, 'dist')],
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
    join(root, 'config.json'),
    JSON.stringify({
      version: '1.0.0',
      precache: ['/index.html', '/assets/icons/**'],
    }),
  );

  const res = runUpdate(root);
  assert.equal(res.status, 0, res.stderr);

  const info = JSON.parse(readFileSync(join(root, 'dist/api/update/info.json'), 'utf8'));
  const paths = info.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    '/assets/icons/icon-192.png',
    '/assets/icons/icon-512.png',
    '/config.json',
    '/index.html',
  ]);

  const configJson = JSON.parse(readFileSync(join(root, 'dist/config.json'), 'utf8'));
  assert.deepEqual(configJson.precache.sort(), [
    '/assets/icons/icon-192.png',
    '/assets/icons/icon-512.png',
    '/index.html',
  ]);
});

