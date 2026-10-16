#!/usr/bin/env node
/**
 * nlpwa — CLI tool for the NLPWA framework
 *
 * Commands:
 *   nlpwa init    Scaffold or drop NLPWA files (sw.js, client.js, config.js)
 *                 into any target project directory.
 *   nlpwa update  Reads config.js, auto-increments app patch version,
 *                 generates runtime config.json, hashes ONLY tracked offline files,
 *                 and emits update API endpoints (/api/update/version & info).
 *
 * Usage:
 *   nlpwa init   [--dir <path>]
 *   nlpwa update [options]
 */

import { createHash }                            from 'node:crypto';
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, relative, resolve, dirname }      from 'node:path';
import { fileURLToPath, pathToFileURL }          from 'node:url';
import { incrementPatch }                        from '../src/shared/version.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ANSI colour helpers — gracefully disabled in non-TTY environments */
const isTTY = process.stdout.isTTY;
const c = {
  reset:  isTTY ? '\x1b[0m'  : '',
  bold:   isTTY ? '\x1b[1m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  green:  isTTY ? '\x1b[32m' : '',
  cyan:   isTTY ? '\x1b[36m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red:    isTTY ? '\x1b[31m' : '',
  blue:   isTTY ? '\x1b[34m' : '',
};

/** SHA-256 first 8 hex chars — matches UPDATE-PROTOCOL.md */
function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

/**
 * Resolve project version from package.json in current working directory.
 */
function resolvePackageVersion() {
  try {
    const pkgPath = resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Locate developer configuration file (config.js, nlpwa.config.js, config.json).
 */
function findConfigFile(explicitPath) {
  if (explicitPath) {
    const resolved = resolve(explicitPath);
    if (existsSync(resolved)) return resolved;
    throw new Error(`Specified config file not found: ${explicitPath}`);
  }

  const candidates = [
    './config.js',
    './nlpwa.config.js',
    './src/config.js',
    './config.json',
    './nlpwa.config.json',
  ];

  for (const candidate of candidates) {
    const resolved = resolve(process.cwd(), candidate);
    if (existsSync(resolved)) return resolved;
  }

  return null;
}

/**
 * Load configuration from a JS or JSON file.
 */
async function loadConfig(configPath) {
  if (!configPath) return {};

  if (configPath.endsWith('.json')) {
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  }

  // Dynamic import for .js / .mjs config files
  const fileUrl = pathToFileURL(configPath).href;
  const mod = await import(fileUrl);
  return mod.default ?? mod;
}

/**
 * Update version string inside config.js or config.json source file.
 */
function syncSourceConfigVersion(configPath, newVersion) {
  if (!configPath || !existsSync(configPath)) return;

  try {
    const content = readFileSync(configPath, 'utf8');
    if (configPath.endsWith('.json')) {
      const parsed = JSON.parse(content);
      parsed.version = newVersion;
      writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
    } else {
      // Regex replace version: '...' or version: "..."
      const updated = content.replace(/(version\s*:\s*['"])([^'"]+)(['"])/, `$1${newVersion}$3`);
      if (updated !== content) {
        writeFileSync(configPath, updated, 'utf8');
      }
    }
  } catch (err) {
    console.warn(`${c.yellow}Could not sync version to source config: ${err.message}${c.reset}`);
  }
}

/** Parse argv key=value and flag-style args */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--pretty') {
      args.pretty = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else if (arg.startsWith('-')) {
      console.warn(`${c.yellow}Warning: Unknown flag "${arg}" — did you mean "--${arg.slice(1)}"?${c.reset}`);
    } else {
      args._.push(arg);
    }
  }
  return args;
}

// ── Banner ────────────────────────────────────────────────────────────────────

function printBanner() {
  console.log(`
${c.bold}${c.cyan}  ███╗   ██╗██╗     ██████╗ ██╗    ██╗ █████╗${c.reset}
${c.bold}${c.cyan}  ████╗  ██║██║     ██╔══██╗██║    ██║██╔══██╗${c.reset}
${c.bold}${c.cyan}  ██╔██╗ ██║██║     ██████╔╝██║ █╗ ██║███████║${c.reset}
${c.bold}${c.cyan}  ██║╚██╗██║██║     ██╔═══╝ ██║███╗██║██╔══██║${c.reset}
${c.bold}${c.cyan}  ██║ ╚████║███████╗██║     ╚███╔███╔╝██║  ██║${c.reset}
${c.bold}${c.cyan}  ╚═╝  ╚═══╝╚══════╝╚═╝      ╚══╝╚══╝ ╚═╝  ╚═╝${c.reset}
${c.dim}  Native-like PWA Framework CLI${c.reset}
`);
}

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  printBanner();
  console.log(`${c.bold}USAGE${c.reset}
  nlpwa <command> [options]

${c.bold}COMMANDS${c.reset}
  ${c.green}init${c.reset}     Scaffolds or copies sw.js, client.js, and config.js
           into your target project directory for immediate drop-in use.
  ${c.green}update${c.reset}   Reads config.js, auto-increments app patch version,
           generates config.json, hashes ONLY tracked offline files,
           and emits update API endpoints (/api/update/version & info).

${c.bold}OPTIONS (init)${c.reset}
  ${c.cyan}--dir${c.reset}     <path>      Target directory to drop files into (default: ./)

${c.bold}OPTIONS (update)${c.reset}
  ${c.cyan}--config${c.reset}  <path>      Config file path            (default: auto-detect ./config.js)
  ${c.cyan}--dir${c.reset}     <path>      Target build directory      (default: ./dist or ./)
  ${c.cyan}--version${c.reset} <semver>    Explicit version override   (default: auto-increment patch)
  ${c.cyan}--pretty${c.reset}              Pretty-print JSON output    (2-space indent)
  ${c.cyan}--help, -h${c.reset}            Show this help message

${c.bold}EXAMPLES${c.reset}
  # Drop NLPWA files into current project root
  npx nlpwa init

  # Drop NLPWA files into a public/ directory
  npx nlpwa init --dir ./public

  # Run after build to auto-increment app version and generate update endpoints
  nlpwa update --dir ./dist
`);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdInit(args) {
  printBanner();
  console.log(`${c.bold}nlpwa init${c.reset}\n`);

  const targetDir = resolve(args.dir ?? '.');
  mkdirSync(targetDir, { recursive: true });

  const outDir = resolve(__dirname, '../out');
  const filesToCopy = [
    { src: 'sw.js',        dest: 'sw.js',        required: true },
    { src: 'client.js',    dest: 'client.js',    required: true },
    { src: 'config.js',    dest: 'config.js',    required: false, checkExisting: true },
    { src: 'config.json',  dest: 'config.json',  required: false, checkExisting: true },
  ];

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
      console.error(`  ${c.red}X Source file missing:${c.reset} ${srcPath}`);
    }
  }

  console.log(`
${c.bold}${c.green}  NLPWA files initialized successfully!${c.reset}

  ${c.bold}Next steps:${c.reset}
  1. Add the client script to your HTML:
     ${c.cyan}<script type="module" src="/client.js"></script>${c.reset}

  2. Configure routes & offline precache in ${c.bold}config.js${c.reset}

  3. When deploying updates, run:
     ${c.cyan}npx nlpwa update${c.reset}
`);
}

