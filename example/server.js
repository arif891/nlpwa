import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const PORT = parseInt(process.env.PORT || '3000', 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;

  // ── Dynamic Mock API Endpoints ───────────────────────────────────────────
  if (pathname === '/api/live/time.json') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache',
    });
    return res.end(JSON.stringify({
      status: 'live',
      strategy: 'network-only',
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      server: 'NLPWA Edge Server (Node.js)',
      message: 'Fresh real-time timestamp generated on demand.',
    }));
  }

  // Simulate an update release by bumping version.json and info.json to 1.0.1
  if (pathname === '/api/simulate-bump' && req.method === 'POST') {
    try {
      const versionFile = join(__dirname, 'api/update/version.json');
      const infoFile = join(__dirname, 'api/update/info.json');
      const configFile = join(__dirname, 'api/update/config.json');

      const current = JSON.parse(readFileSync(versionFile, 'utf8'));
      const parts = current.version.split('.').map(Number);
      const newVersion = `${parts[0]}.${parts[1]}.${(parts[2] || 0) + 1}`;

      writeFileSync(versionFile, JSON.stringify({ version: newVersion }, null, 2), 'utf8');

      // Update config.json and compute real SHA-256 digest
      const configData = JSON.parse(readFileSync(configFile, 'utf8'));
      configData.version = newVersion;
      const configStr = JSON.stringify(configData, null, 2);
      writeFileSync(configFile, configStr, 'utf8');

      const { createHash } = await import('node:crypto');
      const newHash = createHash('sha256').update(configStr).digest('hex').slice(0, 32);

      if (existsSync(infoFile)) {
        const info = JSON.parse(readFileSync(infoFile, 'utf8'));
        info.version = newVersion;
        if (info.files && info.files.length > 0) {
          const cfgEntry = info.files.find(f => f.path === '/api/update/config.json') || info.files[0];
          cfgEntry.hash = newHash;
        }
        writeFileSync(infoFile, JSON.stringify(info, null, 2), 'utf8');
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, newVersion }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Reset version back to 1.0.0 for clean testing
  if (pathname === '/api/reset-version' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      const versionFile = join(__dirname, 'api/update/version.json');
      const infoFile = join(__dirname, 'api/update/info.json');
      const configFile = join(__dirname, 'api/update/config.json');

      const configData = JSON.parse(readFileSync(configFile, 'utf8'));
      configData.version = '1.0.0';
      const configStr = JSON.stringify(configData, null, 2);
      writeFileSync(configFile, configStr, 'utf8');

      const { createHash } = await import('node:crypto');
      const baseHash = createHash('sha256').update(configStr).digest('hex').slice(0, 32);

      writeFileSync(versionFile, JSON.stringify({ version: '1.0.0' }, null, 2), 'utf8');
      if (existsSync(infoFile)) {
        const info = JSON.parse(readFileSync(infoFile, 'utf8'));
        info.version = '1.0.0';
        if (info.files && info.files.length > 0) {
          const cfgEntry = info.files.find(f => f.path === '/api/update/config.json') || info.files[0];
          cfgEntry.hash = baseHash;
        }
        writeFileSync(infoFile, JSON.stringify(info, null, 2), 'utf8');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, version: '1.0.0' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ── Static File Serving ──────────────────────────────────────────────────
  if (pathname === '/' || pathname.endsWith('/')) {
    pathname += 'index.html';
  }

  const projectRoot = resolve(__dirname, '..');
  let filePath;
  if (pathname.startsWith('/out/')) {
    filePath = resolve(projectRoot, pathname.replace(/^\/+/, ''));
  } else if (pathname.startsWith('/plugins/')) {
    filePath = resolve(projectRoot, 'out', pathname.replace(/^\/+/, ''));
  } else {
    filePath = resolve(__dirname, pathname.replace(/^\/+/, ''));
  }

  // Prevent directory traversal
  if (!filePath.startsWith(projectRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = readFileSync(filePath);

    res.writeHead(200, {
      'Content-Type': contentType,
      // For sw.js and config.json, prevent browser HTTP caching so updates are instantaneous
      'Cache-Control': filePath.endsWith('sw.js') || filePath.endsWith('config.json')
        ? 'no-cache, no-store'
        : 'public, max-age=3600',
    });
    return res.end(content);
  }

  // 404 Not Found
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n🚀 NLPWA Showcase Server running at: http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop.\n`);
});
