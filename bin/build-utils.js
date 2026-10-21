import { writeFileSync, readFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { incrementPatch } from '../src/shared/version.js';
import { resolveUpdateEndpoints } from '../src/shared/url.js';
import {
  hashFile,
  computeManifestHash,
  deriveAppVersion,
  getApiDiskPath,
  collectTrackedFiles,
} from '../src/cli/core/manifest.js';
import {
  findConfigFile,
  loadConfig,
  syncSourceConfigVersion,
  resolvePackageVersion,
} from '../src/cli/core/config.js';
import { signManifestSync } from '../src/cli/core/signing.js';

function tryLoadLocalEnv() {
  const envCandidates = ['.env.nlpwa', '.env.local', '.env'];
  for (const file of envCandidates) {
    const envPath = resolve(process.cwd(), file);
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_0-9]+)=(.*)$/);
        if (match) {
          const key = match[1];
          let val = match[2].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch {}
  }
}

/**
 * Shared manifest and update API emission pipeline for bundler plugins (Vite, Rollup, Webpack).
 */
export function emitBuildManifests({
  options = {},
  defaultDistDir = './dist',
  rawConfig = {},
  targetConfigPath = null,
  targetVersion = null,
} = {}) {
  const distDir = resolve(process.cwd(), options.distDir ?? defaultDistDir);
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  // 1. Track offline cached files, expanding any precache globs
  const { files, expandedPrecache } = collectTrackedFiles(rawConfig, distDir);

  // 2. Resolve version
  let appVersion;
  if (options.version) {
    appVersion = options.version;
  } else if (options.autoIncrement === true) {
    appVersion = targetVersion || incrementPatch(rawConfig.version ?? '1.0.0');
  } else if (options.deriveVersion === false) {
    appVersion = targetVersion || rawConfig.version || '1.0.0';
  } else {
    appVersion = deriveAppVersion(rawConfig, files);
  }

  // Sync version back to source config if requested
  const shouldSyncSource =
    options.syncSource === true ||
    (options.autoIncrement === true && options.syncSource !== false);
  if (shouldSyncSource && targetConfigPath && existsSync(targetConfigPath)) {
    syncSourceConfigVersion(targetConfigPath, appVersion);
  }

  const {
    signingKey: _extractedSigningKey,
    plugins: _plugins,
    onPush: _onPush,
    onNotificationClick: _onNotificationClick,
    ...safeConfig
  } = rawConfig;

  // Sanitize routes to strip non-serializable functions / plugins
  const sanitizedRoutes = (rawConfig.routes || []).map((route) => {
    const {
      plugins,
      requestWillFetch,
      cachedResponseWillBeUsed,
      cacheWillUpdate,
      fetchDidFail,
      fetchDidSucceed,
      cacheDidUpdate,
      cacheKeyWillBeUsed,
      ...safeRoute
    } = route;
    return safeRoute;
  });

  const runtimeConfig = {
    ...safeConfig,
    version: appVersion,
    configPath: rawConfig.configPath || '/api/update/config.json',
    updateAPI: rawConfig.updateAPI || {
      version: '/api/update/version.json',
      info: '/api/update/info.json',
    },
    precache: expandedPrecache,
    routes: sanitizedRoutes,
  };

  // 3. Emit config file in distDir with expanded precache list
  const cleanConfigPath = runtimeConfig.configPath.replace(/^\/+/, '');
  const configJsonPath = resolve(distDir, cleanConfigPath);
  mkdirSync(dirname(configJsonPath), { recursive: true });
  const jsonIndent = options.pretty ? 2 : 0;
  writeFileSync(configJsonPath, JSON.stringify(runtimeConfig, null, jsonIndent), 'utf8');

  // Update hash and size for config.json now that it is written
  const configEntry = files.find((f) => f.path === runtimeConfig.configPath);
  const configSize = statSync(configJsonPath).size;
  if (configEntry) {
    configEntry.hash = hashFile(configJsonPath);
    configEntry.size = configSize;
  } else {
    files.unshift({
      path: runtimeConfig.configPath,
      hash: hashFile(configJsonPath),
      size: configSize,
    });
  }

  // 4. Emit update API outputs
  const { versionEndpoint, infoEndpoint } = resolveUpdateEndpoints(runtimeConfig);

  const versionOut = getApiDiskPath(distDir, versionEndpoint, runtimeConfig.base);
  const infoOut = getApiDiskPath(distDir, infoEndpoint, runtimeConfig.base);

  mkdirSync(dirname(versionOut), { recursive: true });
  mkdirSync(dirname(infoOut), { recursive: true });

  tryLoadLocalEnv();

  const signingKey =
    process.env.NLPWA_SIGNING_KEY ||
    process.env.NLPWA_PRIVATE_KEY ||
    options.signingKey ||
    options.privateKey ||
    rawConfig.signingKey;

  const sequence = rawConfig.sequence !== undefined
    ? Number(rawConfig.sequence)
    : (signingKey ? Date.now() : undefined);
  const minVer = rawConfig.minVersion || rawConfig.minSupportedVersion;
  const blockedVersions = Array.isArray(rawConfig.blockedVersions) ? rawConfig.blockedVersions : undefined;
  const channel = rawConfig.channel;
  const rolloutPercent = rawConfig.rolloutPercent !== undefined ? Number(rawConfig.rolloutPercent) : undefined;

  const versionPayload = {
    version: appVersion,
    ...(sequence !== undefined ? { sequence } : {}),
    ...(minVer ? { minVersion: minVer } : {}),
    ...(blockedVersions ? { blockedVersions } : {}),
    ...(channel ? { channel } : {}),
    ...(rolloutPercent !== undefined ? { rolloutPercent } : {}),
  };
  const infoPayload = {
    version: appVersion,
    ...(sequence !== undefined ? { sequence } : {}),
    ...(minVer ? { minVersion: minVer } : {}),
    ...(blockedVersions ? { blockedVersions } : {}),
    ...(channel ? { channel } : {}),
    ...(rolloutPercent !== undefined ? { rolloutPercent } : {}),
    files,
  };

  if (signingKey) {
    try {
      const infoSig = signManifestSync(infoPayload, signingKey);
      const versionSig = signManifestSync(versionPayload, signingKey);
      if (infoSig) {
        infoPayload.signature = infoSig;
        versionPayload.signature = versionSig;
      }
    } catch (err) {
      console.warn('[NLPWA] Warning: Could not sign manifest with Ed25519:', err?.message || err);
    }
  }

  writeFileSync(versionOut, JSON.stringify(versionPayload, null, jsonIndent), 'utf8');
  writeFileSync(infoOut, JSON.stringify(infoPayload, null, jsonIndent), 'utf8');

  const contentHash = computeManifestHash(files, runtimeConfig);

  return { appVersion, runtimeConfig, files, distDir, cleanConfigPath, contentHash };
}

export {
  incrementPatch,
  resolveUpdateEndpoints,
  hashFile,
  computeManifestHash,
  deriveAppVersion,
  getApiDiskPath,
  collectTrackedFiles,
  findConfigFile,
  loadConfig,
  syncSourceConfigVersion,
  resolvePackageVersion,
};
