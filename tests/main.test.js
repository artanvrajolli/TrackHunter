const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { EventEmitter } = require('events');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

async function createHarness(t, serve = (req, res) => res.end('GBXtest-map'), mocks = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trackhunter-test-'));
    const server = http.createServer(serve);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const port = server.address().port;
    const handlers = new Map();
    const events = [];
    const webContents = { mainFrame: {}, isDestroyed: () => false, send: (channel, data) => events.push(data) };
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    const shell = { openPath: async () => '', openExternal: async () => {} };
    const app = new EventEmitter();
    app.getPath = () => directory;
    app.requestSingleInstanceLock = () => true;
    app.whenReady = () => new Promise(() => {});
    app.quit = () => {};
    const electron = { app, shell, BrowserWindow: class {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
    const network = {
        get: (url, options, callback) => http.get(`http://127.0.0.1:${port}${url.pathname}${url.search}`, options, callback),
        request: (options, callback) => http.request({ ...options, hostname: '127.0.0.1', port }, callback),
    };
    const context = vm.createContext({
        require: name => Object.hasOwn(mocks, name) ? mocks[name] : name === './controller' ? require('../controller') : name === 'electron' ? electron : name === 'https' ? network : name === 'os' ? { ...os, tmpdir: () => directory } : require(name),
        __dirname: path.join(__dirname, '..'), process, console: { log() {}, error() {} },
        URL, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    });
    vm.runInContext(source, context);
    context.testWebContents = webContents;
    vm.runInContext('mainWindow = { webContents: testWebContents, isDestroyed: () => false };', context);
    return {
        directory, context, shell, events,
        invoke: (name, arg, sender = event) => handlers.get(name)(sender, arg),
        evaluate: code => vm.runInContext(code, context),
        mapPath: id => path.join(directory, 'trackmania-maps', `${id}.Map.Gbx`),
    };
}

test('download publishes only a complete GBX and failed launch preserves the cache', async t => {
    const h = await createHarness(t);
    h.shell.openPath = async () => 'No application is associated';
    const result = await h.invoke('open-trackmania', 42);
    assert.equal(result.success, false);
    assert.match(result.error, /Could not open/);
    assert.equal(fs.readFileSync(h.mapPath(42), 'utf8'), 'GBXtest-map');
    assert.equal(fs.existsSync(`${h.mapPath(42)}.part`), false);
    assert.equal(await h.invoke('is-map-cached', '42'), true);
    assert.equal(h.events.some(event => event.status === 'complete'), false);
    h.shell.openPath = async () => '';
    assert.equal((await h.invoke('open-trackmania', '42')).success, true);
    assert.equal(h.events.some(event => event.status === 'cached'), true);
});

test('HTML and truncated downloads cannot become cached maps', async t => {
    const h = await createHarness(t, (req, res) => {
        if (req.url.endsWith('/43')) {
            res.setHeader('Content-Type', 'text/html');
            res.end('<html>Error</html>');
        } else {
            res.setHeader('Content-Length', '100');
            res.write('GBXpartial');
            setTimeout(() => res.destroy(), 20);
        }
    });
    for (const id of [43, 44]) {
        assert.equal((await h.invoke('open-trackmania', id)).success, false);
        assert.equal(fs.existsSync(h.mapPath(id)), false);
        assert.equal(fs.existsSync(`${h.mapPath(id)}.part`), false);
    }
});

test('cancel aborts a stalled transfer, locks concurrent launches, and permits retry', async t => {
    let response;
    let notifyStarted;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    const h = await createHarness(t, (req, res) => {
        response = res;
        res.write('GBXpartial');
        notifyStarted();
    });
    const pending = h.invoke('open-trackmania', '45');
    await started;
    assert.equal((await h.invoke('open-trackmania', '46')).success, false);
    assert.equal((await h.invoke('clear-cached-maps')).success, false);
    assert.equal(await h.invoke('is-map-cached', '45'), false);
    assert.equal(await h.invoke('cancel-download', 45), true);
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(fs.existsSync(h.mapPath(45)), false);
    assert.equal(fs.existsSync(`${h.mapPath(45)}.part`), false);
    response.destroy();
    fs.writeFileSync(h.mapPath(45), 'GBXcomplete');
    assert.equal((await h.invoke('open-trackmania', '45')).success, true);
});

test('bounded relative redirects work and redirect loops terminate', async t => {
    const h = await createHarness(t, (req, res) => {
        if (req.url === '/mapgbx/47') {
            res.writeHead(302, { Location: '/actual-map' });
            res.end();
        } else if (req.url === '/actual-map') {
            res.end('GBXredirected');
        } else {
            res.writeHead(302, { Location: '/loop' });
            res.end();
        }
    });
    assert.equal((await h.invoke('open-trackmania', 47)).success, true);
    assert.equal((await h.invoke('open-trackmania', 48)).success, false);
});

test('IPC rejects traversal, malformed payloads, and foreign frames', async t => {
    const h = await createHarness(t);
    for (const id of ['../secret', '-2', '1; echo', null, {}, 0]) {
        assert.equal((await h.invoke('open-trackmania', id)).success, false);
        assert.equal(await h.invoke('is-map-cached', id), false);
    }
    for (const channel of ['tmio-get-pb-single', 'tmio-get-pbs', 'nadeo-get-pbs', 'nadeo-login-ubisoft', 'nadeo-login-oauth', 'save-filter-state', 'tmio-save-auth-token']) {
        assert.equal((await h.invoke(channel, null)).success, false, channel);
    }
    assert.equal((await h.invoke('clear-cached-maps', undefined, { sender: {}, senderFrame: {} })).success, false);
});

test('settings retain All Years and unlimited history, reject unsafe keys, and roll back failed writes', async t => {
    const h = await createHarness(t);
    const state = { yearRange: '', historyLimit: 0, sortBy: 'name', searchTerm: 'a'.repeat(300), colorFilters: { white: false, injected: true } };
    assert.equal((await h.invoke('save-filter-state', state)).success, true);
    const saved = JSON.parse(fs.readFileSync(path.join(h.directory, 'config.json'))).filterState;
    assert.equal(saved.yearRange, '');
    assert.equal(saved.historyLimit, 0);
    assert.equal(saved.searchTerm.length, 200);
    assert.equal(saved.colorFilters.white, false);
    assert.equal(saved.colorFilters.injected, undefined);
    assert.equal(fs.existsSync(path.join(h.directory, 'config.json.tmp')), false);
    fs.mkdirSync(path.join(h.directory, 'config.json.tmp'));
    assert.equal((await h.invoke('save-filter-state', { yearRange: '2025' })).success, false);
    assert.equal((await h.invoke('load-filter-state')).yearRange, '');
});

test('PB requests deduplicate, cache per map, and space distinct lookups', async t => {
    const hits = [];
    const h = await createHarness(t, (req, res) => {
        hits.push({ path: req.url, at: Date.now() });
        res.end(JSON.stringify({ time: 12345 }));
    });
    await h.invoke('tmio-save-auth-token', 'test-token');
    const [a, b] = await Promise.all([h.invoke('tmio-get-pb-single', { mapUid: 'mapA' }), h.invoke('tmio-get-pb-single', { mapUid: 'mapA' })]);
    assert.equal(a.pb.time, 12345);
    assert.equal(b.pb.time, 12345);
    assert.equal(hits.length, 1);
    await h.invoke('tmio-get-pb-single', { mapUid: 'mapA' });
    assert.equal(hits.length, 1);
    const result = await h.invoke('tmio-get-pbs', { mapUids: ['mapA', 'mapB'] });
    assert.equal(result.pbs.mapB.time, 12345);
    assert.equal(hits.length, 2);
    assert.ok(hits[1].at - hits[0].at >= 1500);
});

test('rate limits stop queued requests and do not cache errors as missing records', async t => {
    let hits = 0;
    const h = await createHarness(t, (req, res) => {
        hits++;
        res.writeHead(429, { 'Retry-After': '60' });
        res.end('{}');
    });
    await h.invoke('tmio-save-auth-token', 'test-token');
    const results = await Promise.all(['mapA', 'mapB', 'mapC'].map(mapUid => h.invoke('tmio-get-pb-single', { mapUid })));
    assert.equal(hits, 1);
    for (const result of results) {
        assert.equal(result.success, false);
        assert.ok(result.retryAfterMs > 0);
    }
    assert.equal(h.evaluate('tmioRecordCache.size'), 0);
});

test('missing PBs cache successfully; force refresh and account changes bypass old records', async t => {
    let hits = 0;
    const h = await createHarness(t, (req, res) => {
        hits++;
        if (hits === 1) { res.writeHead(404); res.end('{}'); }
        else res.end(JSON.stringify({ time: 9000 }));
    });
    await h.invoke('tmio-save-auth-token', 'first-token');
    assert.equal((await h.invoke('tmio-get-pb-single', { mapUid: 'mapA' })).pb, null);
    assert.equal((await h.invoke('tmio-get-pb-single', { mapUid: 'mapA' })).pb, null);
    assert.equal(hits, 1);
    assert.equal((await h.invoke('tmio-get-pb-single', { mapUid: 'mapA', forceRefresh: true })).pb.time, 9000);
    await h.invoke('tmio-save-auth-token', 'second-token');
    await h.invoke('tmio-get-pb-single', { mapUid: 'mapA' });
    assert.equal(hits, 3);
});

test('account reset invalidates an in-flight response even when the token is unchanged', async t => {
    let sendResponse;
    let started;
    const began = new Promise(resolve => { started = resolve; });
    const h = await createHarness(t, (req, res) => {
        sendResponse = () => res.end(JSON.stringify({ time: 12345 }));
        started();
    });
    await h.invoke('tmio-save-auth-token', 'same-token');
    const pending = h.invoke('tmio-get-pb-single', { mapUid: 'mapA' });
    await began;
    await h.invoke('tmio-save-auth-token', 'same-token');
    sendResponse();
    assert.equal((await pending).success, false);
    assert.equal(h.evaluate('tmioRecordCache.size'), 0);
});

test('login detection accepts Base64Url account keys containing hyphens and underscores', async t => {
    const login = 'AbCdEfGhIjKlMnOpQrSt-_';
    class Client extends EventEmitter {
        async connect() {}
        async query(method) {
            if (method === 'GetMainServerPlayerInfo') return { Login: login, NickName: 'Player' };
            if (method === 'GetDetailedPlayerInfo') return { Login: login, NickName: 'Player', ClientVersion: '1', Path: 'World|Europe', LadderStats: { PlayerRankings: [] } };
            return { ServerLogin: login };
        }
        terminate() {}
    }
    const h = await createHarness(t, undefined, { gbxremote: { Client } });
    const result = await h.evaluate('probeTrackmaniaSessionReady(100)');
    assert.equal(result.ready, true);
});

test('overlay IPC trusts only its local main frame and validates controller settings', async t => {
    const h = await createHarness(t);
    assert.equal((await h.invoke('set-controller-overlay-enabled', 'true')).success, false);
    assert.equal((await h.invoke('set-controller-overlay-enabled', false)).success, true);
    assert.equal((await h.invoke('get-controller-status')).enabled, false);
    assert.equal((await h.invoke('close-controller-overlay')).success, false);
    const overlayContents = { mainFrame: {}, send() {} };
    h.context.testOverlayContents = overlayContents;
    h.evaluate('controllerOverlayWindow = { webContents: testOverlayContents, isDestroyed: () => false };');
    assert.equal((await h.invoke('get-controller-status', undefined, { sender: overlayContents, senderFrame: overlayContents.mainFrame })).success, true);
    assert.equal((await h.invoke('get-controller-status', undefined, { sender: overlayContents, senderFrame: {} })).success, false);
});
