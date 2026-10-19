import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { c, printBanner } from '../ui/terminal.js';

export async function cmdGenerateOffline(args) {
  printBanner();
  const targetDir = resolve(process.cwd(), args.dir ?? (existsSync(resolve(process.cwd(), 'dist')) ? 'dist' : '.'));
  mkdirSync(targetDir, { recursive: true });
  const filename = args.dest ?? 'offline.html';
  const outPath = resolve(targetDir, filename);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Offline — App Unavailable</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: rgba(30, 41, 59, 0.7);
      --border: rgba(255, 255, 255, 0.1);
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2.5rem 2rem;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 1.5rem;
      color: var(--muted);
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      letter-spacing: -0.025em;
    }
    p {
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.5;
      margin-bottom: 2rem;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--primary);
      color: #0f172a;
      font-weight: 600;
      font-size: 0.95rem;
      padding: 0.75rem 1.75rem;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      text-decoration: none;
      transition: background-color 0.15s ease, transform 0.05s ease;
      width: 100%;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn:active { transform: scale(0.98); }
    .status {
      margin-top: 1.25rem;
      font-size: 0.8rem;
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef4444;
      display: inline-block;
    }
    .dot.online { background: #22c55e; }
  </style>
</head>
<body>
  <div class="card">
    <svg class="icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 4.243a9 9 0 01-12.728 0m0 0l2.829-2.829m-2.829 2.829L3 21M8.464 15.536a5 5 0 010-7.072m0 0l2.829 2.829M12 12h.01" />
    </svg>
    <h1>You are currently offline</h1>
    <p>This page requires an active internet connection or hasn't been cached yet. Check your network or try reloading.</p>
    <button class="btn" onclick="window.location.reload()">Retry Connection</button>
    <div class="status">
      <span class="dot" id="dot"></span>
      <span id="status-text">Disconnected</span>
    </div>
  </div>

  <script>
    function updateOnlineStatus() {
      const isOnline = navigator.onLine;
      const dot = document.getElementById('dot');
      const text = document.getElementById('status-text');
      if (isOnline) {
        dot.classList.add('online');
        text.textContent = 'Connection restored! Reloading...';
        setTimeout(() => window.location.reload(), 1000);
      } else {
        dot.classList.remove('online');
        text.textContent = 'Disconnected';
      }
    }
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();
  </script>
</body>
</html>
`;

  writeFileSync(outPath, html, 'utf8');
  console.log(`  ${c.green}+${c.reset} ${c.bold}Generated offline fallback page:${c.reset} ${outPath}\n`);
}
