import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { c, printBanner } from '../ui/terminal.js';
import { resolveUpdateEndpoints } from '../../shared/url.js';
import { getApiDiskPath } from '../core/manifest.js';
import { findConfigFile, loadConfig } from '../core/config.js';

export async function cmdStatus(args) {
  printBanner();
  const targetDir = resolve(process.cwd(), args.dir ?? (existsSync(resolve(process.cwd(), 'dist')) ? 'dist' : '.'));
  console.log(`${c.bold}[NLPWA] Status for ${c.cyan}${targetDir}${c.reset}\n`);

  const configFile = findConfigFile(args.config, process.cwd(), [targetDir]);
  let sourceConfig = null;
  if (configFile) {
    try {
      sourceConfig = await loadConfig(configFile);
    } catch (err) {
      if (process.env.DEBUG) console.debug('[NLPWA] Could not load source config:', err?.message || err);
    }
  }

  const rawConfigPath = sourceConfig?.configPath || '/api/update/config.json';
  const cleanConfigPath = rawConfigPath.replace(/^\/+/, '');
  let configJsonPath = resolve(targetDir, cleanConfigPath);
  if (!existsSync(configJsonPath) && existsSync(resolve(targetDir, 'config.json'))) {
    configJsonPath = resolve(targetDir, 'config.json');
  }

  let activeConfig = null;
  if (existsSync(configJsonPath)) {
    try {
      activeConfig = JSON.parse(readFileSync(configJsonPath, 'utf8'));
    } catch (err) {
      if (process.env.DEBUG) console.debug('[NLPWA] Could not parse config.json:', err?.message || err);
    }
  }

  const { versionEndpoint, infoEndpoint } = resolveUpdateEndpoints(activeConfig ?? sourceConfig ?? {});
  const versionOut = getApiDiskPath(targetDir, versionEndpoint, activeConfig?.base || sourceConfig?.base);
  const infoOut = getApiDiskPath(targetDir, infoEndpoint, activeConfig?.base || sourceConfig?.base);

  let versionData = null;
  let infoData = null;

  if (existsSync(versionOut)) {
    try {
      versionData = JSON.parse(readFileSync(versionOut, 'utf8'));
    } catch (err) {
      if (process.env.DEBUG) console.debug('[NLPWA] Could not parse version.json:', err?.message || err);
    }
  }
  if (existsSync(infoOut)) {
    try {
      infoData = JSON.parse(readFileSync(infoOut, 'utf8'));
    } catch (err) {
      if (process.env.DEBUG) console.debug('[NLPWA] Could not parse info.json:', err?.message || err);
    }
  }

  console.log(`  ${c.dim}Source Config         :${c.reset} ${configFile ? c.green + configFile + c.reset : c.yellow + 'not found' + c.reset}`);
  console.log(`  ${c.dim}Deployed config.json  :${c.reset} ${existsSync(configJsonPath) ? c.green + configJsonPath + c.reset : c.red + 'missing' + c.reset}`);
  console.log(`  ${c.dim}Version API Endpoint  :${c.reset} ${existsSync(versionOut) ? c.green + versionOut + c.reset : c.red + 'missing' + c.reset}`);
  console.log(`  ${c.dim}Info API Endpoint     :${c.reset} ${existsSync(infoOut) ? c.green + infoOut + c.reset : c.red + 'missing' + c.reset}`);
  console.log(`  ${c.dim}App Version           :${c.reset} ${versionData?.version ? c.cyan + c.bold + versionData.version + c.reset : (activeConfig?.version ?? 'unknown')}`);
  console.log(`  ${c.dim}Tracked Files in Info :${c.reset} ${infoData?.files ? infoData.files.length : 0}`);

  const swFile = resolve(targetDir, 'sw.js');
  const clientFile = resolve(targetDir, 'client.js');
  console.log(`  ${c.dim}Service Worker (sw.js):${c.reset} ${existsSync(swFile) ? c.green + 'present' + c.reset : c.yellow + 'missing' + c.reset}`);
  console.log(`  ${c.dim}Client SDK (client.js):${c.reset} ${existsSync(clientFile) ? c.green + 'present' + c.reset : c.yellow + 'missing' + c.reset}\n`);
}
