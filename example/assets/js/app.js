(() => {
    'use strict';

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const client = window.NLPWAClient;
    window.nlpwa = client;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const STRATEGIES = [
        { id: 'cache-first', label: 'Cache first', path: '/demo/cache-first.json', hint: 'Answers from the cache when it can. Goes to the network only on a miss.' },
        { id: 'network-first', label: 'Network first', path: '/demo/network-first.json', hint: 'Tries the network first. Falls back to the cache when you are offline.' },
        { id: 'swr', label: 'SWR', path: '/demo/swr.json', hint: 'Stale while revalidate: answers from the cache now, then refreshes it in the background.' },
        { id: 'network-only', label: 'Network only', path: '/demo/network-only.json', hint: 'Never cached. Fails when you are offline.' },
        { id: 'cache-only', label: 'Cache only', path: '/demo/cache-only.json', hint: 'Only answers from the cache. Anything that is not cached returns 503.' },
    ];

    // X-Cache-Status values from the service worker, grouped by where the data came from.
    const SOURCE_KIND = {
        'offline-cache': 'cache',
        'runtime-cache': 'cache',
        'stale': 'cache',
        'offline-fallback': 'cache',
        'network': 'network',
        'bypass': 'network',
    };

    const state = {
        strategy: STRATEGIES[0],
        results: {},      // strategy id -> { ms, kind, label }
        log: [],
        view: 'log',
    };

    const pad = (n) => String(n).padStart(2, '0');
    const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /* ---------- Tabs ---------- */
    const wrapper = $('.window-wrapper');
    const panels = $$('.window');
    const links = $$('.links-wrapper .link');
    const floatingTabs = $$('.floating-tabs .tab-item');

    function activateTab(index) {
        links.forEach((link, i) => {
            link.classList.toggle('active', i === index);
            if (i === index) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        floatingTabs.forEach((tab, i) => {
            tab.classList.toggle('active', i === index);
            if (i === index) tab.setAttribute('aria-current', 'page');
            else tab.removeAttribute('aria-current');
        });
        panels.forEach((panel, i) => { panel.inert = i !== index; });
        if (index === 1) {
            fetchServerVersion();
            renderManifest();
            updatePinStatus();
        } else if (index === 2) {
            renderStorage();
        } else if (index === 3) {
            renderPlugins();
        }
    }

    function goToTab(index, smooth) {
        wrapper.scrollTo({ left: index * wrapper.clientWidth, behavior: smooth && !reducedMotion ? 'smooth' : 'instant' });
    }

    [...links, ...floatingTabs].forEach((item) => {
        item.addEventListener('click', (event) => {
            event.preventDefault();
            const targetHash = item.hash;
            const targetIndex = panels.findIndex((p) => '#' + p.id === targetHash);
            if (targetIndex >= 0) {
                history.replaceState(null, '', targetHash);
                activateTab(targetIndex);
                goToTab(targetIndex, true);
            }
        });
    });

    let scrollFrame = 0;
    wrapper.addEventListener('scroll', () => {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => {
            const index = Math.round(wrapper.scrollLeft / wrapper.clientWidth);
            if (links[index] && !links[index].classList.contains('active')) {
                activateTab(index);
                history.replaceState(null, '', links[index].hash);
            }
        });
    }, { passive: true });

    addEventListener('resize', () => goToTab(links.findIndex((l) => l.classList.contains('active')), false));

    /* ---------- Status card ---------- */
    const statusCard = $('#status');
    const gauge = $('.gauge', statusCard);
    const statusVersion = $('#status-version');
    const statusValue = $('#status-value');
    const statusState = $('#status-state');

    const status = { cached: 0, total: 0, online: navigator.onLine, version: null, stagedVersion: null, updateStatus: 'idle', progress: null };

    async function offlineCacheNames() {
        return (await caches.keys()).filter((name) => /^offline/.test(name));
    }

    async function countCached() {
        try {
            const res = await fetch('/api/update/info.json');
            const info = await res.json();
            if (info.version && !status.version) {
                status.version = info.version;
            }
            if (client && typeof client.getVersion === 'function') {
                const v = await client.getVersion().catch(() => null);
                if (v?.activeVersion || v?.version) {
                    status.version = v.activeVersion || v.version;
                }
            }
            const paths = (info.files || []).map((f) => f.path);
            const names = await offlineCacheNames();
            let cached = 0;
            for (const path of paths) {
                for (const name of names) {
                    const cache = await caches.open(name);
                    if (await cache.match(path)) { cached += 1; break; }
                }
            }
            status.cached = cached;
            status.total = paths.length;
        } catch {
            // Offline with no cached manifest: keep the last known numbers.
        }
        renderStatus();
    }

    function renderStatus() {
        const { cached, total, online, version, stagedVersion, updateStatus, progress } = status;
        const percent = total ? Math.round((cached / total) * 100) : 0;
        const complete = total > 0 && cached >= total;

        let mode = 'ready';
        let text = 'Offline ready';
        if (!online) {
            mode = 'offline';
            text = complete ? 'Offline · running from cache' : 'Offline';
        } else if (updateStatus === 'staging') {
            mode = 'staged';
            text = `Staging update${progress ? ` · ${Math.round(progress.percent || 0)}%` : ''}`;
        } else if (stagedVersion) {
            mode = 'staged';
            text = `Update staged · ${stagedVersion}`;
        } else if (!complete) {
            mode = 'installing';
            text = total ? `Installing · ${cached} of ${total}` : 'Installing';
        }

        statusCard.dataset.state = mode;
        gauge.style.setProperty('--gauge', percent);
        gauge.setAttribute('aria-valuenow', percent);
        statusValue.textContent = `${cached}/${total}`;
        statusVersion.textContent = version ? `v${version}` : 'v—';

        statusState.textContent = text;
        if (mode === 'staged' && stagedVersion && updateStatus !== 'staging' && client) {
            const apply = el('button', null, 'Apply');
            apply.type = 'button';
            apply.addEventListener('click', () => client.applyUpdate());
            statusState.append(apply);
        }
    }

    /* ---------- Connection ---------- */
    const conn = $('#conn');
    function renderConnection() {
        const online = navigator.onLine;
        status.online = online;
        conn.dataset.online = String(online);
        conn.textContent = online ? 'Online' : 'Offline';
        renderStatus();
    }
    addEventListener('online', renderConnection);
    addEventListener('offline', renderConnection);
    renderConnection();

    /* ---------- Client state (version, updates, install) ---------- */
    const installButton = $('.install');

    function updateInstallButton(s) {
        if (!installButton) return;
        const installed = s?.isInstalled ?? client?.isInstalled?.() ?? false;
        installButton.hidden = false;
        if (installed) {
            installButton.textContent = 'Installed';
            installButton.disabled = true;
            installButton.classList.add('is-installed');
        } else {
            installButton.textContent = 'Install app';
            installButton.disabled = false;
            installButton.classList.remove('is-installed');
        }
    }

    if (client) {
        client.subscribe((s) => {
            status.version = s.activeVersion || s.version || status.version;
            status.stagedVersion = s.stagedVersion || null;
            status.updateStatus = s.updateStatus;
            status.progress = s.stagingProgress;
            updateInstallButton(s);
            renderStatus();
            renderUpdates(s);
        });
        installButton.addEventListener('click', async () => {
            if (installButton.disabled) return;
            if (client && typeof client.promptInstall === 'function') {
                const res = await client.promptInstall();
                if (!res && !client.isInstallable()) {
                    alert('To install this app on your device: open the browser menu (or share button) and select "Add to Home Screen" or "Install App".');
                }
            }
        });

        navigator.serviceWorker?.ready.then(countCached);
        navigator.serviceWorker?.addEventListener('controllerchange', () => setTimeout(countCached, 500));
    }
    updateInstallButton();
    countCached();

    /* ---------- Strategy bars ---------- */
    const bars = $('#bars');
    const barsHint = $('#bars-hint');
    const ghostHeights = [62, 38, 52, 30, 44];

    function renderBars() {
        bars.replaceChildren();
        const measured = Object.values(state.results).map((r) => r.ms);
        const max = Math.max(40, ...measured);

        STRATEGIES.forEach((strategy, i) => {
            const result = state.results[strategy.id];
            const bar = el('div', 'bar');
            bar.dataset.kind = result ? result.kind : 'idle';

            const height = result ? Math.max(8, Math.round((result.ms / max) * 82)) : ghostHeights[i];
            const track = el('div', 'bar-track');
            track.style.setProperty('--h', `${height}%`);
            track.append(el('div', 'bar-fill'));
            if (result) track.append(el('span', 'bar-value', result.kind === 'fail' ? 'failed' : `${result.ms} ms`));

            bar.append(track, el('span', 'bar-name', strategy.label));
            bars.append(bar);
        });

        bars.setAttribute('aria-label', 'Response time for each strategy. ' + STRATEGIES.map((s) => {
            const r = state.results[s.id];
            return `${s.label}: ${r ? (r.kind === 'fail' ? 'failed' : r.ms + ' milliseconds') : 'not run'}`;
        }).join('. '));
        barsHint.hidden = Object.keys(state.results).length > 0;
    }

    /* ---------- Test card ---------- */
    const strategyTabs = $('#strategy-tabs');
    const testForm = $('#test-form');
    const testUrl = $('#test-url');
    const testHint = $('#test-hint');

    function selectStrategy(strategy) {
        state.strategy = strategy;
        $$('button', strategyTabs).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === strategy.id)));
        testUrl.value = strategy.path;
        testHint.textContent = strategy.hint;
    }

    STRATEGIES.forEach((strategy) => {
        const button = el('button', null, strategy.label);
        button.type = 'button';
        button.dataset.id = strategy.id;
        button.setAttribute('aria-pressed', 'false');
        button.title = strategy.hint;
        button.addEventListener('click', () => selectStrategy(strategy));
        strategyTabs.append(button);
    });

    testForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const strategy = state.strategy;
        const url = testUrl.value.trim() || strategy.path;
        const started = performance.now();
        const entry = { time: clock(), url, strategy: strategy.label };

        try {
            // 'no-cache' makes the browser revalidate with the server instead of answering from its own
            // HTTP cache, so what the log shows is the service worker's strategy and nothing else.
            const response = await fetch(url, { cache: 'no-cache' });
            const body = await response.text();
            entry.ms = Math.round(performance.now() - started);
            entry.status = response.status;
            entry.source = response.headers.get('X-Cache-Status') || 'no service worker';
            entry.kind = !response.ok ? 'fail' : (SOURCE_KIND[entry.source] || 'network');

            const served = Date.parse(response.headers.get('Date') || '');
            if (entry.kind === 'cache' && !Number.isNaN(served)) {
                entry.age = Math.max(0, Math.round((Date.now() - served) / 1000));
            }
            entry.size = body.length;
        } catch (error) {
            entry.ms = Math.round(performance.now() - started);
            entry.kind = 'fail';
            entry.status = 'failed';
            entry.source = 'network unreachable';
        }

        state.results[strategy.id] = { ms: entry.ms, kind: entry.kind };
        state.log.push(entry);
        if (state.log.length > 100) state.log.shift();

        renderBars();
        renderViewport();
        if (client) countCached();
    });

    /* ---------- Console ---------- */
    const viewport = $('#viewport');
    const consoleTabs = $('#console-tabs');
    const consoleAction = $('#console-action');
    const ACTION_LABEL = { log: 'Clear', cache: 'Clear cache', config: 'Copy' };
    let configText = '';

    function renderLog() {
        viewport.replaceChildren();
        if (!state.log.length) {
            viewport.append(el('div', 'empty', 'No requests yet. Pick a strategy and press Fetch.'));
            return;
        }
        for (const entry of state.log) {
            const row = el('div', 'row');
            row.append(el('span', 'time', entry.time));

            const main = el('span', 'path');
            main.append(`GET ${entry.url} · ${entry.strategy} · `);
            main.append(el('span', `is-${entry.kind}`, `${entry.status} ${entry.source}`));
            if (entry.age !== undefined) main.append(el('span', 'meta', ` · data ${entry.age}s old`));
            row.append(main, el('span', 'meta', `${entry.ms} ms`));
            viewport.append(row);
        }
        viewport.scrollTop = viewport.scrollHeight;
    }

    async function renderCache() {
        viewport.replaceChildren();
        let names = [];
        try { names = (await caches.keys()).filter((n) => /^(offline|runtime)/.test(n)); } catch { /* unsupported */ }
        if (!names.length) {
            viewport.append(el('div', 'empty', 'Nothing cached yet. The service worker is still installing.'));
            return;
        }
        for (const name of names) {
            const cache = await caches.open(name);
            const requests = await cache.keys();
            viewport.append(el('div', 'group', `${name} · ${requests.length} ${requests.length === 1 ? 'entry' : 'entries'}`));
            for (const request of requests) {
                const response = await cache.match(request);
                const length = Number(response?.headers.get('X-NLPWA-Content-Length') || response?.headers.get('Content-Length'));
                const size = length || (await response.clone().blob()).size;
                const row = el('div', 'row');
                row.append(el('span', 'time', ''), el('span', 'path', new URL(request.url).pathname), el('span', 'meta', formatBytes(size)));
                viewport.append(row);
            }
        }
    }

    async function renderConfig() {
        viewport.replaceChildren(el('div', 'empty', 'Loading…'));
        try {
            const config = await (await fetch('/api/update/config.json')).json();
            const routes = (config.routes || []).map((r) => `${r.match}  →  ${r.strategy}${r.throwOnFailure ? ' (throws offline)' : ''}`);
            configText = [
                `version        ${config.version}`,
                `precache       ${(config.precache || []).length} files`,
                `default        ${config.defaultStrategy}`,
                '',
                'routes',
                ...routes.map((line) => `  ${line}`),
            ].join('\n');
            viewport.replaceChildren(el('pre', null, configText));
        } catch {
            configText = '';
            viewport.replaceChildren(el('div', 'empty is-fail', 'Could not load /api/update/config.json. Reconnect and try again.'));
        }
    }

    function renderViewport() {
        if (state.view === 'log') renderLog();
        else if (state.view === 'cache') renderCache();
        else renderConfig();
    }

    function selectView(view) {
        state.view = view;
        $$('button', consoleTabs).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
        consoleAction.textContent = ACTION_LABEL[view];
        renderViewport();
    }

    consoleTabs.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (button) selectView(button.dataset.view);
    });

    consoleAction.addEventListener('click', async () => {
        if (state.view === 'log') {
            state.log = [];
            renderLog();
        } else if (state.view === 'cache') {
            // Clears the runtime cache only. The app shell stays so the app keeps working offline.
            const names = (await caches.keys()).filter((n) => /^runtime/.test(n));
            await Promise.all(names.map((n) => caches.delete(n)));
            renderCache();
        } else if (configText) {
            try { await navigator.clipboard.writeText(configText); consoleAction.textContent = 'Copied'; }
            catch { consoleAction.textContent = 'Copy failed'; }
            setTimeout(() => { consoleAction.textContent = ACTION_LABEL.config; }, 1500);
        }
    });

    /* ---------- Updates Tab ---------- */
    let otaStatusBadge = $('#ota-status-badge');
    let otaActiveVersion = $('#ota-active-version');
    let otaServerVersion = $('#ota-server-version');
    let otaStagedVersion = $('#ota-staged-version');
    let otaProgressBox = $('#ota-progress-box');
    let otaProgressText = $('#ota-progress-text');
    let otaProgressFill = $('#ota-progress-fill');

    const btnCheckUpdate = $('#btn-check-update');
    const btnBumpVersion = $('#btn-bump-version');
    const btnApplyUpdate = $('#btn-apply-update');
    const btnResetVersion = $('#btn-reset-version');

    const pinTabRole = $('#pin-tab-role');
    const pinCacheName = $('#pin-cache-name');
    const pinDirtyState = $('#pin-dirty-state');
    const btnToggleDirty = $('#btn-toggle-dirty');
    const btnCheckConsensus = $('#btn-check-consensus');
    const pinStatusMsg = $('#pin-status-msg');

    const watchdogState = $('#watchdog-state');
    const btnMarkHealthy = $('#btn-mark-healthy');
    const btnReportCrash = $('#btn-report-crash');
    const btnTriggerRollback = $('#btn-trigger-rollback');
    const watchdogMsg = $('#watchdog-msg');

    const manifestViewport = $('#manifest-viewport');
    const btnRefreshManifest = $('#btn-refresh-manifest');

    let currentDirty = false;

    function renderUpdates(s) {
        const badge = $('#ota-status-badge');
        if (!badge) return;
        const activeVerEl = $('#ota-active-version');
        const stagedVerEl = $('#ota-staged-version');
        const progressBox = $('#ota-progress-box');
        const progressText = $('#ota-progress-text');
        const progressFill = $('#ota-progress-fill');
        const applyBtn = $('#btn-apply-update');

        const activeVer = s?.activeVersion || s?.version || status.version || '1.0.0';
        const stagedVer = s?.stagedVersion || null;
        const updateStatus = s?.updateStatus || 'idle';
        const progress = s?.stagingProgress || null;

        if (activeVerEl) activeVerEl.textContent = `v${activeVer}`;
        if (stagedVerEl) stagedVerEl.textContent = stagedVer ? `v${stagedVer}` : 'None';

        badge.textContent = updateStatus.toUpperCase();
        badge.className = 'badge';
        if (updateStatus === 'checking' || updateStatus === 'staging') {
            badge.classList.add('is-' + updateStatus);
        } else if (updateStatus === 'ready' || stagedVer) {
            badge.classList.add('is-ready');
        } else if (updateStatus === 'failed') {
            badge.classList.add('is-failed');
        } else {
            badge.classList.add('is-muted');
        }

        if (updateStatus === 'staging' && progress && progressBox) {
            progressBox.hidden = false;
            const pct = Math.round(progress.percent || 0);
            if (progressText) progressText.textContent = `${pct}% (${progress.loaded || 0}/${progress.total || 0} files)`;
            if (progressFill) progressFill.style.width = `${pct}%`;
        } else if (progressBox) {
            progressBox.hidden = true;
        }

        if (applyBtn) {
            applyBtn.disabled = !stagedVer;
            applyBtn.textContent = stagedVer ? `Apply v${stagedVer}` : 'Apply Staged Update';
        }
    }

    async function fetchServerVersion() {
        try {
            const res = await fetch('/api/update/version.json', { cache: 'no-cache' });
            if (res.ok) {
                const data = await res.json();
                if (data.version) {
                    otaServerVersion.textContent = `v${data.version}`;
                }
            }
        } catch {
            otaServerVersion.textContent = 'v—';
        }
    }

    async function renderManifest() {
        if (!manifestViewport) return;
        manifestViewport.replaceChildren(el('div', 'empty', 'Loading manifest…'));
        try {
            const res = await fetch('/api/update/info.json', { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const info = await res.json();
            manifestViewport.replaceChildren();

            const headerRow = el('div', 'group', `Manifest v${info.version || '—'} · ${(info.files || []).length} tracked files`);
            manifestViewport.append(headerRow);

            for (const file of (info.files || [])) {
                const row = el('div', 'row');
                const pathSpan = el('span', 'path', file.path);
                const hashSpan = el('span', 'meta', file.hash ? file.hash.slice(0, 10) + '…' : '');
                const sizeSpan = el('span', 'meta', file.size ? formatBytes(file.size) : '');
                row.append(pathSpan, hashSpan, sizeSpan);
                manifestViewport.append(row);
            }
        } catch (err) {
            manifestViewport.replaceChildren(el('div', 'empty is-fail', `Failed to load manifest: ${err.message}`));
        }
    }

    async function updatePinStatus() {
        if (!client) return;
        try {
            const pin = await client.getPinStatus?.();
            if (pin) {
                pinCacheName.textContent = pin.cache || `offline@${pin.version || '1.0.0'}`;
            }
            if (typeof client.isLeader === 'function') {
                const leader = await client.isLeader();
                pinTabRole.textContent = leader ? 'Tab Leader' : 'Follower Tab';
            }
        } catch {}
    }

    btnCheckUpdate?.addEventListener('click', async () => {
        pinStatusMsg.textContent = 'Checking for updates…';
        await fetchServerVersion();
        if (client) {
            await client.requestUpdateCheck?.();
        }
        setTimeout(() => { pinStatusMsg.textContent = ''; }, 2500);
    });

    btnBumpVersion?.addEventListener('click', async () => {
        btnBumpVersion.disabled = true;
        pinStatusMsg.textContent = 'Releasing new version on server…';
        try {
            const res = await fetch('/api/update/bump', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                document.cookie = `nlpwa_version=${data.version}; path=/; max-age=86400; SameSite=Lax`;
                pinStatusMsg.textContent = `Published release v${data.version}! Checking for delta updates…`;
                await fetchServerVersion();
                await renderManifest();
                if (client) {
                    await client.requestUpdateCheck?.();
                }
            } else {
                pinStatusMsg.textContent = `Bump error: ${data.error || 'failed'}`;
            }
        } catch (err) {
            pinStatusMsg.textContent = `Server error: ${err.message}`;
        } finally {
            btnBumpVersion.disabled = false;
            setTimeout(() => { if (pinStatusMsg.textContent.startsWith('Published')) pinStatusMsg.textContent = ''; }, 4000);
        }
    });

    btnApplyUpdate?.addEventListener('click', async () => {
        if (!client) return;
        pinStatusMsg.textContent = 'Applying update atomically…';
        await client.applyUpdate?.({ reload: true });
    });

    btnResetVersion?.addEventListener('click', async () => {
        btnResetVersion.disabled = true;
        pinStatusMsg.textContent = 'Resetting server to v1.0.0…';
        try {
            const res = await fetch('/api/update/reset', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                document.cookie = 'nlpwa_version=; path=/; max-age=0; SameSite=Lax';
                pinStatusMsg.textContent = 'Reset server to v1.0.0 successfully.';
                await fetchServerVersion();
                await renderManifest();
                if (client) {
                    await client.requestUpdateCheck?.();
                }
            }
        } catch (err) {
            pinStatusMsg.textContent = `Reset failed: ${err.message}`;
        } finally {
            btnResetVersion.disabled = false;
            setTimeout(() => { pinStatusMsg.textContent = ''; }, 3000);
        }
    });

    btnToggleDirty?.addEventListener('click', () => {
        currentDirty = !currentDirty;
        pinDirtyState.textContent = currentDirty ? 'Dirty (Guarded)' : 'Clean';
        pinDirtyState.style.color = currentDirty ? 'var(--yellow-color)' : 'var(--text-color)';
        if (client && typeof client.setDirty === 'function') {
            client.setDirty(currentDirty);
        }
        pinStatusMsg.textContent = currentDirty
            ? 'Tab marked DIRTY: background updates will defer reloading until form is saved.'
            : 'Tab marked CLEAN: background updates can reload freely.';
        setTimeout(() => { pinStatusMsg.textContent = ''; }, 3500);
    });

    btnCheckConsensus?.addEventListener('click', async () => {
        if (!client) return;
        try {
            const diag = await client.getDiagnostics?.();
            const consensus = diag?.client?.tabConsensus;
            if (consensus?.hasDirtyTabs) {
                pinStatusMsg.textContent = `Consensus: ${consensus.dirtyTabs.length} open tab(s) currently dirty.`;
            } else {
                pinStatusMsg.textContent = 'Consensus: All tabs are clean and eligible for update.';
            }
        } catch (err) {
            pinStatusMsg.textContent = `Consensus check: ${err.message}`;
        }
        setTimeout(() => { pinStatusMsg.textContent = ''; }, 3500);
    });

    btnMarkHealthy?.addEventListener('click', async () => {
        if (client && typeof client.markHealthy === 'function') {
            await client.markHealthy();
            watchdogState.textContent = 'Healthy (Graduated)';
            watchdogMsg.textContent = 'Confirmed healthy boot! Watchdog probation boot count incremented.';
            setTimeout(() => { watchdogMsg.textContent = ''; }, 3500);
        }
    });

    btnReportCrash?.addEventListener('click', async () => {
        if (client && typeof client.reportBootFailure === 'function') {
            await client.reportBootFailure(new Error('Simulated application exception during startup.'));
            watchdogState.textContent = 'Crash Reported';
            watchdogMsg.textContent = 'Simulated boot crash reported to probation watchdog.';
            setTimeout(() => { watchdogMsg.textContent = ''; }, 3500);
        }
    });

    btnTriggerRollback?.addEventListener('click', async () => {
        if (client && typeof client.rollback === 'function') {
            watchdogMsg.textContent = 'Requesting emergency rollback to fallback cache…';
            await client.rollback('User triggered manual emergency rollback');
        }
    });

    btnRefreshManifest?.addEventListener('click', () => renderManifest());

    /* ---------- Storage Tab ---------- */
    const storagePercentUsed = $('#storage-percent-used');
    const storageUsedBytes = $('#storage-used-bytes');
    const storageTotalQuota = $('#storage-total-quota');
    const storageRuntimeEntries = $('#storage-runtime-entries');
    const storageQuotaFill = $('#storage-quota-fill');
    const storagePersistBadge = $('#storage-persist-badge');
    const storagePersistMsg = $('#storage-persist-msg');
    const storageCleanupMsg = $('#storage-cleanup-msg');
    const partitionsGrid = $('#partitions-grid');

    const btnRequestPersist = $('#btn-request-persist');
    const btnRefreshStorage = $('#btn-refresh-storage');
    const btnLruCleanup = $('#btn-lru-cleanup');
    const btnClearRuntime = $('#btn-clear-runtime');

    async function renderStorage() {
        try {
            let usage = 0;
            let quota = 0;
            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                usage = est.usage || 0;
                quota = est.quota || 0;
            }

            let cacheInfo = null;
            if (client && typeof client.getCacheInfo === 'function') {
                cacheInfo = await client.getCacheInfo().catch(() => null);
                if (cacheInfo) {
                    if (cacheInfo.usage) usage = cacheInfo.usage;
                    if (cacheInfo.quota) quota = cacheInfo.quota;
                }
            }

            const percent = quota > 0 ? ((usage / quota) * 100).toFixed(2) : '0';
            storagePercentUsed.textContent = `${percent}% used`;
            storageUsedBytes.textContent = formatBytes(usage);
            storageTotalQuota.textContent = formatBytes(quota);
            storageQuotaFill.style.width = `${Math.min(100, Math.max(1, Number(percent)))}%`;

            // Persistent Storage Check
            if (client && typeof client.isStoragePersistent === 'function') {
                const isPersist = await client.isStoragePersistent();
                storagePersistBadge.textContent = isPersist ? 'Persistent' : 'Best Effort';
                storagePersistBadge.className = 'badge ' + (isPersist ? '' : 'is-muted');
            }

            // Partitions
            partitionsGrid.replaceChildren();
            const names = await caches.keys();
            let totalRuntimeCount = 0;

            for (const name of names) {
                const cache = await caches.open(name);
                const keys = await cache.keys();
                const count = keys.length;
                if (/^runtime/.test(name)) totalRuntimeCount += count;

                const card = el('div', 'partition-card');
                if (/^runtime/.test(name)) card.classList.add('is-runtime');
                else if (/^staging/.test(name)) card.classList.add('is-staging');
                else if (/fallback/.test(name)) card.classList.add('is-fallback');

                card.append(
                    el('span', 'partition-title', name),
                    el('span', 'partition-meta', `${count} ${count === 1 ? 'cached resource' : 'cached resources'}`)
                );
                partitionsGrid.append(card);
            }

            storageRuntimeEntries.textContent = `${totalRuntimeCount} items`;
        } catch (err) {
            console.warn('[NLPWA] Storage render error:', err);
        }
    }

    btnRequestPersist?.addEventListener('click', async () => {
        if (!client) return;
        try {
            const granted = await client.requestPersistentStorage?.();
            storagePersistBadge.textContent = granted ? 'Persistent' : 'Best Effort';
            storagePersistBadge.className = 'badge ' + (granted ? '' : 'is-muted');
            storagePersistMsg.textContent = granted
                ? 'Persistent storage granted by browser!'
                : 'Persistent storage permission not granted by browser.';
        } catch (err) {
            storagePersistMsg.textContent = `Error: ${err.message}`;
        }
        setTimeout(() => { storagePersistMsg.textContent = ''; }, 3500);
    });

    btnRefreshStorage?.addEventListener('click', () => renderStorage());

    btnLruCleanup?.addEventListener('click', async () => {
        if (!client) return;
        try {
            const res = await client.cleanupRuntimeCache?.({ maxEntries: 5 });
            const evicted = res?.evictedCount ?? 0;
            const freed = formatBytes(res?.freedBytes ?? 0);
            storageCleanupMsg.textContent = `LRU cleanup complete: evicted ${evicted} items, freed ${freed}.`;
            await renderStorage();
        } catch (err) {
            storageCleanupMsg.textContent = `Cleanup error: ${err.message}`;
        }
        setTimeout(() => { storageCleanupMsg.textContent = ''; }, 3500);
    });

    btnClearRuntime?.addEventListener('click', async () => {
        try {
            const names = (await caches.keys()).filter((n) => /^runtime/.test(n));
            await Promise.all(names.map((n) => caches.delete(n)));
            storageCleanupMsg.textContent = 'Cleared all runtime caches.';
            await renderStorage();
        } catch (err) {
            storageCleanupMsg.textContent = `Clear error: ${err.message}`;
        }
        setTimeout(() => { storageCleanupMsg.textContent = ''; }, 3500);
    });

    /* ---------- Plugins Tab ---------- */
    // Badging
    const badgeSupportedBadge = $('#badge-supported-badge');
    const badgeBubble = $('#badge-bubble');
    const btnBadge1 = $('#btn-badge-1');
    const btnBadge5 = $('#btn-badge-5');
    const btnBadgeDot = $('#btn-badge-dot');
    const btnBadgeClear = $('#btn-badge-clear');
    const badgeStatusMsg = $('#badge-status-msg');

    function updateBadgeUI(count) {
        if (!badgeBubble) return;
        if (typeof count === 'number' && count > 0) {
            badgeBubble.hidden = false;
            badgeBubble.classList.remove('is-dot');
            badgeBubble.textContent = String(count);
        } else if (count === 'dot') {
            badgeBubble.hidden = false;
            badgeBubble.classList.add('is-dot');
            badgeBubble.textContent = '';
        } else {
            badgeBubble.hidden = true;
            badgeBubble.textContent = '';
        }
    }

    btnBadge1?.addEventListener('click', async () => {
        updateBadgeUI(1);
        if (client && typeof client.setAppBadge === 'function') {
            await client.setAppBadge(1);
        }
        badgeStatusMsg.textContent = 'App badge count set to 1 (updated in OS dock/taskbar & preview).';
        setTimeout(() => { badgeStatusMsg.textContent = ''; }, 3500);
    });

    btnBadge5?.addEventListener('click', async () => {
        updateBadgeUI(5);
        if (client && typeof client.setAppBadge === 'function') {
            await client.setAppBadge(5);
        }
        badgeStatusMsg.textContent = 'App badge count set to 5.';
        setTimeout(() => { badgeStatusMsg.textContent = ''; }, 3500);
    });

    btnBadgeDot?.addEventListener('click', async () => {
        updateBadgeUI('dot');
        if (client && typeof client.setAppBadge === 'function') {
            await client.setAppBadge();
        }
        badgeStatusMsg.textContent = 'App badge set to dot (uncounted unread indicator).';
        setTimeout(() => { badgeStatusMsg.textContent = ''; }, 3500);
    });

    btnBadgeClear?.addEventListener('click', async () => {
        updateBadgeUI(0);
        if (client && typeof client.clearAppBadge === 'function') {
            await client.clearAppBadge();
        }
        badgeStatusMsg.textContent = 'App badge cleared.';
        setTimeout(() => { badgeStatusMsg.textContent = ''; }, 3500);
    });

    // Background Sync
    const syncOutboxCount = $('#sync-outbox-count');
    const syncForm = $('#sync-form');
    const syncNoteInput = $('#sync-note-input');
    const btnSyncReplay = $('#btn-sync-replay');
    const btnSyncClear = $('#btn-sync-clear');
    const syncStatusMsg = $('#sync-status-msg');

    function getSyncQueue() {
        if (window.NLPWASyncClient?.SyncQueue) {
            return new window.NLPWASyncClient.SyncQueue('notes');
        }
        return null;
    }

    async function updateSyncOutbox() {
        const queue = getSyncQueue();
        if (!queue) return;
        try {
            const items = await queue.getAll();
            if (syncOutboxCount) {
                syncOutboxCount.textContent = `Outbox: ${items.length} queued`;
            }
        } catch {}
    }

    syncForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = syncNoteInput.value.trim() || 'Test offline note';
        const queue = getSyncQueue();
        if (!queue) {
            syncStatusMsg.textContent = 'SyncQueue client not available.';
            return;
        }

        try {
            await queue.push(new Request('/api/sync/note', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note: text, timestamp: Date.now() }),
            }));
            syncStatusMsg.textContent = `Queued "${text}" to sync outbox with automatic Idempotency-Key!`;
            syncNoteInput.value = '';
            await updateSyncOutbox();
        } catch (err) {
            syncStatusMsg.textContent = `Failed to queue: ${err.message}`;
        }
        setTimeout(() => { syncStatusMsg.textContent = ''; }, 4000);
    });

    btnSyncReplay?.addEventListener('click', async () => {
        const queue = getSyncQueue();
        if (!queue) return;
        syncStatusMsg.textContent = 'Replaying queued mutations to server…';
        try {
            const res = await queue.replayAll({
                onReplaySuccess: (item, resp) => console.log('[Sync] replayed note', item.id, resp.status),
            });
            syncStatusMsg.textContent = `Replay complete: ${res.successCount} replayed, ${res.remainingCount} remaining in outbox.`;
            await updateSyncOutbox();
        } catch (err) {
            syncStatusMsg.textContent = `Replay error: ${err.message}`;
        }
        setTimeout(() => { syncStatusMsg.textContent = ''; }, 4000);
    });

    btnSyncClear?.addEventListener('click', async () => {
        const queue = getSyncQueue();
        if (!queue) return;
        await queue.clear();
        syncStatusMsg.textContent = 'Cleared sync outbox.';
        await updateSyncOutbox();
        setTimeout(() => { syncStatusMsg.textContent = ''; }, 3000);
    });

    // Web Push
    const pushPermissionBadge = $('#push-permission-badge');
    const btnPushRequest = $('#btn-push-request');
    const btnPushTest = $('#btn-push-test');
    const pushStatusMsg = $('#push-status-msg');

    function updatePushPermission() {
        if (!pushPermissionBadge) return;
        const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
        pushPermissionBadge.textContent = perm.toUpperCase();
        pushPermissionBadge.className = 'badge';
        if (perm === 'granted') {
            pushPermissionBadge.classList.add('is-ready');
        } else if (perm === 'denied') {
            pushPermissionBadge.classList.add('is-failed');
        } else {
            pushPermissionBadge.classList.add('is-muted');
        }
    }

    btnPushRequest?.addEventListener('click', async () => {
        if (typeof Notification === 'undefined') {
            pushStatusMsg.textContent = 'Notifications not supported in this browser.';
            return;
        }
        try {
            const perm = await Notification.requestPermission();
            updatePushPermission();
            pushStatusMsg.textContent = `Notification permission: ${perm}`;
        } catch (err) {
            pushStatusMsg.textContent = `Permission error: ${err.message}`;
        }
        setTimeout(() => { pushStatusMsg.textContent = ''; }, 3500);
    });

    btnPushTest?.addEventListener('click', async () => {
        if (typeof Notification === 'undefined') {
            pushStatusMsg.textContent = 'Notifications not supported in this browser.';
            return;
        }
        if (Notification.permission !== 'granted') {
            pushStatusMsg.textContent = 'Please click "Request Permission" first.';
            return;
        }
        try {
            const reg = await navigator.serviceWorker?.ready;
            if (reg?.showNotification) {
                await reg.showNotification('NLPWA Engine', {
                    body: 'Interactive Web Push demonstration. Action routing & app badging ready.',
                    icon: '/assets/icon/icon-192.png',
                    badge: '/assets/icon/favicon.ico',
                    tag: 'nlpwa-showcase-push',
                });
                pushStatusMsg.textContent = 'Notification displayed!';
            }
        } catch (err) {
            pushStatusMsg.textContent = `Notification error: ${err.message}`;
        }
        setTimeout(() => { pushStatusMsg.textContent = ''; }, 3500);
    });

    // Native OS (Share & Bg-Fetch)
    const btnShareTrigger = $('#btn-share-trigger');
    const btnBgfetchStatus = $('#btn-bgfetch-status');
    const nativeStatusMsg = $('#native-status-msg');

    btnShareTrigger?.addEventListener('click', async () => {
        if (typeof navigator !== 'undefined' && navigator.share) {
            try {
                await navigator.share({
                    title: 'NLPWA Showcase App',
                    text: 'Native-like PWA Framework with delta updates & offline sync',
                    url: window.location.origin,
                });
                nativeStatusMsg.textContent = 'Native share sheet launched successfully!';
            } catch (err) {
                if (err.name !== 'AbortError') {
                    nativeStatusMsg.textContent = `Share error: ${err.message}`;
                }
            }
        } else {
            try {
                await navigator.clipboard.writeText(window.location.origin);
                nativeStatusMsg.textContent = 'Web Share API not supported on desktop. URL copied to clipboard!';
            } catch {
                nativeStatusMsg.textContent = 'Web Share API not supported.';
            }
        }
        setTimeout(() => { nativeStatusMsg.textContent = ''; }, 3500);
    });

    btnBgfetchStatus?.addEventListener('click', () => {
        const supported = typeof self !== 'undefined' && 'BackgroundFetchManager' in self;
        nativeStatusMsg.textContent = supported
            ? 'Background Fetch API is supported on this browser (large-file background transfers active)!'
            : 'Background Fetch API not supported on this browser engine (available in Chromium & Android).';
        setTimeout(() => { nativeStatusMsg.textContent = ''; }, 4500);
    });

    function renderPlugins() {
        if (badgeSupportedBadge && client) {
            const sup = client.isBadgingSupported?.() ?? false;
            badgeSupportedBadge.textContent = sup ? 'Supported' : 'API Mock';
            badgeSupportedBadge.className = 'badge ' + (sup ? '' : 'is-muted');
        }
        updatePushPermission();
        updateSyncOutbox();
    }

    /* ---------- Init ---------- */
    selectStrategy(STRATEGIES[0]);
    renderBars();
    renderLog();
    fetchServerVersion();
    renderManifest();
    updatePinStatus();
    renderStorage();
    renderPlugins();

    const startIndex = Math.max(0, links.findIndex((link) => link.hash === location.hash));
    activateTab(startIndex);
    goToTab(startIndex, false);
})();
