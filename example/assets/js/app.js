(() => {
    'use strict';

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const client = window.NLPWAClient;
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

    function activateTab(index) {
        links.forEach((link, i) => {
            link.classList.toggle('active', i === index);
            if (i === index) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        panels.forEach((panel, i) => { panel.inert = i !== index; });
    }

    function goToTab(index, smooth) {
        wrapper.scrollTo({ left: index * wrapper.clientWidth, behavior: smooth && !reducedMotion ? 'smooth' : 'instant' });
    }

    links.forEach((link, i) => {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            history.replaceState(null, '', link.hash);
            activateTab(i);
            goToTab(i, true);
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

    const startIndex = Math.max(0, links.findIndex((link) => link.hash === location.hash));
    activateTab(startIndex);
    goToTab(startIndex, false);
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
    if (client) {
        client.subscribe((s) => {
            status.version = s.activeVersion || s.version || status.version;
            status.stagedVersion = s.stagedVersion || null;
            status.updateStatus = s.updateStatus;
            status.progress = s.stagingProgress;
            installButton.hidden = !s.isInstallable || s.isInstalled;
            renderStatus();
        });
        installButton.addEventListener('click', () => client.promptInstall());

        navigator.serviceWorker?.ready.then(countCached);
        navigator.serviceWorker?.addEventListener('controllerchange', () => setTimeout(countCached, 500));
    }
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

    /* ---------- Init ---------- */
    selectStrategy(STRATEGIES[0]);
    renderBars();
    renderLog();
})();
