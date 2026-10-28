import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TMP_VER = '/tmp/nlpwa-version.json';
const TMP_INFO = '/tmp/nlpwa-info.json';
const TMP_CONFIG = '/tmp/nlpwa-config.json';

function getCookieVersion(req) {
  const cookie = req.headers?.cookie || '';
  const match = cookie.match(/(?:^|;\s*)nlpwa_version=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let file = req.query?.file;
  if (!file) {
    const urlPath = (req.url || '').split('?')[0];
    const segment = urlPath.split('/').pop();
    if (['config.json', 'version.json', 'info.json'].includes(segment)) {
      file = segment;
    }
  }

  const cookieVer = getCookieVersion(req);

  // 1. Version check endpoint
  if (file === 'version.json') {
    if (cookieVer) {
      return res.status(200).json({ version: cookieVer });
    }
    try {
      if (existsSync(TMP_VER)) {
        return res.status(200).send(readFileSync(TMP_VER, 'utf8'));
      }
      const f = resolve(__dirname, 'version.json');
      if (existsSync(f)) {
        return res.status(200).send(readFileSync(f, 'utf8'));
      }
    } catch {}
    return res.status(200).json({ version: '1.0.0' });
  }

  // 2. Info / manifest endpoint
  if (file === 'info.json') {
    try {
      let infoData = null;
      if (existsSync(TMP_INFO)) {
        infoData = JSON.parse(readFileSync(TMP_INFO, 'utf8'));
      } else {
        const f = resolve(__dirname, 'info.json');
        if (existsSync(f)) {
          infoData = JSON.parse(readFileSync(f, 'utf8'));
        }
      }
      if (infoData) {
        if (cookieVer) {
          infoData.version = cookieVer;
          // Calculate dynamic hash for config.json under this version
          const cfgStr = JSON.stringify({ version: cookieVer }, null, 2);
          const cfgHash = createHash('sha256').update(cfgStr).digest('hex').slice(0, 32);
          if (infoData.files && infoData.files.length > 0) {
            const entry = infoData.files.find(f => f.path === '/api/update/config.json') || infoData.files[0];
            entry.hash = cfgHash;
          }
        }
        return res.status(200).json(infoData);
      }
    } catch {}
    return res.status(200).json({ version: cookieVer || '1.0.0', files: [] });
  }

  // 3. Config endpoint (config.json)
  if (file === 'config.json' || !file) {
    try {
      let data = null;
      if (existsSync(TMP_CONFIG)) {
        data = JSON.parse(readFileSync(TMP_CONFIG, 'utf8'));
      } else {
        const f = resolve(__dirname, 'config.json');
        if (existsSync(f)) {
          data = JSON.parse(readFileSync(f, 'utf8'));
        }
      }

      if (data) {
        if (cookieVer) {
          data.version = cookieVer;
        }
        return res.status(200).json(data);
      }
    } catch {}
    return res.status(200).json({ version: cookieVer || '1.0.0' });
  }

  return res.status(404).json({ error: 'Not found' });
}