async function cmdUpdate(args) {
  let configPath = null;
  try {
    configPath = findConfigFile(args.config);
  } catch (err) {
    console.error(`${c.red}X ${err.message}${c.reset}`);
    process.exit(1);
  }

  const rawConfig = await loadConfig(configPath);
  const targetDir = resolve(args.dir ?? (existsSync('./dist') ? './dist' : '.'));

  // Version resolution & auto-increment patch
  const prevVersion = rawConfig.version ?? resolvePackageVersion() ?? '1.0.0';
  const newVersion = args.version ?? incrementPatch(prevVersion);

  printBanner();
  console.log(`${c.bold}nlpwa update${c.reset}\n`);
  if (configPath) {
    console.log(`  ${c.dim}Config  :${c.reset} ${c.cyan}${configPath}${c.reset}`);
  }
  console.log(`  ${c.dim}Target  :${c.reset} ${c.cyan}${targetDir}${c.reset}`);
  console.log(`  ${c.dim}Version :${c.reset} ${c.yellow}v${prevVersion}${c.reset} → ${c.green}${c.bold}v${newVersion}${c.reset} (patch auto-increment)\n`);

  // Update source config file if version was auto-incremented
  if (!args.version && configPath) {
    syncSourceConfigVersion(configPath, newVersion);
  }

  // Prepare runtime config object
  const runtimeConfig = {
    ...rawConfig,
    version: newVersion,
    configPath: rawConfig.configPath || '/config.json',
    updateAPI: rawConfig.updateAPI || {
      version: '/api/update/version',
      info: '/api/update/info',
    },
    precache: rawConfig.precache || [],
    routes: rawConfig.routes || [],
  };

  mkdirSync(targetDir, { recursive: true });

  // 1. Write runtime config.json into target directory
  const configJsonPath = resolve(targetDir, 'config.json');
  const compact = Boolean(args.compact || args.minify);
  const jsonIndent = compact ? 0 : 2;
  writeFileSync(configJsonPath, JSON.stringify(runtimeConfig, null, jsonIndent), 'utf8');
  console.log(`  ${c.green}+${c.reset} ${c.cyan}/config.json${c.reset} (generated from config.js)`);

  // 2. Track ONLY offline cached files and the config file
  const trackedUrlPaths = Array.from(new Set([
    runtimeConfig.configPath,
    ...(runtimeConfig.precache || []),
  ]));

  const startMs = Date.now();
  const files = [];

  for (const urlPath of trackedUrlPaths) {
    // Map URL path to file path on disk
    let relPath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
    if (relPath === '' || relPath.endsWith('/')) {
      relPath += 'index.html';
    }

    const diskPath = resolve(targetDir, relPath);

    if (existsSync(diskPath)) {
      const hash = hashFile(diskPath);
      files.push({ path: urlPath, hash });
      console.log(`  ${c.green}+${c.reset} ${c.dim}${urlPath.padEnd(25)}${c.reset} ${c.blue}${hash}${c.reset}`);
    } else {
      console.warn(`  ${c.yellow}! Offline file not found on disk:${c.reset} ${diskPath} (${urlPath})`);
    }
  }

  // 3. Emit update API outputs
  let versionEndpoint = '/api/update/version';
  let infoEndpoint = '/api/update/info';

  if (runtimeConfig.updateAPI) {
    if (typeof runtimeConfig.updateAPI === 'object' && !Array.isArray(runtimeConfig.updateAPI)) {
      versionEndpoint = runtimeConfig.updateAPI.version || versionEndpoint;
      infoEndpoint = runtimeConfig.updateAPI.info || infoEndpoint;
    } else if (Array.isArray(runtimeConfig.updateAPI)) {
      const v = runtimeConfig.updateAPI.find(e => e.type === 'version');
      const i = runtimeConfig.updateAPI.find(e => e.type === 'info');
      if (v?.endpoint) versionEndpoint = v.endpoint;
      if (i?.endpoint) infoEndpoint = i.endpoint;
    }
  }

  // Helper to resolve API output file path
  function getApiDiskPath(baseDir, endpoint) {
    let clean = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    if (clean.endsWith('.json')) {
      return resolve(baseDir, clean);
    }
    return resolve(baseDir, clean, 'index.json');
  }

  const versionOut = getApiDiskPath(targetDir, versionEndpoint);
  const infoOut = getApiDiskPath(targetDir, infoEndpoint);

  mkdirSync(dirname(versionOut), { recursive: true });
  mkdirSync(dirname(infoOut), { recursive: true });

  const versionPayload = { version: newVersion };
  const infoPayload = { version: newVersion, files };

  const versionJson = JSON.stringify(versionPayload, null, jsonIndent);
  const infoJson = JSON.stringify(infoPayload, null, jsonIndent);

  writeFileSync(versionOut, versionJson, 'utf8');
  writeFileSync(infoOut, infoJson, 'utf8');

  // Also sync to workspace root api/ directory if it exists and targetDir is different
  const rootApiDir = resolve(process.cwd(), 'api');
  if (targetDir !== process.cwd() && existsSync(rootApiDir)) {
    const rootVersionOut = getApiDiskPath(process.cwd(), versionEndpoint);
    const rootInfoOut = getApiDiskPath(process.cwd(), infoEndpoint);
    mkdirSync(dirname(rootVersionOut), { recursive: true });
    mkdirSync(dirname(rootInfoOut), { recursive: true });
    writeFileSync(rootVersionOut, versionJson, 'utf8');
    writeFileSync(rootInfoOut, infoJson, 'utf8');
  }

  const elapsedMs = Date.now() - startMs;

  console.log(`
${c.bold}${c.green}  Update outputs written successfully${c.reset}
  ${c.dim}Tracked Offline Files :${c.reset} ${files.length}
  ${c.dim}Runtime Config        :${c.reset} ${configJsonPath}
  ${c.dim}Version API Endpoint  :${c.reset} ${versionOut}
  ${c.dim}Info API Endpoint     :${c.reset} ${infoOut}
  ${c.dim}Elapsed Time          :${c.reset} ${elapsedMs}ms
`);
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const argv    = process.argv.slice(2);
const args    = parseArgs(argv);
const command = args._[0];

if (!command || args.help) {
  printHelp();
  process.exit(0);
}

switch (command) {
  case 'init':
    await cmdInit(args);
    break;

  case 'update':
    await cmdUpdate(args);
    break;

  default:
    console.error(`${c.red}X Unknown command:${c.reset} ${command}`);
    console.error(`  Run ${c.cyan}nlpwa --help${c.reset} to see available commands.`);
    process.exit(1);
}
