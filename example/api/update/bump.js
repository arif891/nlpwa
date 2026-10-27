import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_VER = '/tmp/nlpwa-version.json';
const TMP_INFO = '/tmp/nlpwa-info.json';
const TMP_CONFIG = '/tmp/nlpwa-config.json';

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let currentVersion = '1.0.0';
    if (existsSync(TMP_VER)) {
      try {
        currentVersion = JSON.parse(readFileSync(TMP_VER, 'utf8')).version || '1.0.0';
      } catch {}
    } else {
      const verFile = resolve(__dirname, 'version.json');
      if (existsSync(verFile)) {
        try {
          currentVersion = JSON.parse(readFileSync(verFile, 'utf8')).version || '1.0.0';
        } catch {}
      }
    }

    const parts = currentVersion.split('.').map(Number);
    const newVersion = `${parts[0]}.${parts[1]}.${(parts[2] || 0) + 1}`;

    writeFileSync(TMP_VER, JSON.stringify({ version: newVersion }, null, 2), 'utf8');

    // Update config in /tmp
    let configData = { version: newVersion };
    const configFile = resolve(__dirname, 'config.json');
    if (existsSync(TMP_CONFIG)) {
      try { configData = JSON.parse(readFileSync(TMP_CONFIG, 'utf8')); } catch {}
    } else if (existsSync(configFile)) {
      try { configData = JSON.parse(readFileSync(configFile, 'utf8')); } catch {}
    }
    configData.version = newVersion;
    const configStr = JSON.stringify(configData, null, 2);
    writeFileSync(TMP_CONFIG, configStr, 'utf8');

    const newHash = createHash('sha256').update(configStr).digest('hex').slice(0, 32);

    // Update info in /tmp
    let infoData = { version: newVersion, files: [] };
    const infoFile = resolve(__dirname, 'info.json');
    if (existsSync(TMP_INFO)) {
      try { infoData = JSON.parse(readFileSync(TMP_INFO, 'utf8')); } catch {}
    } else if (existsSync(infoFile)) {
      try { infoData = JSON.parse(readFileSync(infoFile, 'utf8')); } catch {}
    }
    infoData.version = newVersion;
    if (infoData.files && infoData.files.length > 0) {
      const cfgEntry = infoData.files.find(f => f.path === '/api/update/config.json') || infoData.files[0];
      cfgEntry.hash = newHash;
    }
    writeFileSync(TMP_INFO, JSON.stringify(infoData, null, 2), 'utf8');

    return res.status(200).json({
      success: true,
      version: newVersion,
      previousVersion: currentVersion,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
