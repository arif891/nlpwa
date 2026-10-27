import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_CONFIG = '/tmp/nlpwa-config.json';

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  try {
    if (existsSync(TMP_CONFIG)) {
      const data = JSON.parse(readFileSync(TMP_CONFIG, 'utf8'));
      return res.status(200).json(data);
    }
    const cfgFile = resolve(__dirname, 'config.json');
    if (existsSync(cfgFile)) {
      const data = JSON.parse(readFileSync(cfgFile, 'utf8'));
      return res.status(200).json(data);
    }
  } catch (err) {
    // fallback
  }

  return res.status(200).json({ version: '1.0.0' });
}
