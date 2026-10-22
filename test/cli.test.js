import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { sha256Hex, hashMatches } from '../src/shared/hash.js';
import { syncSourceConfigPublicKey } from '../src/cli/core/config.js';


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

test('cli add: installs sync plugin into target directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-add-'));
  const outDir = fileURLToPath(new URL('../out', import.meta.url));
  const syncSw = join(outDir, 'plugins/sync.sw.js');
  const syncClient = join(outDir, 'plugins/sync.client.js');

  const createdStubs = [];
  // Ensure source files exist in out/ even if tests run before npm run build
  if (!existsSync(syncSw) || !existsSync(syncClient)) {
    mkdirSync(join(outDir, 'plugins'), { recursive: true });
    if (!existsSync(syncSw)) {
      writeFileSync(syncSw, '/* NLPWASyncSW */');
      createdStubs.push(syncSw);
    }
    if (!existsSync(syncClient)) {
      writeFileSync(syncClient, '/* NLPWASyncClient */');
      createdStubs.push(syncClient);
    }
  }

  t.after(() => {
    for (const file of createdStubs) {
      try { unlinkSync(file); } catch {}
    }
  });

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

test('cli init: scaffolds nlpwa.config.js, manifest.webmanifest, icons, and copies sw.js and client.js', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-init-'));
  const outDir = fileURLToPath(new URL('../out', import.meta.url));
  mkdirSync(outDir, { recursive: true });

  const createdStubs = [];
  if (!existsSync(join(outDir, 'sw.js'))) {
    writeFileSync(join(outDir, 'sw.js'), '// sw');
    createdStubs.push(join(outDir, 'sw.js'));
  }
  if (!existsSync(join(outDir, 'client.js'))) {
    writeFileSync(join(outDir, 'client.js'), '// client');
    createdStubs.push(join(outDir, 'client.js'));
  }

  t.after(() => {
    for (const file of createdStubs) {
      try { unlinkSync(file); } catch {}
    }
  });

  const res = spawnSync(process.execPath, [CLI, 'init', '--dir', root, '--name', 'Test PWA'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(root, 'nlpwa.config.js')), 'scaffolded nlpwa.config.js');
  assert.ok(existsSync(join(root, 'sw.js')), 'copied sw.js');
  assert.ok(existsSync(join(root, 'client.js')), 'copied client.js');
  assert.ok(!existsSync(join(root, 'config.json')), 'did not copy root config.json');

  // Verify web app manifest and icons
  assert.ok(existsSync(join(root, 'assets/other/manifest.webmanifest')), 'scaffolded manifest.webmanifest');
  const manifest = JSON.parse(readFileSync(join(root, 'assets/other/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Test PWA');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.length, 3);
  assert.equal(manifest.icons[0].src, '/assets/image/icon/icon-192.png');

  assert.ok(existsSync(join(root, 'assets/image/icon/icon-192.png')), 'generated icon-192.png');
  assert.ok(existsSync(join(root, 'assets/image/icon/icon-512.png')), 'generated icon-512.png');
  assert.ok(existsSync(join(root, 'assets/image/icon/icon.svg')), 'generated icon.svg');

  // Verify PNG signature (first 8 bytes: 89 50 4E 47 0D 0A 1A 0A)
  const pngBuf = readFileSync(join(root, 'assets/image/icon/icon-192.png'));
  assert.deepEqual(Array.from(pngBuf.subarray(0, 8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // Verify precache includes manifest and icons
  const configContent = readFileSync(join(root, 'nlpwa.config.js'), 'utf8');
  assert.ok(configContent.includes("'/assets/other/manifest.webmanifest'"));
  assert.ok(configContent.includes("'/assets/image/icon/icon-192.png'"));
});

test('cli init: --no-manifest flag skips manifest and icon generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-init-no-manifest-'));
  const res = spawnSync(process.execPath, [CLI, 'init', '--dir', root, '--no-manifest'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(root, 'nlpwa.config.js')));
  assert.ok(!existsSync(join(root, 'assets/other/manifest.webmanifest')));
  assert.ok(!existsSync(join(root, 'assets/image/icon')));
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

test('cli init: --sign flag generates Ed25519 keys, writes .env.nlpwa, configures nlpwa.config.js, and injects sw.js', () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-init-sign-'));
  const res = spawnSync(process.execPath, [CLI, 'init', '--dir', root, '--sign'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  // 1. .env.nlpwa is created with private key
  assert.ok(existsSync(join(root, '.env.nlpwa')), '.env.nlpwa exists');
  const envContent = readFileSync(join(root, '.env.nlpwa'), 'utf8');
  assert.match(envContent, /NLPWA_PRIVATE_KEY="[A-Za-z0-9+/=]+"/);

  // 2. nlpwa.config.js contains publicKey and verifyHashes: 'strict'
  const configContent = readFileSync(join(root, 'nlpwa.config.js'), 'utf8');
  assert.match(configContent, /publicKey:\s*'[A-Za-z0-9+/=]{44}'/);
  assert.match(configContent, /verifyHashes:\s*'strict'/);

  // 3. sw.js has self.__NLPWA_PUBLIC_KEY injected
  const swContent = readFileSync(join(root, 'sw.js'), 'utf8');
  assert.match(swContent, /^self\.__NLPWA_PUBLIC_KEY\s*=\s*'[A-Za-z0-9+/=]{44}';/m);

  // Extract public key from config and sw.js and verify they match
  const pubFromConfig = configContent.match(/publicKey:\s*'([^']+)'/)[1];
  const pubFromSw = swContent.match(/self\.__NLPWA_PUBLIC_KEY\s*=\s*'([^']+)'/)[1];
  assert.equal(pubFromConfig, pubFromSw, 'publicKey in config matches sw.js');
});

test('cli update: injects publicKey from config into target sw.js and signs manifests', () => {
  const root = makeProject();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

  writeFileSync(join(root, '.env.nlpwa'), `NLPWA_PRIVATE_KEY="${privB64}"\n`);
  writeFileSync(join(root, 'dist/sw.js'), '// original sw content\n');
  writeFileSync(
    join(root, 'nlpwa.config.js'),
    `export default { version: '1.0.0', publicKey: '${pubB64}', precache: ['/index.html'] };\n`,
  );

  const res = runUpdate(root);
  assert.equal(res.status, 0, res.stderr);

  // Check that sw.js in dist got publicKey injected
  const swContent = readFileSync(join(root, 'dist/sw.js'), 'utf8');
  assert.match(swContent, new RegExp(`self\\.__NLPWA_PUBLIC_KEY = '${pubB64.replace(/[+*]/g, '\\$&')}';`));

  // Check that manifests are signed
  const version = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8'));
  const info = JSON.parse(readFileSync(join(root, 'dist/api/update/info.json'), 'utf8'));
  assert.ok(version.signature, 'version.json is signed');
  assert.ok(info.signature, 'info.json is signed');
});

test('cli update: auto-derives publicKey from .env.nlpwa when missing in config and syncs config and sw.js', () => {
  const root = makeProject();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

  writeFileSync(join(root, '.env.nlpwa'), `NLPWA_PRIVATE_KEY="${privB64}"\n`);
  writeFileSync(join(root, 'dist/sw.js'), '// dist sw\n');

  // Config without publicKey
  writeFileSync(
    join(root, 'nlpwa.config.js'),
    `export default {\n  version: '1.0.0',\n  precache: ['/index.html']\n};\n`,
  );

  const res = runUpdate(root);
  assert.equal(res.status, 0, res.stderr);

  // Config should now have auto-derived publicKey synced
  const updatedConfig = readFileSync(join(root, 'nlpwa.config.js'), 'utf8');
  assert.ok(updatedConfig.includes(`publicKey: '${pubB64}'`));

  // sw.js should have publicKey injected
  const updatedSw = readFileSync(join(root, 'dist/sw.js'), 'utf8');
  assert.ok(updatedSw.includes(`self.__NLPWA_PUBLIC_KEY = '${pubB64}';`));

  // Manifests should be signed
  const version = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8'));
  assert.ok(version.signature);
});

test('cli update: warns when publicKey is configured but signing key is missing', () => {
  const root = makeProject();
  writeFileSync(
    join(root, 'nlpwa.config.js'),
    `export default { version: '1.0.0', publicKey: 'abc123dummykey', precache: ['/index.html'] };\n`,
  );

  const res = runUpdate(root);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /Warning: publicKey is configured, but no signing key/);
  assert.match(res.stderr, /Generated manifests are unsigned/);

  // Manifests must not have signature
  const version = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8'));
  assert.equal(version.signature, undefined);
});

