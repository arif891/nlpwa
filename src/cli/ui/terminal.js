const isTTY = typeof process !== 'undefined' && process.stdout?.isTTY;

export const c = {
  reset:  isTTY ? '\x1b[0m'  : '',
  bold:   isTTY ? '\x1b[1m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  green:  isTTY ? '\x1b[32m' : '',
  cyan:   isTTY ? '\x1b[36m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red:    isTTY ? '\x1b[31m' : '',
  blue:   isTTY ? '\x1b[34m' : '',
};

export function printBanner() {
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

export function printHelp() {
  printBanner();
  console.log(`${c.bold}USAGE${c.reset}
  nlpwa <command> [options]

${c.bold}COMMANDS${c.reset}
  ${c.green}init${c.reset}              Scaffolds or copies sw.js, client.js, and nlpwa.config.js
                   into your target project directory for immediate drop-in use.
  ${c.green}add <plugin>${c.reset}       Installs a pre-built plugin (e.g. "sync") into your project
                   for no-build drop-in usage (e.g. plugins/sync.sw.js).
  ${c.green}generate-offline${c.reset}  Generates a zero-dependency, self-contained offline.html
                   fallback page with auto-reconnect and retry button.
  ${c.green}update${c.reset}            Reads nlpwa.config.js, derives content-hash app version,
                   generates api/update/config.json, hashes ONLY tracked offline files,
                   and emits update API endpoints (/api/update/version & info).
  ${c.green}build${c.reset}             Alias for "update" — builds manifest and update endpoints.
  ${c.green}status${c.reset}            Inspects manifest version, update endpoints, and tracked files.

${c.bold}OPTIONS (update / build)${c.reset}
  --config <path>  Path to developer config file (default: ./nlpwa.config.js)
  --dir <path>     Directory holding production assets (default: ./dist or ./public)
  --version <v>    Explicit version override (bypasses automatic content-hash derivation)
  --patch          Auto-increments base semver patch before computing hash (e.g. 1.0.0 -> 1.0.1)
  --clean          Emits directory-style endpoints (/api/update/version/index.json)
  --pretty         Formats output JSON with 2-space indentation (default: false / minified)
  --help, -h       Show this help message
`);
}
