/**
 * NLPWA Interactive Showcase Application Logic - Hybrid Architecture
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

// ── Visual Component Renderers ─────────────────────────────────────────────
function renderFeed(data) {
  const container = document.getElementById('feedContainer');
  if (!container || !data?.articles) return;

  container.innerHTML = data.articles.map((art) => `
    <article class="article-card">
      <div class="article-meta">
        <span class="article-readtime">${art.readTime || '3 min'}</span>
        <span class="status-badge" style="font-size: 0.65rem;">Article #${art.id}</span>
      </div>
      <h3 class="article-title">${art.title}</h3>
      <p class="article-summary">${art.summary}</p>
      <a href="#article-${art.id}" class="article-link">Read article →</a>
    </article>
  `).join('');
}

function renderHandbook(data) {
  const container = document.getElementById('handbookContainer');
  if (!container || !data) return;

  container.innerHTML = `
    <div class="handbook-header">
      <h3 style="font-size: 1.05rem; font-weight: 600;">${data.title}</h3>
      <span class="handbook-badge">Version ${data.version || '1.0'}</span>
    </div>
    <p class="handbook-content">${data.content}</p>
    <ul class="handbook-points">
      <li><strong>Precache Integrity:</strong> Core assets guaranteed available even on initial boot without network.</li>
      <li><strong>Deterministic Eviction:</strong> Scoped LRU runtime cache cleanups prevent browser quota eviction.</li>
      <li><strong>Atomic Staging:</strong> Delta updates download in isolated cache partitions to prevent partial-state crashes.</li>
    </ul>
  `;
}

function renderProfile(data) {
  const container = document.getElementById('profileContainer');
  if (!container || !data) return;

  const initials = (data.name || 'User').split(' ').map(n => n[0]).join('');
  const badgesHtml = (data.badges || []).map(b => `<span class="badge-chip">${b}</span>`).join('');

  container.innerHTML = `
    <div class="profile-avatar-row">
      <div class="profile-avatar">${initials}</div>
      <div>
        <div class="profile-name">${data.name || 'User'}</div>
        <div class="profile-role">${data.role || 'Developer'} (@${data.user || 'user'})</div>
      </div>
    </div>
    <div class="profile-badges">${badgesHtml}</div>
    <div class="profile-stats-grid">
      <div class="stat-item">
        <span class="stat-label">Cached</span>
        <span class="stat-val">${data.stats?.cachedRequests || 0}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Saved</span>
        <span class="stat-val">${data.stats?.bandwidthSaved || '0 MB'}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Uptime</span>
        <span class="stat-val">${data.stats?.uptime || '100%'}</span>
      </div>
    </div>
  `;
}

function renderTheme(data) {
  const container = document.getElementById('themeContainer');
  if (!container || !data) return;

  container.innerHTML = `
    <div class="handbook-header">
      <h3 style="font-size: 1.05rem; font-weight: 600;">Theme: ${data.themeName || 'Default'}</h3>
      <span class="status-badge" style="font-size: 0.65rem;">Cache-First</span>
    </div>
    <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.85rem;">${data.description || 'Static design tokens.'}</p>
    <div class="theme-swatches">
      <div class="swatch" style="background: ${data.primary || '#8b5cf6'};" title="Primary: ${data.primary}"></div>
      <div class="swatch" style="background: ${data.secondary || '#6366f1'};" title="Secondary: ${data.secondary}"></div>
      <div class="swatch" style="background: ${data.accent || '#10b981'};" title="Accent: ${data.accent}"></div>
      <div class="swatch" style="background: ${data.background || '#09090b'};" title="Background: ${data.background}"></div>
    </div>
  `;
}

function renderClock(data) {
  const container = document.getElementById('clockContainer');
  if (!container || !data) return;

  const date = data.timestamp ? new Date(data.timestamp) : new Date();
  const timeStr = date.toTimeString().split(' ')[0];

  container.innerHTML = `
    <div class="clock-display">${timeStr}</div>
    <div class="clock-sub">${data.iso || date.toISOString()}</div>
    <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 1rem;">
      ${data.message || 'Real-time origin timestamp.'}
    </p>
  `;
}

// ── Tab Controller ─────────────────────────────────────────────────────────
function initTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPane = document.getElementById(`pane${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`);
      if (targetPane) targetPane.classList.add('active');
    });
  });
}

// ── Dev HUD Bottom Sheet Controller ────────────────────────────────────────
function initDevSheet() {
  const sheet = document.getElementById('devSheet');
  const header = document.getElementById('sheetHeader');
  const toggleBtn = document.getElementById('btnSheetToggle');
  const hudBtn = document.getElementById('btnToggleHud');

  function toggleSheet(e) {
    if (e && e.target && e.target.closest('.sheet-kpis')) return;
    if (!sheet) return;
    sheet.classList.toggle('collapsed');
    const isCollapsed = sheet.classList.contains('collapsed');
    if (toggleBtn) toggleBtn.textContent = isCollapsed ? '↕' : '—';
  }

  header?.addEventListener('click', toggleSheet);
  toggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSheet();
  });

  hudBtn?.addEventListener('click', () => {
    if (!sheet) return;
    sheet.classList.remove('collapsed');
    sheet.scrollIntoView({ behavior: 'smooth', block: 'end' });
  });
}

// ── Strategy Playground & Fetch Engine ─────────────────────────────────────
async function testStrategy(endpoint, expectedStrategy) {
  log('FETCH', `Requesting ${endpoint} (${expectedStrategy})`);
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
    const reqEl = document.getElementById('metricRequests');
    if (reqEl) reqEl.textContent = interceptedCount;

    if (cacheStatus === 'offline-cache') cacheHits.offline++;
    else if (cacheStatus === 'runtime-cache') cacheHits.runtime++;
    else if (cacheStatus === 'stale') cacheHits.stale++;
    else cacheHits.network++;

    const totalHits = cacheHits.offline + cacheHits.runtime + cacheHits.stale;
    const hitRate = Math.round((totalHits / interceptedCount) * 100);
    const hitRateEl = document.getElementById('metricHitRate');
    if (hitRateEl) hitRateEl.textContent = `${hitRate}%`;

    // Render Preview and UI Tab Content
    let bodyText;
    let data;
    try {
      data = await res.json();
      bodyText = JSON.stringify(data, null, 2);

      // Dynamically update corresponding application tab view
      if (endpoint === '/api/feed.json') renderFeed(data);
      else if (endpoint === '/offline-data.json') renderHandbook(data);
      else if (endpoint === '/api/profile.json') renderProfile(data);
      else if (endpoint === '/assets/theme.json') renderTheme(data);
      else if (endpoint.startsWith('/api/live/')) renderClock(data);
    } catch {
      bodyText = await res.text();
    }

    if (endpointEl) endpointEl.textContent = endpoint;
    if (statusEl) statusEl.textContent = `${res.status} ${res.statusText || 'OK'}`;
    if (latencyEl) latencyEl.textContent = `${duration}ms`;

    if (cacheStatusEl) {
      cacheStatusEl.textContent = cacheStatus;
      cacheStatusEl.className = `status-badge status-${cacheStatus.replace(/\s+/g, '-')}`;
    }

    if (bodyEl) bodyEl.textContent = bodyText;

    log('RES', `${endpoint} → ${res.status} [X-Cache-Status: ${cacheStatus}] in ${duration}ms`);
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    if (endpointEl) endpointEl.textContent = endpoint;
    if (statusEl) statusEl.textContent = 'Failed';
    if (latencyEl) latencyEl.textContent = `${duration}ms`;
    if (cacheStatusEl) {
      cacheStatusEl.textContent = 'error';
      cacheStatusEl.className = 'status-badge status-offline-fallback';
    }
    if (bodyEl) bodyEl.textContent = `Network Error: ${err.message}`;
    log('ERR', `Fetch failed for ${endpoint}: ${err.message}`);
  }
}

// ── Version Badge Management ───────────────────────────────────────────────
async function updateAppVersion() {
  const versionEl = document.getElementById('appVersion') || document.querySelector('.version-badge');
  if (!versionEl) return;

  try {
    if (typeof NLPWAClient !== 'undefined') {
      if (NLPWAClient.getVersion) {
        const info = await NLPWAClient.getVersion();
        if (info?.activeVersion) {
          versionEl.textContent = `v${info.activeVersion}`;
          return;
        }
      }
      if (NLPWAClient.getState) {
        const state = NLPWAClient.getState();
        if (state?.activeVersion || state?.version) {
          versionEl.textContent = `v${state.activeVersion || state.version}`;
          return;
        }
      }
    }

    const res = await fetch('/api/update/version.json').catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      if (data?.version) {
        versionEl.textContent = `v${data.version}`;
      }
    }
  } catch {}
}

// ── PWA & SW Initialization ────────────────────────────────────────────────
async function initNLPWA() {
  updateNetworkStatus();
  updateAppVersion();

  if (typeof NLPWAClient !== 'undefined' && NLPWAClient.subscribe) {
    NLPWAClient.subscribe((state) => {
      const ver = state?.activeVersion || state?.version;
      if (ver) {
        const versionEl = document.getElementById('appVersion') || document.querySelector('.version-badge');
        if (versionEl) versionEl.textContent = `v${ver}`;
      }
    });
  }

  if (!('serviceWorker' in navigator)) {
    log('WARN', 'Service Workers are not supported in this browser environment');
    const swStatus = document.getElementById('swStatus');
    if (swStatus) swStatus.textContent = 'Unsupported';
    return;
  }

  if (window.NLPWA_NO_AUTO_REGISTER) {
    log('INIT', 'Automatic Service Worker registration suppressed by NLPWA_NO_AUTO_REGISTER.');
    return;
  }

  log('INIT', 'Registering NLPWA Service Worker...');

  try {
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
    const swStatus = document.getElementById('swStatus');
    if (swStatus) swStatus.textContent = 'Active & Controlled';
    const scopeEl = document.getElementById('metricScope');
    if (scopeEl) scopeEl.textContent = registration.scope.replace(window.location.origin, '');
    log('SW', `Service Worker active at scope: ${registration.scope}`);
    await updateAppVersion();
  } catch (err) {
    const swStatus = document.getElementById('swStatus');
    if (swStatus) swStatus.textContent = 'Registration Failed';
    log('ERR', `Service Worker registration failed: ${err.message}`);
  }

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

// ── DevTools Push & Background Sync Demonstration ──────────────────────────
let pendingOutbox = [];

function updateOutboxUI() {
  const metric = document.getElementById('metricOutbox');
  if (metric) {
    metric.textContent = String(pendingOutbox.length);
  }
}

function updateNotifButtonUI() {
  const btn = document.getElementById('btnToggleNotif');
  const label = document.getElementById('notifStatusLabel');
  if (!btn || !label) return;

  if (typeof Notification === 'undefined') {
    label.textContent = 'Unsupported';
    btn.disabled = true;
    return;
  }

  if (Notification.permission === 'granted') {
    label.textContent = 'Active';
    btn.classList.add('granted');
    btn.title = 'Push notifications are enabled';
  } else if (Notification.permission === 'denied') {
    label.textContent = 'Denied';
    btn.classList.remove('granted');
    btn.title = 'Push notifications blocked by browser settings';
  } else {
    label.textContent = 'Alerts';
    btn.classList.remove('granted');
    btn.title = 'Click to enable desktop notifications';
  }
}

async function requestNotifPermission() {
  if (typeof Notification === 'undefined') {
    log('PUSH', 'Desktop Notifications API is not supported in this browser.');
    return false;
  }
  if (Notification.permission === 'granted') {
    log('PUSH', 'Notification permission already granted.');
    updateNotifButtonUI();
    return true;
  }
  try {
    const res = await Notification.requestPermission();
    log('PUSH', `Notification permission response: ${res}`);
    updateNotifButtonUI();
    return res === 'granted';
  } catch (err) {
    log('PUSH', `Failed to request notification permission: ${err.message}`);
    return false;
  }
}

function triggerTestPush(text = 'Test push message from DevTools') {
  log('PUSH', `Simulating Push event: "${text}"`);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification('NLPWA Push Alert', {
        body: text,
        icon: '/assets/offline-badge.svg',
        badge: '/assets/offline-badge.svg',
      });
      log('PUSH', 'Dispatched system notification successfully.');
    } catch {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification('NLPWA Push Alert', {
          body: text,
          icon: '/assets/offline-badge.svg',
        });
        log('PUSH', 'Dispatched Service Worker notification.');
      }).catch((e) => log('PUSH', `Notification error: ${e.message}`));
    }
  } else {
    log('PUSH', 'Notification permission not granted. Requesting permission now...');
    requestNotifPermission().then((granted) => {
      if (granted) triggerTestPush(text);
    });
  }
}

async function queueOfflineNote() {
  const noteId = pendingOutbox.length + 1;
  const note = {
    id: Date.now(),
    text: `Offline Note #${noteId} (${new Date().toLocaleTimeString()})`,
    tag: 'test-tag-from-devtools',
  };
  pendingOutbox.push(note);
  updateOutboxUI();
  log('OUTBOX', `Queued offline action [${note.text}]`);

  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg.sync && typeof reg.sync.register === 'function') {
        await reg.sync.register('test-tag-from-devtools');
        log('SYNC', 'Registered background sync tag: "test-tag-from-devtools"');
      }
    } catch (e) {
      log('SYNC', `Background sync notice: ${e.message}`);
    }
  } else {
    log('SYNC', 'Background Sync API ready; outbox will also flush on network reconnection.');
  }
}

function flushOutbox(reason = 'manual') {
  if (pendingOutbox.length === 0) {
    log('SYNC', 'Outbox is empty — nothing to synchronize.');
    return;
  }
  const count = pendingOutbox.length;
  log('SYNC', `Synchronizing ${count} queued outbox action(s) (trigger: ${reason}, tag: "test-tag-from-devtools")...`);
  pendingOutbox = [];
  updateOutboxUI();
  log('SYNC', `Outbox synchronized successfully: ${count} item(s) sent.`);
}

function initNotifAndSync() {
  updateNotifButtonUI();
  updateOutboxUI();

  document.getElementById('btnToggleNotif')?.addEventListener('click', () => {
    requestNotifPermission();
  });

  document.getElementById('btnTestPush')?.addEventListener('click', () => {
    triggerTestPush('Test push message from DevTools');
  });

  document.getElementById('btnCopyPushPayload')?.addEventListener('click', () => {
    const payload = JSON.stringify({
      title: 'DevTools Push',
      body: 'Test push message from DevTools',
      icon: '/assets/offline-badge.svg',
    }, null, 2);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload).then(() => {
        log('PUSH', 'Copied valid JSON push payload to clipboard for DevTools.');
      }).catch(() => {
        log('PUSH', `DevTools JSON Payload: ${payload}`);
      });
    } else {
      log('PUSH', `DevTools JSON Payload: ${payload}`);
    }
  });

  document.getElementById('btnQueueOfflineAction')?.addEventListener('click', () => {
    queueOfflineNote();
  });

  document.getElementById('btnFlushOutbox')?.addEventListener('click', () => {
    flushOutbox('manual');
  });

  window.addEventListener('online', () => {
    if (pendingOutbox.length > 0) {
      flushOutbox('network reconnection');
    }
  });

  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'SYNC_EVENT' || event.data?.tag === 'test-tag-from-devtools') {
      log('SYNC', 'Received background sync signal from Service Worker!');
      flushOutbox('sw-sync-event');
    }
  });
}

// ── Startup & Event Binding ────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initDevSheet();
  initNotifAndSync();
  initNLPWA();

  // Populate default views with initial loads
  testStrategy('/api/feed.json', 'stale-while-revalidate');
  testStrategy('/offline-data.json', 'cache-only');
  testStrategy('/api/profile.json', 'network-first');
  testStrategy('/assets/theme.json', 'cache-first');
  testStrategy('/api/live/time.json', 'network-only');

  // App Tab In-Pane Actions
  document.getElementById('btnRefreshFeed')?.addEventListener('click', () => {
    testStrategy('/api/feed.json', 'stale-while-revalidate');
  });
  document.getElementById('btnRefreshHandbook')?.addEventListener('click', () => {
    testStrategy('/offline-data.json', 'cache-only');
  });
  document.getElementById('btnRefreshProfile')?.addEventListener('click', () => {
    testStrategy('/api/profile.json', 'network-first');
  });
  document.getElementById('btnRefreshTheme')?.addEventListener('click', () => {
    testStrategy('/assets/theme.json', 'cache-first');
  });
  document.getElementById('btnRefreshLive')?.addEventListener('click', () => {
    testStrategy('/api/live/time.json', 'network-only');
  });

  // Dev HUD Quick Test Buttons
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

  // OTA Update Handlers
  document.getElementById('btnCheckUpdate')?.addEventListener('click', () => {
    log('CLI', 'Requesting manual update check via client API...');
    if (typeof NLPWAClient !== 'undefined' && NLPWAClient.requestUpdateCheck) {
      NLPWAClient.requestUpdateCheck();
    } else {
      navigator.serviceWorker.controller?.postMessage({ type: 'CHECK_UPDATE' });
    }
  });

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

  document.getElementById('btnApplyUpdate')?.addEventListener('click', () => {
    log('UPDATE', 'Applying update and reloading application shell...');
    if (typeof NLPWAClient !== 'undefined' && NLPWAClient.applyUpdate) {
      NLPWAClient.applyUpdate();
    } else {
      window.location.reload();
    }
  });

  document.getElementById('btnClearLog')?.addEventListener('click', () => {
    const stream = document.getElementById('logStream');
    if (stream) stream.innerHTML = '';
  });
});