test('cli keys:generate: automatically synchronizes publicKey into existing nlpwa.config.js and sw.js', () => {
  const root = makeProject();
  writeFileSync(join(root, 'sw.js'), '// root sw\n');
  const res = spawnSync(
    process.execPath,
    [CLI, 'keys:generate', '--config', join(root, 'nlpwa.config.js'), '--dir', root],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);

  const configContent = readFileSync(join(root, 'nlpwa.config.js'), 'utf8');
  assert.match(configContent, /publicKey:\s*'[A-Za-z0-9+/=]{44}'/);
  assert.match(configContent, /verifyHashes:\s*'strict'/);

  const swContent = readFileSync(join(root, 'sw.js'), 'utf8');
  assert.match(swContent, /^self\.__NLPWA_PUBLIC_KEY\s*=\s*'[A-Za-z0-9+/=]{44}';/m);
});

test('syncSourceConfigPublicKey: handles variable exports, preserves explicit verifyHashes, and returns boolean', () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-sync-'));
  const testKey = '0123456789abcdef0123456789abcdef0123456789a=';

  // 1. Variable export config: const config = { ... }; export default config;
  const varConfigPath = join(root, 'var.config.js');
  writeFileSync(
    varConfigPath,
    `const config = {\n  version: '1.0.0',\n};\nexport default config;\n`,
    'utf8'
  );
  const updatedVar = syncSourceConfigPublicKey(varConfigPath, testKey);
  assert.equal(updatedVar, true, 'returns true when variable object config is updated');
  const varContent = readFileSync(varConfigPath, 'utf8');
  assert.ok(varContent.includes(`publicKey: '${testKey}'`));
  assert.ok(varContent.includes(`verifyHashes: 'strict'`));

  // 2. Preserves explicit verifyHashes: 'warn'
  const warnConfigPath = join(root, 'warn.config.js');
  writeFileSync(
    warnConfigPath,
    `export default {\n  version: '1.0.0',\n  verifyHashes: 'warn',\n};\n`,
    'utf8'
  );
  const updatedWarn = syncSourceConfigPublicKey(warnConfigPath, testKey);
  assert.equal(updatedWarn, true, 'returns true when config is updated');
  const warnContent = readFileSync(warnConfigPath, 'utf8');
  assert.ok(warnContent.includes(`publicKey: '${testKey}'`));
  assert.ok(warnContent.includes(`verifyHashes: 'warn'`), 'explicit verifyHashes: warn was preserved');
  assert.ok(!warnContent.includes(`verifyHashes: 'strict'`), 'did not overwrite with strict');

  // 3. Unrecognized structure returns false
  const funcConfigPath = join(root, 'func.config.js');
  writeFileSync(
    funcConfigPath,
    `export default function createConfig() { return { version: '1.0.0' }; }\n`,
    'utf8'
  );
  const updatedFunc = syncSourceConfigPublicKey(funcConfigPath, testKey);
  assert.equal(updatedFunc, false, 'returns false when no matching insertion point is found');
  const funcContent = readFileSync(funcConfigPath, 'utf8');
  assert.ok(!funcContent.includes('publicKey'), 'file was left untouched');
});

