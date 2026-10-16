#!/usr/bin/env node
/**
 * nlpwa — CLI tool for the NLPWA framework
 *
 * Commands:
 *   nlpwa update  Scan a directory, hash every file, and emit a manifest JSON
 *                 that the NLPWA Service Worker can consume.
 *
 * Usage:
 *   nlpwa update [options]
 *
 * Options:
 *   --dir  <path>      Directory to scan          (default: ./dist)
 *   --out  <path>      Output file path            (default: ./manifest.json)
 *   --version <semver> Version to embed            (default: from package.json or 1.0.0)
 *   --pretty           Pretty-print the JSON output (default: false)
 *   --help, -h         Show this help message
 */

import { createHash }                            from 'node:crypto';
import { readFileSync, writeFileSync, statSync }  from 'node:fs';
import { readdirSync }                           from 'node:fs';
import { join, relative, resolve, dirname }      from 'node:path';
import { fileURLToPath }                         from 'node:url';

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

/** SHA-256 first 8 hex chars — matches the recommended format in UPDATE-PROTOCOL.md */
function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

/** Recursively walk a directory and return all file paths */
function walkDir(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // Include symlinked files so dist directories with symlinks are hashed correctly
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Resolve the version from the consuming project's package.json.
 * Searches from process.cwd() (the user's project root), NOT from __dirname
 * (which would resolve to nlpwa's own package.json).
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
      // Unknown single-dash flag — warn rather than silently treating as a sub-command
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
  ${c.green}update${c.reset}   Scan a directory, compute SHA-256 file hashes, and write a
           manifest JSON compatible with the NLPWA Service Worker.

${c.bold}OPTIONS (update)${c.reset}
  ${c.cyan}--dir${c.reset}  <path>      Directory to scan          (default: ./dist)
  ${c.cyan}--out${c.reset}  <path>      Output manifest file path  (default: ./manifest.json)
  ${c.cyan}--version${c.reset} <semver> Version string to embed    (default: package.json version or 1.0.0)
  ${c.cyan}--pretty${c.reset}           Pretty-print JSON output   (4-space indent)
  ${c.cyan}--help, -h${c.reset}         Show this help message

${c.bold}EXAMPLES${c.reset}
  # Scan ./dist, write manifest.json with version from package.json
  nlpwa update

  # Scan a custom directory and write to a specific path
  nlpwa update --dir ./public --out ./api/manifest.json

  # Set version explicitly and pretty-print
  nlpwa update --dir ./dist --version 2.1.0 --pretty
`);
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdUpdate(args) {
  const dir     = resolve(args.dir     ?? './dist');
  const outFile = resolve(args.out     ?? './manifest.json');
  const pretty  = Boolean(args.pretty);

  const version = args.version
    ?? resolvePackageVersion()
    ?? '1.0.0';

  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch {
    console.error(`${c.red}X Directory not found:${c.reset} ${dir}`);
    console.error(`  Run with ${c.cyan}--dir <path>${c.reset} to specify a directory to scan.`);
    process.exit(1);
  }

  if (!dirStat.isDirectory()) {
    console.error(`${c.red}X Not a directory:${c.reset} ${dir}`);
    process.exit(1);
  }

  printBanner();
  console.log(`${c.bold}nlpwa update${c.reset}\n`);
  console.log(`  ${c.dim}Scanning:${c.reset} ${c.cyan}${dir}${c.reset}`);
  console.log(`  ${c.dim}Output  :${c.reset} ${c.cyan}${outFile}${c.reset}`);
  console.log(`  ${c.dim}Version :${c.reset} ${c.green}${version}${c.reset}\n`);

  const allFiles  = walkDir(dir);
  const fileCount = allFiles.length;

  if (fileCount === 0) {
    console.warn(`${c.yellow}Warning: No files found in:${c.reset} ${dir}`);
  }

  const startMs = Date.now();

  const files = allFiles.map((absPath) => {
    const urlPath = '/' + relative(dir, absPath).replace(/\\/g, '/');
    const hash    = hashFile(absPath);
    console.log(`  ${c.green}+${c.reset} ${c.dim}${urlPath}${c.reset}  ${c.blue}${hash}${c.reset}`);
    return { path: urlPath, hash };
  });

  const manifest = { version, files };
  const json     = pretty
    ? JSON.stringify(manifest, null, 4)
    : JSON.stringify(manifest);

  try {
    writeFileSync(outFile, json, 'utf8');
  } catch (err) {
    console.error(`\n${c.red}X Failed to write output file:${c.reset} ${outFile}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  const elapsedMs = Date.now() - startMs;

  console.log(`
${c.bold}${c.green}  Manifest written${c.reset}
  ${c.dim}Files   :${c.reset} ${fileCount}
  ${c.dim}Time    :${c.reset} ${elapsedMs}ms
  ${c.dim}Output  :${c.reset} ${outFile}
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
  case 'update':
    cmdUpdate(args);
    break;

  default:
    console.error(`${c.red}X Unknown command:${c.reset} ${command}`);
    console.error(`  Run ${c.cyan}nlpwa --help${c.reset} to see available commands.`);
    process.exit(1);
}
