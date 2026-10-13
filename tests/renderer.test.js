const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { setTimeout: delay } = require('timers/promises');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('        init().catch')[0];

function createHarness(t) {
    const elements = new Map();
    const timers = new Set();
    const makeElement = () => ({
        value: '', options: [{ value: '' }, { value: '2026' }, { value: 'name' }], style: {}, attributes: {}, innerHTML: '', children: [], isConnected: true,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name]; },
        addEventListener() {}, appendChild(child) { this.children.push(child); }, querySelector: () => null,
        focus() {}, remove() {},
        set textContent(value) {
            this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            this.text = String(value);
        },
        get textContent() { return this.text || ''; },
    });
    const document = {
        getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
        createElement: makeElement, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    };
    const api = {
        log: async () => {}, onDownloadProgress() {}, onReplayNewPb(callback) { api.replayCallback = callback; },
        getCachedMapIds: async () => ({ success: true, mapIds: [] }),
        loadFilterState: async () => null, saveFilterState: async () => ({ success: true }),
    };
    const context = vm.createContext({
        document, window: { electronAPI: api, addEventListener() {} },
        localStorage: { getItem: () => null, setItem() {} }, URL, AbortController, console,
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
        fetch: async () => ({ ok: true, json: async () => ({ Results: [] }) }),
    });
    vm.runInContext(source, context);
    vm.runInContext('rendererLog = () => {}; showToast = () => {}; updateSeasonCounts = () => {}; enrichHistoryWithMapData = () => {}; displayMaps = maps => { window.lastRenderedMaps = maps; };', context);
    document.getElementById('sortSelect').value = 'name';
    t.after(() => { for (const timer of timers) clearTimeout(timer); });
    return { context, api, document, evaluate: code => vm.runInContext(code, context) };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
const response = maps => ({ ok: true, json: async () => ({ Results: maps }) });
const map = (id, name) => ({ MapId: id, Name: name, MapUid: `uid${id}` });

test('a late response cannot replace the newest year selection', async t => {
    const h = createHarness(t);
    const old = deferred();
    const fresh = deferred();
    let calls = 0;
    h.context.fetch = () => ++calls === 1 ? old.promise : fresh.promise;
    const first = h.evaluate('fetchMaps()');
    const second = h.evaluate('fetchMaps()');
    fresh.resolve(response([map(2, 'Summer 02')]));
    await second;
    old.resolve(response([map(1, 'Winter 01')]));
    await first;
    assert.equal(h.evaluate('allMaps[0].MapId'), 2);
    assert.equal(h.evaluate('window.lastRenderedMaps[0].MapId'), 2);
    assert.equal(h.document.getElementById('content').attributes['aria-busy'], 'false');
});

test('refresh invalidates preprocessed maps and filters the new response', async t => {
    const h = createHarness(t);
    h.context.fetch = async () => response([map(1, 'Winter 01')]);
    await h.evaluate('fetchMaps()');
    h.context.fetch = async () => response([map(2, 'Summer 02')]);
    await h.evaluate('fetchMaps()');
    assert.equal(h.evaluate('preprocessedMaps[0].map.MapId'), 2);
    assert.equal(h.evaluate('window.lastRenderedMaps[0].MapId'), 2);
});

test('failed refresh retains maps and exposes a retry action', async t => {
    const h = createHarness(t);
    h.context.fetch = async () => response([map(1, 'Winter 01')]);
    await h.evaluate('fetchMaps()');
    h.context.fetch = async () => { throw new Error('offline'); };
    await h.evaluate('fetchMaps()');
    assert.equal(h.evaluate('allMaps[0].MapId'), 1);
    const status = h.document.getElementById('mapStatus');
    assert.match(status.textContent, /Could not load maps/);
    assert.equal(status.children[0].attributes.onclick, 'fetchMaps()');
});

test('All Years survives restoring saved settings', async t => {
    const h = createHarness(t);
    h.api.loadFilterState = async () => ({ yearRange: '', historyLimit: 0 });
    await h.evaluate('loadFilterState()');
    h.document.getElementById('yearRange').value = '2026';
    h.evaluate('applyFilterStateToUI()');
    assert.equal(h.document.getElementById('yearRange').value, '');
    assert.equal(h.evaluate('historyLimit'), 0);
});

test('rapid typing saves only the final filter state', async t => {
    const h = createHarness(t);
    const states = [];
    h.api.saveFilterState = async state => { states.push(state); return { success: true }; };
    for (const text of ['W', 'Wi', 'Winter']) {
        h.document.getElementById('searchInput').value = text;
        h.evaluate('scheduleSearch()');
    }
    await delay(320);
    assert.equal(states.length, 1);
    assert.equal(states[0].searchTerm, 'Winter');
});

test('server-provided map names are safe inside HTML attributes', t => {
    const h = createHarness(t);
    const escaped = h.evaluate(`escapeHtml('" onclick="alert(1)\\' <script>')`);
    assert.equal(escaped.includes('"'), false);
    assert.equal(escaped.includes("'"), false);
    assert.equal(escaped.includes('<script>'), false);
    assert.ok(escaped.includes('&quot;'));
    assert.ok(html.includes('this.dataset.mapName'));
});

test('PB failures remain retryable and successful empty lookups are marked complete', async t => {
    const h = createHarness(t);
    h.api.tmioGetPbSingle = async () => ({ success: false, error: 'offline' });
    h.evaluate("tmioAuthenticated = true; tmioFetchQueue.add('uid1'); tmioLoadingUids.add('uid1');");
    await h.evaluate('processTmioQueue()');
    assert.equal(h.evaluate("tmioNoRecordUids.has('uid1')"), false);
    assert.equal(h.evaluate("tmioFailedUids.has('uid1')"), true);
    assert.equal(h.evaluate('tmioFetchInProgress'), false);
    h.api.tmioGetPbSingle = async () => ({ success: true, pb: null });
    h.evaluate("tmioFetchQueue.add('uid2'); tmioLoadingUids.add('uid2');");
    await h.evaluate('processTmioQueue()');
    assert.equal(h.evaluate("tmioNoRecordUids.has('uid2')"), true);
    assert.equal(h.evaluate("tmioLoadingUids.has('uid2')"), false);
});

test('discarding queued PBs releases loading markers so cards can be observed again', t => {
    const h = createHarness(t);
    h.evaluate("tmioFetchQueue.add('queuedUid'); tmioLoadingUids.add('queuedUid'); tmioLoadingUids.add('activeUid'); clearQueuedPbs();");
    assert.equal(h.evaluate('tmioFetchQueue.size'), 0);
    assert.equal(h.evaluate("tmioLoadingUids.has('queuedUid')"), false);
    assert.equal(h.evaluate("tmioLoadingUids.has('activeUid')"), true);
});

test('local PB replay updates history immediately and cannot replace a faster best', async t => {
    const h = createHarness(t);
    h.evaluate("trackHistory = [{ mapId: '1', mapUid: 'uid1', mapName: 'Winter 01', pbTime: 40000 }];");
    await h.api.replayCallback({ mapUid: 'uid1', time: 35000 });
    assert.equal(h.evaluate('trackHistory[0].pbTime'), 35000);
    assert.equal(h.evaluate("getPersonalBestTime({ MapUid: 'uid1' })"), 35000);
    await h.api.replayCallback({ mapUid: 'uid1', time: 38000 });
    assert.equal(h.evaluate('trackHistory[0].pbTime'), 35000);
    assert.equal(h.evaluate("getPersonalBestTime({ MapUid: 'uid1' })"), 35000);
});
