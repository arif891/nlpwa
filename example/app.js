/**
 * NLPWA Interactive Showcase Application Logic
 */

let interceptedCount = 0;
const cacheHits = {
  offline: 0,
  runtime: 0,
  network: 0,
  stale: 0,
};

// ── Logging Helper ─────────────────────────────────────────────────────────
function log(tag, message) {
  const stream = document.getElementById('logStream');
  if (!stream) return;

  const now = new Date();
  const time = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-tag">[${tag}]</span>
    <span class="log-msg">${message}</span>
  `;

  stream.appendChild(entry);
  stream.scrollTop = stream.scrollHeight;
}

// ── Connectivity Monitoring ────────────────────────────────────────────────
function updateNetworkStatus() {
  const dot = document.getElementById('connectionDot');
  const label = document.getElementById('connectionLabel');
  if (!dot || !label) return;

  if (navigator.onLine) {
    dot.className = 'status-dot';
    label.textContent = 'Online';
    log('NET', 'Device connected to network');
  } else {
    dot.className = 'status-dot offline';
    label.textContent = 'Offline';
    log('NET', 'Device went offline — serving strictly from cache');
  }
}

window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);

// ── Strategy Playground ────────────────────────────────────────────────────
async function testStrategy(endpoint, expectedStrategy) {
  log('FETCH', `Requesting ${endpoint} (${expectedStrategy})`);
  const inspector = document.getElementById('inspector');
  const endpointEl = document.getElementById('inspectEndpoint');
  const statusEl = document.getElementById('inspectStatus');
  const latencyEl = document.getElementById('inspectLatency');
  const cacheStatusEl = document.getElementById('inspectCacheStatus');
  const bodyEl = document.getElementById('inspectBody');

  const startTime = performance.now();
  try {
    const res = await fetch(endpoint);
    const duration = Math.round(performance.now() - startTime);
    const cacheStatus = res.headers.get('X-Cache-Status') || 'bypass';

    // Update Metrics
    interceptedCount++;
    document.getElementById('metricRequests').textContent = interceptedCount;

    if (cacheStatus === 'offline-cache') cacheHits.offline++;
    else if (cacheStatus === 'runtime-cache') cacheHits.runtime++;
    else if (cacheStatus === 'stale') cacheHits.stale++;
    else cacheHits.network++;

    const totalHits = cacheHits.offline + cacheHits.runtime + cacheHits.stale;
    const hitRate = Math.round((totalHits / interceptedCount) * 100);
    document.getElementById('metricHitRate').textContent = `${hitRate}%`;

    // Render Preview
    let bodyText;
    try {
      const data = await res.json();
      bodyText = JSON.stringify(data, null, 2);
    } catch {
      bodyText = await res.text();
    }

    endpointEl.textContent = endpoint;
    statusEl.textContent = `${res.status} ${res.statusText || 'OK'}`;
    latencyEl.textContent = `${duration}ms`;

    cacheStatusEl.textContent = cacheStatus;
    cacheStatusEl.className = `header-status-badge status-${cacheStatus.replace(/\s+/g, '-')}`;

    bodyEl.textContent = bodyText;
    inspector.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    log('RES', `${endpoint} → ${res.status} [X-Cache-Status: ${cacheStatus}] in ${duration}ms`);
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    endpointEl.textContent = endpoint;
    statusEl.textContent = 'Failed';
    latencyEl.textContent = `${duration}ms`;
    cacheStatusEl.textContent = 'error';
    cacheStatusEl.className = 'header-status-badge status-offline-fallback';
    bodyEl.textContent = `Network Error: ${err.message}`;
    log('ERR', `Fetch failed for ${endpoint}: ${err.message}`);
  }
}

// ── PWA & SW Initialization ────────────────────────────────────────────────
async function initNLPWA() {
  updateNetworkStatus();

  if (!('serviceWorker' in navigator)) {
    log('WARN', 'Service Workers are not supported in this browser environment');
    document.getElementById('swStatus').textContent = 'Unsupported';
    return;
  }

  log('INIT', 'Registering NLPWA Service Worker...');

  try {
    // If client.js is loaded, use NLPWAClient.register
    if (typeof NLPWAClient !== 'undefined' && NLPWAClient.register) {
      await NLPWAClient.register('/sw.js', {
        autoReload: false,
        onUpdateReady: (data) => {
          showUpdateBanner(data.version);
        },
      });
    } else {
      await navigator.serviceWorker.register('/sw.js');
    }

    const registration = await navigator.serviceWorker.ready;
    document.getElementById('swStatus').textContent = 'Active & Controlled';
    document.getElementById('metricScope').textContent = registration.scope.replace(window.location.origin, '');
    log('SW', `Service Worker active at scope: ${registration.scope}`);
  } catch (err) {
    document.getElementById('swStatus').textContent = 'Registration Failed';
    log('ERR', `Service Worker registration failed: ${err.message}`);
  }

  // Listen for the custom decoupled event
  document.addEventListener('nlpwa:update-ready', (e) => {
    log('UPDATE', `Received update-ready event for v${e.detail.version}`);
    showUpdateBanner(e.detail.version);
  });
}

function showUpdateBanner(version) {
  const banner = document.getElementById('updateBanner');
  const targetVersionEl = document.getElementById('targetVersion');
  if (targetVersionEl) targetVersionEl.textContent = version;
  if (banner) banner.classList.add('show');
}

// ── Button Handlers ────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initNLPWA();

  // Test Buttons
  document.getElementById('btnTestFeed')?.addEventListener('click', () => {
    testStrategy('/api/feed.json', 'stale-while-revalidate');
  });

  document.getElementById('btnTestTheme')?.addEventListener('click', () => {
    testStrategy('/assets/theme.json', 'cache-first');
  });

  document.getElementById('btnTestProfile')?.addEventListener('click', () => {
    testStrategy('/api/profile.json', 'network-first');
  });

  document.getElementById('btnTestLive')?.addEventListener('click', () => {
    testStrategy('/api/live/time.json', 'network-only');
  });

  document.getElementById('btnTestOffline')?.addEventListener('click', () => {
    testStrategy('/offline-data.json', 'cache-only');
  });

  // Manual Update Check
  document.getElementById('btnCheckUpdate')?.addEventListener('click', () => {
    log('CLI', 'Requesting manual update check via client API...');
    if (typeof NLPWAClient !== 'undefined' && NLPWAClient.requestUpdateCheck) {
      NLPWAClient.requestUpdateCheck();
    } else {
      navigator.serviceWorker.controller?.postMessage({ type: 'CHECK_UPDATE' });
    }
  });

  // Simulate Version Bump
  document.getElementById('btnSimulateUpdate')?.addEventListener('click', async () => {
    log('SIM', 'Simulating new application release (v1.0.1)...');
    try {
      const res = await fetch('/api/simulate-bump', { method: 'POST' });
      const data = await res.json();
      log('SIM', `Server advertised new version: v${data.newVersion}`);
      log('SIM', 'Triggering check...');
      if (typeof NLPWAClient !== 'undefined' && NLPWAClient.requestUpdateCheck) {
        NLPWAClient.requestUpdateCheck();
      } else {
        navigator.serviceWorker.controller?.postMessage({ type: 'CHECK_UPDATE' });
      }
    } catch {
      log('SIM', 'Standalone environment: triggering simulated update notification directly');
      showUpdateBanner('1.0.1');
    }
  });

  // Apply Update
  document.getElementById('btnApplyUpdate')?.addEventListener('click', () => {
    log('UPDATE', 'Applying update and reloading application shell...');
    if (typeof NLPWAClient !== 'undefined' && NLPWAClient.applyUpdate) {
      NLPWAClient.applyUpdate();
    } else {
      window.location.reload();
    }
  });

  // Clear Logs
  document.getElementById('btnClearLog')?.addEventListener('click', () => {
    const stream = document.getElementById('logStream');
    if (stream) stream.innerHTML = '';
  });
});
