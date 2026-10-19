import { writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { c, printBanner } from '../ui/terminal.js';
import { incrementPatch } from '../../shared/version.js';
import { resolveUpdateEndpoints } from '../../shared/url.js';
import {
  hashFile,
  deriveAppVersion,
  collectTrackedFiles,
  getApiDiskPath,
} from '../core/manifest.js';
import {
  findConfigFile,
  loadConfig,
  syncSourceConfigVersion,
  resolvePackageVersion,
} from '../core/config.js';

export async function cmdUpdate(args) {
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

  const isPatch = Boolean(args.patch || args['bump-patch'] || args.bumpPatch);
  if (args.version) {
    newVersion = args.version;
    versionNote = 'explicit override';
  } else if (isPatch) {
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

  const isClean = Boolean(args.clean);
  const defaultVersionEndpoint = isClean ? '/api/update/version' : '/api/update/version.json';
  const defaultInfoEndpoint = isClean ? '/api/update/info' : '/api/update/info.json';

  // Prepare runtime config object
  const runtimeConfig = {
    ...rawConfig,
    version: newVersion,
    configPath: rawConfig.configPath || '/config.json',
    updateAPI: rawConfig.updateAPI || {
      version: defaultVersionEndpoint,
      info: defaultInfoEndpoint,
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

  // Update hash and size for config.json now that it is written
  const configEntry = files.find(f => f.path === (runtimeConfig.configPath || '/config.json'));
  const configSize = statSync(configJsonPath).size;
  if (configEntry) {
    configEntry.hash = hashFile(configJsonPath);
    configEntry.size = configSize;
  } else {
    files.unshift({
      path: runtimeConfig.configPath || '/config.json',
      hash: hashFile(configJsonPath),
      size: configSize,
    });
  }

  for (const { path: urlPath, hash } of files) {
    console.log(`  ${c.green}+${c.reset} ${c.dim}${urlPath.padEnd(25)}${c.reset} ${c.blue}${hash}${c.reset}`);
  }
  for (const { path: urlPath, diskPath } of missing) {
    console.warn(`  ${c.yellow}! Offline file not found on disk:${c.reset} ${diskPath} (${urlPath})`);
  }

  // 3. Emit update API outputs
  const { versionEndpoint, infoEndpoint } = resolveUpdateEndpoints(runtimeConfig);

  const versionOut = getApiDiskPath(targetDir, versionEndpoint, runtimeConfig.base);
  const infoOut = getApiDiskPath(targetDir, infoEndpoint, runtimeConfig.base);

  mkdirSync(dirname(versionOut), { recursive: true });
  mkdirSync(dirname(infoOut), { recursive: true });

  const versionPayload = {
    version: newVersion,
    ...(rawConfig.minVersion ? { minVersion: rawConfig.minVersion } : {}),
  };
  const infoPayload = {
    version: newVersion,
    ...(rawConfig.minVersion ? { minVersion: rawConfig.minVersion } : {}),
    files,
  };

  const versionJson = JSON.stringify(versionPayload, null, jsonIndent);
  const infoJson = JSON.stringify(infoPayload, null, jsonIndent);

  writeFileSync(versionOut, versionJson, 'utf8');
  writeFileSync(infoOut, infoJson, 'utf8');

  // Sync to workspace root api/ directory ONLY if explicitly requested via --sync-root-api
  const shouldSyncRootApi = Boolean(args['sync-root-api'] || args.syncRootApi);
  const rootApiDir = resolve(process.cwd(), 'api');
  if (shouldSyncRootApi && targetDir !== process.cwd() && existsSync(rootApiDir)) {
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
