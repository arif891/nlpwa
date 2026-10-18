#!/usr/bin/env node
/**
 * nlpwa — CLI tool for the NLPWA framework
 *
 * Commands:
 *   nlpwa init    Scaffold or drop NLPWA files (sw.js, client.js, config.js)
 *                 into any target project directory.
 *   nlpwa update  Reads config.js, derives app version from manifest content hash,
 *                 generates runtime config.json, hashes ONLY tracked offline files,
 *                 and emits update API endpoints (/api/update/version & info).
 *
 * Usage:
 *   nlpwa init   [--dir <path>]
 *   nlpwa update [options]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashFile,
  incrementPatch,
  deriveAppVersion,
  findConfigFile,
  loadConfig,
  syncSourceConfigVersion,
  resolveUpdateEndpoints,
  getApiDiskPath,
  collectTrackedFiles,
} from './build-utils.js';

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
  ${c.green}update${c.reset}   Reads config.js, derives content-hash app version,
           generates config.json, hashes ONLY tracked offline files,
           and emits update API endpoints (/api/update/version & info).
  ${c.green}build${c.reset}    Alias for "update" — builds manifest and update endpoints.

${c.bold}OPTIONS (init)${c.reset}
  ${c.cyan}--dir${c.reset}     <path>      Target directory to drop files into (default: ./)

${c.bold}OPTIONS (update)${c.reset}
  ${c.cyan}--config${c.reset}      <path>      Config file path            (default: auto-detect ./config.js)
  ${c.cyan}--dir${c.reset}         <path>      Target build directory      (default: ./dist or ./)
  ${c.cyan}--version${c.reset}     <string>    Explicit version override   (default: manifest-hash derived)
  ${c.cyan}--bump-patch${c.reset}              Increment semver patch version instead of content hash
  ${c.cyan}--sync-source${c.reset}             Update version in source config file
  ${c.cyan}--pretty${c.reset}                  Pretty-print JSON output    (2-space indent)
  ${c.cyan}--help, -h${c.reset}                Show this help message

${c.bold}EXAMPLES${c.reset}
  # Drop NLPWA files into current project root
  npx nlpwa init

  # Drop NLPWA files into a public/ directory
  npx nlpwa init --dir ./public

  # Generate deterministic update manifest & API endpoints
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
  mkdirSync(targetDir, { recursive: true });

  // 1. Collect tracked files and expand precache globs
  const startMs = Date.now();
  const { files, missing, expandedPrecache } = collectTrackedFiles(rawConfig, targetDir);

  // 2. Version resolution (manifest-hash derived by default)
  const prevVersion = rawConfig.version ?? resolvePackageVersion() ?? '1.0.0';
  let newVersion;
  let versionNote;

  if (args.version) {
    newVersion = args.version;
    versionNote = 'explicit override';
  } else if (args['bump-patch'] || args.bumpPatch) {
    newVersion = incrementPatch(prevVersion);
    versionNote = 'patch auto-increment';
  } else {
    newVersion = deriveAppVersion(rawConfig, files);
    versionNote = 'manifest-hash derived';
  }

  printBanner();
  console.log(`${c.bold}nlpwa update${c.reset}\n`);
  if (configPath) {
    console.log(`  ${c.dim}Config  :${c.reset} ${c.cyan}${configPath}${c.reset}`);
  }
  console.log(`  ${c.dim}Target  :${c.reset} ${c.cyan}${targetDir}${c.reset}`);
  console.log(`  ${c.dim}Version :${c.reset} ${c.green}${c.bold}v${newVersion}${c.reset} (${versionNote})\n`);

  // Update source config file ONLY if explicitly requested via --sync-source
  if ((args['sync-source'] || args.syncSource) && configPath) {
    syncSourceConfigVersion(configPath, newVersion);
    console.log(`  ${c.dim}Source  :${c.reset} ${c.yellow}updated version in ${configPath}${c.reset}\n`);
  }

  // Prepare runtime config object
  const runtimeConfig = {
    ...rawConfig,
    version: newVersion,
    configPath: rawConfig.configPath || '/config.json',
    updateAPI: rawConfig.updateAPI || {
      version: '/api/update/version.json',
      info: '/api/update/info.json',
    },
    precache: expandedPrecache,
    routes: rawConfig.routes || [],
  };

  // 3. Write runtime config into target directory (with expanded precache paths)
  const cleanConfigPath = (runtimeConfig.configPath || '/config.json').replace(/^\/+/, '');
  const configJsonPath = resolve(targetDir, cleanConfigPath);
  mkdirSync(dirname(configJsonPath), { recursive: true });
  const jsonIndent = args.pretty ? 2 : 0;
  writeFileSync(configJsonPath, JSON.stringify(runtimeConfig, null, jsonIndent), 'utf8');
  console.log(`  ${c.green}+${c.reset} ${c.cyan}/${cleanConfigPath}${c.reset} (generated from config.js)`);

  // Update hash for config.json now that it is written
  const configEntry = files.find(f => f.path === (runtimeConfig.configPath || '/config.json'));
  if (configEntry) {
    configEntry.hash = hashFile(configJsonPath);
  } else {
    files.unshift({ path: runtimeConfig.configPath || '/config.json', hash: hashFile(configJsonPath) });
  }

  for (const { path: urlPath, hash } of files) {
    console.log(`  ${c.green}+${c.reset} ${c.dim}${urlPath.padEnd(25)}${c.reset} ${c.blue}${hash}${c.reset}`);
  }
  for (const { path: urlPath, diskPath } of missing) {
    console.warn(`  ${c.yellow}! Offline file not found on disk:${c.reset} ${diskPath} (${urlPath})`);
  }

  // 3. Emit update API outputs
  const { versionEndpoint, infoEndpoint } = resolveUpdateEndpoints(runtimeConfig);

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

  case 'build':
  case 'update':
    await cmdUpdate(args);
    break;

  default:
    console.error(`${c.red}X Unknown command:${c.reset} ${command}`);
    console.error(`  Run ${c.cyan}nlpwa --help${c.reset} to see available commands.`);
    process.exit(1);
}
