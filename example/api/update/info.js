import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_INFO = '/tmp/nlpwa-info.json';

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  try {
    if (existsSync(TMP_INFO)) {
      const data = JSON.parse(readFileSync(TMP_INFO, 'utf8'));
      return res.status(200).json(data);
    }
    const infoFile = resolve(__dirname, 'info.json');
    if (existsSync(infoFile)) {
      const data = JSON.parse(readFileSync(infoFile, 'utf8'));
      return res.status(200).json(data);
    }
  } catch (err) {
    // fallback
  }

  return res.status(200).json({ version: '1.0.0', files: [] });
}
