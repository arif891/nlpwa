# NLPWA — CLI & Bundler Integration

The NLPWA command-line tool (`nlpwa`) and bundler plugins automate manifest generation, deterministic content hashing, update API emission, and plugin installation.

---

## Table of Contents

- [Overview & Invocation](#overview--invocation)
- [Commands](#commands)
  - [`init`](#nlpwa-init)
  - [`add`](#nlpwa-add)
  - [`update` (or `build`)](#nlpwa-update-or-nlpwa-build)
  - [`status`](#nlpwa-status)
  - [`generate-offline`](#nlpwa-generate-offline)
- [Command Flags Reference](#command-flags-reference)
- [Deterministic Versioning & Integrity Hashing](#deterministic-versioning--integrity-hashing)
- [Bundler Plugins](#bundler-plugins)
  - [Vite](#vite)
  - [Rollup](#rollup)
  - [Bundler Options](#bundler-options)
- [Integration with Other Build Systems](#integration-with-other-build-systems)
  - [Webpack, Parcel, esbuild, Next.js](#webpack-parcel-esbuild-nextjs)
  - [CI/CD Workflow](#cicd-workflow)

---

## Overview & Invocation

You can run `nlpwa` via `npx` without prior installation:

```bash
npx nlpwa <command> [options]
```

Or install it locally in your project:

```bash
npm install -D nlpwa
npx nlpwa --help
```

---

## Commands

### `nlpwa init`

Scaffolds the drop-in NLPWA engine, starter configuration, W3C Web App Manifest, and starter PNG/SVG icons into the target directory.

```bash
# Initialize in current directory
npx nlpwa init

# Target a public or dist directory with custom metadata
npx nlpwa init --dir ./public --name "My Awesome App" --theme-color "#6366f1"
```

**Files created:**
- `sw.js` — Standalone, pre-bundled Service Worker engine.
- `client.js` — Standalone, pre-bundled client runtime SDK (defining `window.NLPWAClient`).
- `nlpwa.config.js` — Starter configuration pre-populated with shell precache and route rules.
- `assets/other/manifest.webmanifest` — W3C Web App Manifest with `standalone` display mode, maskable icons, and OS launch handler.
- `assets/image/icon/icon-192.png` — Standard 192x192 PNG app icon (pure Node.js encoded, zero dependencies).
- `assets/image/icon/icon-512.png` — High-resolution 512x512 PNG app icon.
- `assets/image/icon/icon.svg` — Scalable vector icon.

**Init Options:**
- `--dir <path>` — Target directory (default: `.`)
- `--name <name>` — App display name (auto-detected from `package.json` if omitted)
- `--short-name <short>` — App short name for home screen and shortcuts
- `--theme-color <hex>` — Brand theme color for mobile status bars (default: `#0ea5e9`)
- `--bg-color <hex>` — Background color for splash screens (default: `#0f172a`)
- `--no-manifest` — Skip creating `manifest.webmanifest` and icon files

---

### `nlpwa add`

Installs pre-bundled standalone plugins directly into your project's `plugins/` directory for no-build static sites.

```bash
# Add official Background Sync plugin
npx nlpwa add sync

# Specify target directory
npx nlpwa add sync --dir ./public
```

**Files added for `sync`:**
- `<dir>/plugins/sync.sw.js` — Standalone IIFE Service Worker plugin (`NLPWASyncSW.BackgroundSyncPlugin`).
- `<dir>/plugins/sync.client.js` — Standalone IIFE Client SDK (`NLPWASyncClient.syncClient`).

See [docs/PLUGINS.md](PLUGINS.md) for full plugin documentation.

---

### `nlpwa update` (or `nlpwa build`)

Processes your application assets, calculates deterministic SHA-256 content hashes, compiles `config.js` into runtime `config.json`, and emits the two-tier update manifests (`version.json` and `info.json`).

```bash
# Default build for ./dist
npx nlpwa update --dir ./dist

# Specify custom config file
npx nlpwa update --dir ./dist --config ./src/nlpwa.config.js
```

**Outputs generated in target directory:**
- `<dir>/api/update/config.json` — Compiled runtime config for the Service Worker.
- `<dir>/api/update/version.json` — Tier 1 lightweight version endpoint:
  ```json
  { "version": "1.0.0-a1b2c3d4e5f6" }
  ```
- `<dir>/api/update/info.json` — Tier 2 full manifest with asset digests:
  ```json
  {
    "version": "1.0.0-a1b2c3d4e5f6",
    "files": [
      { "path": "/index.html", "hash": "d41d8cd98f00b204e9800998ecf8427e" },
      { "path": "/styles.css", "hash": "8b1a9953c4611296a827abf8c47804d7" }
    ]
  }
  ```

*(Note: If custom update endpoints configured in `config.js` do not end in `.json`, e.g. `/api/update/version`, `nlpwa` automatically outputs directory `index.json` files).*

---

### `nlpwa status`

Inspects the current build directory, verifies manifest hashes against physical disk files, and reports the current content version.

```bash
npx nlpwa status --dir ./dist
```

**Example output:**
```
NLPWA Status:
  Directory:       ./dist
  Config Version:  1.0.0
  Active Version:  1.0.0-a1b2c3d4e5f6
  Precache Files:  5 tracked
  Integrity:       All 5 file digests verified OK
```

---

### `nlpwa generate-offline`

Generates an offline fallback HTML page starter if one is not already present:

```bash
npx nlpwa generate-offline --dir ./public
```

---

## Command Flags Reference

| Flag | Default | Description |
|---|---|---|
| `--dir <path>` | `./dist` or `./` | Target output directory containing built web assets. |
| `--config <path>` | auto-detect | Path to config file (`nlpwa.config.js`, `config.js`, or `config.json`). |
| `--name <string>` | auto-detected | Application name for PWA manifest (`init`). |
| `--short-name <string>` | auto-detected | Application short name for PWA manifest (`init`). |
| `--theme-color <hex>` | `#0ea5e9` | PWA brand theme color for manifest & status bar (`init`). |
| `--bg-color <hex>` | `#0f172a` | PWA background color for splash screen (`init`). |
| `--no-manifest` | `false` | Skip creating manifest and icons during `init`. |
| `--version <string>` | hash-derived | Override auto-derived version with explicit string (e.g. `2.0.0` or git SHA). |
| `--bump-patch` | `false` | Increment semver patch version (`1.0.0` → `1.0.1`) instead of appending content hash. |
| `--sync-source` | `false` | Write updated version back into source `config.js` (opt-in). |
| `--pretty` | `false` | Formats output JSON files with 2-space indentation (compact by default). |
| `--help`, `-h` | — | Displays the command-line help screen. |

---

## Deterministic Versioning & Integrity Hashing

### Version Computation Rules

By default, NLPWA calculates the app version deterministically:

$$\text{Version} = \text{Base Version} + \text{"-"} + \text{First 12 Hex Characters of Combined Manifest Hash}$$

Example: `1.0.0-a1b2c3d4e5f6`

### Key Advantages

1. **Idempotent Builds:** Re-running `nlpwa update` on unchanged assets produces the exact same version string. Dev server reloads or repeated CI runs will never broadcast spurious "Update Available" banners to users.
2. **Rollback Friendly:** Reverting a release to a previous git commit naturally restores the earlier version string, allowing clients to roll back cleanly.
3. **No Source File Mutation:** The source `config.js` remains untouched, keeping your git tree clean and preventing infinite re-trigger loops in bundler watch processes.
4. **Operational Transport Verification:** Every staged file is hashed with SHA-256. The Service Worker validates downloaded bytes against the same-origin manifest before moving them into the active cache, protecting against incomplete downloads, proxy glitches, captive portal HTML intercepts, and soft-404 errors.

---

## Bundler Plugins

NLPWA includes first-class Rollup and Vite plugins that run `nlpwa update` automatically on every bundle completion.

### Vite

```javascript
// vite.config.js
import { defineConfig } from 'vite';
import nlpwa from 'nlpwa/vite';

export default defineConfig({
  plugins: [
    nlpwa({
      config: './src/config.js',
      distDir: './dist',
      pretty: true,
    }),
  ],
});
```

### Rollup

```javascript
// rollup.config.js
import nlpwa from 'nlpwa/rollup';

export default {
  input: 'src/main.js',
  output: { dir: 'dist', format: 'esm' },
  plugins: [
    nlpwa({
      config: './config.js',
      distDir: './dist',
    }),
  ],
};
```

### Bundler Options

Both plugins accept the same options object:

```typescript
interface NLPWABundlerOptions {
  config?: string;      // Path to config file (default: auto-detected)
  distDir?: string;     // Output directory (default: './dist')
  version?: string;     // Explicit version override
  bumpPatch?: boolean;  // Bump semver patch (default: false)
  syncSource?: boolean; // Sync version back to source file (default: false)
  pretty?: boolean;     // Pretty-print JSON outputs (default: false)
}
```

---

## Integration with Other Build Systems

### Webpack, Parcel, esbuild, Next.js

For bundlers without a dedicated plugin, add `nlpwa update` as an npm `postbuild` script in `package.json`:

```json
{
  "scripts": {
    "build": "webpack --mode production",
    "postbuild": "nlpwa update --dir ./dist"
  }
}
```

### CI/CD Workflow

In GitHub Actions or GitLab CI, build your application before running tests or deployments:

```yaml
# .github/workflows/deploy.yml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 20
  - run: npm ci
  - run: npm run build
  - run: npx nlpwa update --dir ./dist
  - run: npx nlpwa status --dir ./dist
```
