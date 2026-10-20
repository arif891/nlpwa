# NLPWA Example Showcase Application

An interactive, production-ready demonstration of the **NLPWA** native-like Progressive Web App framework.

---

## Features Demonstrated

1. **Zero-Latency Precaching**: App shell files (`index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `assets/`) are installed into the versioned offline cache on first launch.
2. **Interactive Strategy Playground**:
   - `stale-while-revalidate` on `/api/feed.json` (instant stale response with silent background revalidation).
   - `cache-first` on `/assets/theme.json` (instant responses from local store).
   - `network-first` on `/api/profile.json` (fresh server data with cache fallback).
   - `network-only` on `/api/live/time.json` (strictly fresh real-time data bypassing SW cache).
   - `cache-only` on `/offline-data.json` (guaranteed offline access).
3. **Response Header Observability**: Every intercepted request displays the `X-Cache-Status` response header (`offline-cache`, `runtime-cache`, `network`, `stale`, or `offline-fallback`).
4. **Over-The-Air (OTA) Delta Updates**:
   - Check for updates button using `NLPWAClient.requestUpdateCheck()`.
   - Simulated release trigger that advertises a new version, automatically stages the delta cache in the background, and displays an update banner.
   - Click "Apply & Reload" calling `NLPWAClient.applyUpdate()` to atomically activate the new version.

---

## Running the Example

Start the local showcase server:

```bash
# Run server (defaults to port 81, or PORT=3000 node example/server.js)
node example/server.js
```

Then open your browser at:
[http://localhost:81](http://localhost:81)

---

## CLI Commands in this Directory

```bash
# Regenerate update API endpoints and manifest hashes:
nlpwa update --dir ./example --config ./example/nlpwa.config.js
```
