import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TMP_VER = '/tmp/nlpwa-version.json';
const TMP_INFO = '/tmp/nlpwa-info.json';
const TMP_CONFIG = '/tmp/nlpwa-config.json';

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

  // 1. Version check endpoint
  if (file === 'version.json') {
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
      if (existsSync(TMP_INFO)) {
        return res.status(200).send(readFileSync(TMP_INFO, 'utf8'));
      }
      const f = resolve(__dirname, 'info.json');
      if (existsSync(f)) {
        return res.status(200).send(readFileSync(f, 'utf8'));
      }
    } catch {}
    return res.status(200).json({ version: '1.0.0', files: [] });
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
        // Sync dev mode flag if nlpwa.config.js has dev: true or process.env.NLPWA_DEV is set
        let isDev = Boolean(data.dev);
        if (!isDev) {
          if (process.env.NLPWA_DEV === 'true' || process.env.NLPWA_DEV === '1') {
            isDev = true;
          } else {
            try {
              const nlpwaConfigFile = resolve(__dirname, '../../nlpwa.config.js');
              if (existsSync(nlpwaConfigFile)) {
                const src = readFileSync(nlpwaConfigFile, 'utf8');
                if (/\bdev\s*:\s*true\b/.test(src)) {
                  isDev = true;
                }
              }
            } catch {}
          }
        }
        if (isDev) {
          data.dev = true;
        } else if (data.dev) {
          delete data.dev;
        }
        return res.status(200).json(data);
      }
    } catch {}
    return res.status(200).json({ version: '1.0.0' });
  }

  return res.status(404).json({ error: 'Not found' });
}
