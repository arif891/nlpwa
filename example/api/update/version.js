import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_VER = '/tmp/nlpwa-version.json';

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  try {
    if (existsSync(TMP_VER)) {
      const data = JSON.parse(readFileSync(TMP_VER, 'utf8'));
      return res.status(200).json(data);
    }
    const verFile = resolve(__dirname, 'version.json');
    if (existsSync(verFile)) {
      const data = JSON.parse(readFileSync(verFile, 'utf8'));
      return res.status(200).json(data);
    }
  } catch (err) {
    // fallback if parse or read error
  }

  return res.status(200).json({ version: '1.0.0' });
}
