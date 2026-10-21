import { getVersion, getStatus, requestUpdateCheck } from './messaging.js';
import { applyUpdate } from './update-ui.js';
import { getCacheInfo } from './cache-manager.js';

/**
 * Creates and attaches a floating in-page debug panel showing active, staged,
 * and pinned versions, along with cache metrics and manual update controls.
 *
 * @param {Object} [options]
 * @param {'bottom-right'|'bottom-left'|'top-right'|'top-left'} [options.position='bottom-right']
 * @returns {() => void} Teardown function to remove the panel
 */
export function attachDebugPanel({ position = 'bottom-right' } = {}) {
  if (typeof document === 'undefined') return () => {};

  const existing = document.getElementById('nlpwa-debug-panel');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.id = 'nlpwa-debug-panel';

  const positions = {
    'bottom-right': 'bottom: 16px; right: 16px;',
    'bottom-left': 'bottom: 16px; left: 16px;',
    'top-right': 'top: 16px; right: 16px;',
    'top-left': 'top: 16px; left: 16px;',
  };

  container.style.cssText = `
    position: fixed;
    ${positions[position] || positions['bottom-right']}
    z-index: 999999;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 1.4;
    color: #e2e8f0;
    background: rgba(15, 23, 42, 0.92);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    padding: 12px;
    min-width: 280px;
    max-width: 360px;
    transition: all 0.2s ease;
  `;

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:6px;">
      <div style="font-weight:700;color:#38bdf8;display:flex;align-items:center;gap:6px;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;" id="nlpwa-dbg-indicator"></span>
        NLPWA Inspector
      </div>
      <div style="display:flex;gap:6px;">
        <button id="nlpwa-dbg-refresh" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;padding:2px 4px;font-size:11px;" title="Refresh">&#x21bb;</button>
        <button id="nlpwa-dbg-close" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;padding:2px 4px;font-size:11px;" title="Close">&#x2715;</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 8px;margin-bottom:10px;">
      <span style="color:#94a3b8;">Active:</span>
      <span id="nlpwa-dbg-active" style="font-weight:600;color:#f8fafc;">loading...</span>
      <span style="color:#94a3b8;">Staged:</span>
      <span id="nlpwa-dbg-staged" style="color:#fbbf24;">none</span>
      <span style="color:#94a3b8;">Pinned:</span>
      <span id="nlpwa-dbg-pinned" style="color:#a78bfa;">none</span>
      <span style="color:#94a3b8;">Status:</span>
      <span id="nlpwa-dbg-status" style="color:#38bdf8;">idle</span>
    </div>
    <div style="display:flex;gap:6px;border-top:1px solid rgba(255,255,255,0.1);padding-top:8px;">
      <button id="nlpwa-dbg-check" style="flex:1;background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.3);color:#38bdf8;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;font-weight:600;">Check Update</button>
      <button id="nlpwa-dbg-apply" style="flex:1;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);color:#22c55e;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;font-weight:600;display:none;">Apply Update</button>
    </div>
  `;

  document.body.appendChild(container);

  async function updateDisplay() {
    try {
      const [versionInfo, status] = await Promise.all([
        getVersion(2000),
        getStatus(2000),
      ]);

      const activeEl = container.querySelector('#nlpwa-dbg-active');
      const stagedEl = container.querySelector('#nlpwa-dbg-staged');
      const pinnedEl = container.querySelector('#nlpwa-dbg-pinned');
      const statusEl = container.querySelector('#nlpwa-dbg-status');
      const applyBtn = container.querySelector('#nlpwa-dbg-apply');
      const indicator = container.querySelector('#nlpwa-dbg-indicator');

      if (activeEl) activeEl.textContent = versionInfo?.activeVersion ? `v${versionInfo.activeVersion}` : 'unknown';
      if (stagedEl) stagedEl.textContent = versionInfo?.stagedVersion ? `v${versionInfo.stagedVersion}` : 'none';
      if (pinnedEl) {
        if (versionInfo?.pinnedVersion) {
          pinnedEl.textContent = `v${versionInfo.pinnedVersion}`;
        } else if (versionInfo?.pinnedCache) {
          pinnedEl.textContent = versionInfo.pinnedCache;
        } else {
          pinnedEl.textContent = 'none';
        }
      }
      if (statusEl) statusEl.textContent = status || 'idle';

      if (versionInfo?.stagedVersion) {
        if (applyBtn) applyBtn.style.display = 'block';
        if (indicator) indicator.style.background = '#fbbf24';
      } else {
        if (applyBtn) applyBtn.style.display = 'none';
        if (indicator) indicator.style.background = '#22c55e';
      }
    } catch {}
  }

  updateDisplay();

  const checkBtn = container.querySelector('#nlpwa-dbg-check');
  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      checkBtn.textContent = 'Checking...';
      try {
        await requestUpdateCheck();
      } finally {
        setTimeout(() => {
          checkBtn.textContent = 'Check Update';
          updateDisplay();
        }, 1000);
      }
    });
  }

  const applyBtn = container.querySelector('#nlpwa-dbg-apply');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      applyUpdate();
    });
  }

  const refreshBtn = container.querySelector('#nlpwa-dbg-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => updateDisplay());
  }

  const closeBtn = container.querySelector('#nlpwa-dbg-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => container.remove());
  }

  const onReady = () => updateDisplay();
  const onApplied = () => updateDisplay();

  document.addEventListener('nlpwa:update-ready', onReady);
  document.addEventListener('nlpwa:update-applied', onApplied);

  return () => {
    document.removeEventListener('nlpwa:update-ready', onReady);
    document.removeEventListener('nlpwa:update-applied', onApplied);
    container.remove();
  };
}
