import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_VER = '/tmp/nlpwa-version.json';
const TMP_INFO = '/tmp/nlpwa-info.json';
const TMP_CONFIG = '/tmp/nlpwa-config.json';

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Clear cookie across all environments
  res.setHeader('Set-Cookie', 'nlpwa_version=; Path=/; Max-Age=0; SameSite=Lax');

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    for (const f of [TMP_VER, TMP_INFO, TMP_CONFIG]) {
      if (existsSync(f)) {
        try { unlinkSync(f); } catch {}
      }
    }

    try {
      const versionFile = resolve(__dirname, 'version.json');
      const infoFile = resolve(__dirname, 'info.json');
      const configFile = resolve(__dirname, 'config.json');

      if (existsSync(configFile)) {
        const configData = JSON.parse(readFileSync(configFile, 'utf8'));
        configData.version = '1.0.0';
        const configStr = JSON.stringify(configData, null, 2);
        writeFileSync(configFile, configStr, 'utf8');

        const baseHash = createHash('sha256').update(configStr).digest('hex').slice(0, 32);

        if (existsSync(versionFile)) {
          writeFileSync(versionFile, JSON.stringify({ version: '1.0.0' }, null, 2), 'utf8');
        }

        if (existsSync(infoFile)) {
          const info = JSON.parse(readFileSync(infoFile, 'utf8'));
          info.version = '1.0.0';
          if (info.files && info.files.length > 0) {
            const cfgEntry = info.files.find(f => f.path === '/api/update/config.json') || info.files[0];
            cfgEntry.hash = baseHash;
          }
          writeFileSync(infoFile, JSON.stringify(info, null, 2), 'utf8');
        }
      }
    } catch {}

    return res.status(200).json({
      success: true,
      version: '1.0.0',
      message: 'Version reset to v1.0.0',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