test('cli update: warns with manual snippet when source config cannot be auto-injected', () => {
  const root = makeProject();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

  writeFileSync(join(root, '.env.nlpwa'), `NLPWA_PRIVATE_KEY="${privB64}"\n`);
  writeFileSync(
    join(root, 'nlpwa.config.js'),
    `export default function defineConfig() {\n  return { version: '1.0.0', precache: ['/index.html'] };\n}\n`,
  );

  const res = runUpdate(root);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /Notice: Could not automatically inject publicKey/);
  assert.match(res.stderr, /Please add to your config manually: publicKey:/);
});

test('cli update: preserves developer explicit verifyHashes: warn when signing key is present', () => {
  const root = makeProject();
  const { privateKey } = generateKeyPairSync('ed25519');
  const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

  writeFileSync(join(root, '.env.nlpwa'), `NLPWA_PRIVATE_KEY="${privB64}"\n`);
  writeFileSync(
    join(root, 'nlpwa.config.js'),
    `export default {\n  version: '1.0.0',\n  verifyHashes: 'warn',\n  precache: ['/index.html']\n};\n`,
  );

  const res = runUpdate(root);
  assert.equal(res.status, 0, res.stderr);

  const configContent = readFileSync(join(root, 'nlpwa.config.js'), 'utf8');
  assert.match(configContent, /verifyHashes:\s*'warn'/);
  assert.ok(!configContent.includes("verifyHashes: 'strict'"), 'did not overwrite warn with strict');
});

test('cli init: does not include verifyHashes in scaffolded config, and keys:generate injects strict', () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-init-'));
  const resInit = spawnSync(
    process.execPath,
    [CLI, 'init', '--dir', root],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(resInit.status, 0, resInit.stderr);

  const initConfig = readFileSync(join(root, 'nlpwa.config.js'), 'utf8');
  assert.ok(!initConfig.includes('verifyHashes'), 'scaffolded starter config does not set verifyHashes');

  // Now run keys:generate on this project
  const resKeys = spawnSync(
    process.execPath,
    [CLI, 'keys:generate', '--config', join(root, 'nlpwa.config.js'), '--dir', root],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(resKeys.status, 0, resKeys.stderr);

  const keyConfig = readFileSync(join(root, 'nlpwa.config.js'), 'utf8');
  assert.match(keyConfig, /publicKey:\s*'[A-Za-z0-9+/=]{44}'/);
  assert.match(keyConfig, /verifyHashes:\s*'strict'/, 'keys:generate injects strict when verifyHashes was absent');
  assert.ok(!keyConfig.includes("verifyHashes: 'warn'"), 'does not contain contradictory warn');
});







