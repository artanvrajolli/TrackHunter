const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const gbxremote = require('gbxremote');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { setTimeout: delay } = require('timers/promises');

let config = {};
let cancelDownloadId = null;
let activeDownloadId = null;
let launchAbortController = null;
const configPath = path.join(app.getPath('userData'), 'config.json');

async function getTrackmaniaProcessIds() {
    if (process.platform !== 'win32') return [];
    try {
        const { stdout: output } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq Trackmania.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        const lines = output
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('INFO:'));

        const processIds = [];
        for (const line of lines) {
            const normalized = line.replace(/^"|"$/g, '');
            const parts = normalized.split('","');
            if (parts.length < 2) {
                continue;
            }

            const pid = parseInt(parts[1], 10);
            if (!Number.isNaN(pid)) {
                processIds.push(pid);
            }
        }

        return processIds;
    } catch (error) {
        log(`[Game] Process detection failed: ${error.message}`);
        return [];
    }
}

async function checkTrackmaniaRunning() {
    return (await getTrackmaniaProcessIds()).length > 0;
}

function probeTrackmaniaSessionReady(timeoutMs = 4000, signal = launchAbortController?.signal) {
    return new Promise((resolve) => {
        let settled = false;
        let client = null;
        let lastClientError = null;

        const finish = (ready, reason = '') => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeoutHandle);
            signal?.removeEventListener('abort', onAbort);
            try {
                if (client) {
                    client.terminate();
                }
            } catch (error) {
            }
            resolve({ ready, reason });
        };

        const onAbort = () => finish(false, 'cancelled');
        const timeoutHandle = setTimeout(() => {
            finish(false, 'gbx-timeout');
        }, timeoutMs);
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });

        (async () => {
            try {
                client = new gbxremote.Client(5000, '127.0.0.1');
                client.on('error', (error) => {
                    lastClientError = error;
                });

                await client.connect(2000);

                const mainPlayer = await client.query('GetMainServerPlayerInfo', []);
                if (!mainPlayer || !mainPlayer.Login || !mainPlayer.NickName) {
                    finish(false, 'missing-main-player');
                    return;
                }

                const detailedPlayer = await client.query('GetDetailedPlayerInfo', [mainPlayer.Login]);
                const systemInfo = await client.query('GetSystemInfo', []);

                const playerLogin = String(mainPlayer.Login || '').trim();
                const serverLogin = String(systemInfo?.ServerLogin || '').trim();
                const hoursSinceZoneInscription = Number(detailedPlayer?.HoursSinceZoneInscription);
                const playerRankings = detailedPlayer?.LadderStats?.PlayerRankings;
                const hasRankingData = Array.isArray(playerRankings) && playerRankings.length > 0;
                const playerPath = String(detailedPlayer?.Path || '');

                // Trackmania 2020 online account keys are 22-character Base64Url strings (e.g. HSnSHgS2RsuSWjSccf0HHg)
                // When still loading/offline, it uses a 36-character UUID with hyphens (e.g. bc14c157-f5b3-47bd-9085-2e8d7166adb0)
                const isOnlineAccount = /^[A-Za-z0-9_-]{22}$/.test(playerLogin);
                
                // When fully authenticated, Path usually resolves to something like "World|Europe|Albania"
                // rather than just "World" 
                const hasDetailedPath = playerPath.includes('|');

                // Dump pure telemetry so we can debug exactly what Trackmania reports
                log(`[GBX Telemetry] Login: ${playerLogin} (${playerLogin.length}), Path: ${playerPath}`);

                const ready = Boolean(
                    detailedPlayer &&
                    detailedPlayer.Login &&
                    detailedPlayer.NickName &&
                    detailedPlayer.ClientVersion &&
                    isOnlineAccount && 
                    hasDetailedPath
                );

                const reason = ready
                    ? 'gbx-player-ready'
                    : `gbx-not-authenticated:loginMatch=${playerLogin === serverLogin};hours=${hoursSinceZoneInscription};hasRanking=${hasRankingData}`;

                finish(ready, reason);
            } catch (error) {
                const message = error?.message || lastClientError?.message || 'unknown';
                finish(false, `gbx-error:${message}`);
            }
        })();
    });
}

async function waitForTrackmaniaLogin(event, mapId, timeoutMs = 180000) {
    const pollIntervalMs = 2000;
    const requiredStableChecks = 3;
    const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
    let stableChecks = 0;

    sendDownloadProgress(event, {
        mapId,
        status: 'login-detecting',
        progress: 95,
        attempt: 0,
        maxAttempts
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (cancelDownloadId !== mapId) {
            throw new Error('Download cancelled');
        }

        const probe = await probeTrackmaniaSessionReady();
        launchAbortController.signal.throwIfAborted();
        if (probe.ready) {
            stableChecks += 1;
            if (stableChecks >= requiredStableChecks) {
                log(`Automatic login detection succeeded after ${attempt} checks for map ${mapId}`);
                return;
            }
        } else {
            log(`Login probe check ${attempt}/${maxAttempts} for map ${mapId}: ${probe.reason}`);
            stableChecks = 0;
        }

        sendDownloadProgress(event, {
            mapId,
            status: 'login-detecting',
            progress: 95,
            attempt,
            maxAttempts
        });

        await delay(pollIntervalMs, undefined, { signal: launchAbortController.signal });
    }

    throw new Error('Could not confirm Trackmania login in time. Please log in and retry.');
}

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
        }
    } catch (e) {
        log(`[Settings] Could not load configuration: ${e.message}`);
        config = {};
    }
}

function saveConfig() {
    try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(`${configPath}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
        fs.renameSync(`${configPath}.tmp`, configPath);
    } catch (e) {
        log(`Error saving config: ${e.message}`);
        throw e;
    }
}

let mainWindow;
let replayWatcher = null;
const logFile = path.join(os.tmpdir(), 'trackmania-viewer.log');
let localPbCache = null;
let localPbCacheAt = 0;
const LOCAL_PB_CACHE_TTL_MS = 60 * 1000;

const UBISOFT_APP_ID = '86263886-327a-4328-ac69-527f0d20a237';
const UBISERVICES_SESSION_URL = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';
const NADEO_AUTH_URL = 'https://prod.trackmania.core.nadeo.online/v2/authentication/token/ubiservices';
const NADEO_AUTH_BASIC_URL = 'https://prod.trackmania.core.nadeo.online/v2/authentication/token/basic';
const NADEO_RECORDS_URL = 'https://prod.trackmania.core.nadeo.online/v2/accounts';
const NADEO_MAPS_BY_UID_URL = 'https://prod.trackmania.core.nadeo.online/maps';
const TM_OAUTH_AUTHORIZE = 'https://api.trackmania.com/oauth/authorize';
const TM_OAUTH_TOKEN = 'https://api.trackmania.com/api/access_token';

let nadeoTokens = { accessToken: null, refreshToken: null };
let nadeoAccountId = null;
let nadeoPbCache = null;
let nadeoPbCacheAt = 0;
const NADEO_PB_CACHE_TTL_MS = 60 * 1000;
let oauthServer = null;

const TMIO_PB_CACHE_TTL_MS = 60 * 1000;
const TMIO_API_BASE = 'https://trackmania.io/api';
const TMIO_RATE_LIMIT_MS = 1600; // ~40 requests per minute

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    try {
        fs.appendFileSync(logFile, logMessage);
    } catch (error) {
        console.error('[Log] Unable to write log file');
    }
    console.log(logMessage);
}

async function loadLocalPersonalBests() {
    const now = Date.now();
    if (localPbCache && now - localPbCacheAt < LOCAL_PB_CACHE_TTL_MS) {
        return localPbCache;
    }

    const docsDir = app.getPath('documents');
    const replaysDir = path.join(docsDir, 'Trackmania', 'Replays', 'Autosaves');

    if (!fs.existsSync(replaysDir)) {
        localPbCache = {};
        localPbCacheAt = now;
        return localPbCache;
    }

    let entries = [];
    try {
        entries = await fs.promises.readdir(replaysDir, { withFileTypes: true });
    } catch (error) {
        log(`Failed to read replays directory: ${error.message}`);
        localPbCache = {};
        localPbCacheAt = now;
        return localPbCache;
    }

    const pbFiles = entries
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .filter(name => name.toLowerCase().endsWith('.replay.gbx') && name.toLowerCase().includes('personalbest'));

    if (!pbFiles.length) {
        localPbCache = {};
        localPbCacheAt = now;
        return localPbCache;
    }

    let GBX = null;
    try {
        ({ GBX } = await import('gbx'));
    } catch (error) {
        log(`Failed to load gbx parser: ${error.message}`);
        localPbCache = {};
        localPbCacheAt = now;
        return localPbCache;
    }

    const results = {};
    for (const name of pbFiles) {
        const filePath = path.join(replaysDir, name);
        try {
            const data = await fs.promises.readFile(filePath);
            const gbx = new GBX(data);
            const replay = await gbx.parseHeaders();
            const uid = replay?.mapInfo?.id;
            const time = replay?.time;
            if (!uid || typeof time !== 'number' || time <= 0) {
                continue;
            }
            if (!results[uid] || time < results[uid]) {
                results[uid] = time;
            }
        } catch (error) {
            log(`Failed to parse replay ${name}: ${error.message}`);
        }
    }

    localPbCache = results;
    localPbCacheAt = now;
    return localPbCache;
}

function httpsRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers: options.headers || {},
        };

        const requestTimeout = setTimeout(() => req.destroy(new Error('API request timed out')), 30000);
        const req = protocol.request(reqOptions, (res) => {
            let data = '';
            res.on('error', error => { clearTimeout(requestTimeout); reject(error); });
            res.on('aborted', () => { clearTimeout(requestTimeout); reject(new Error('API response interrupted')); });
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                clearTimeout(requestTimeout);
                resolve({ status: res.statusCode, headers: res.headers, body: data });
            });
        });

        req.setTimeout(30000, () => req.destroy(new Error('API request timed out')));
        req.on('error', error => { clearTimeout(requestTimeout); reject(error); });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

async function getUbisoftTicket(email, password) {
    const credentials = Buffer.from(`${email}:${password}`).toString('base64');
    const response = await httpsRequest(UBISERVICES_SESSION_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Ubi-AppId': UBISOFT_APP_ID,
            'Authorization': `Basic ${credentials}`,
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
        body: JSON.stringify({}),
    });

    if (response.status !== 200) {
        let errorMsg = `Ubisoft auth failed (${response.status})`;
        try {
            const parsed = JSON.parse(response.body);
            if (parsed.message) errorMsg = parsed.message;
        } catch {}
        throw new Error(errorMsg);
    }

    const data = JSON.parse(response.body);
    return { ticket: data.ticket, accountId: data.userId };
}

async function getNadeoToken(ticket, audience = 'NadeoServices') {
    const response = await httpsRequest(NADEO_AUTH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `ubi_v1 t=${ticket}`,
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
        body: JSON.stringify({ audience }),
    });

    if (response.status !== 200) {
        throw new Error(`Nadeo token exchange failed (${response.status})`);
    }

    const data = JSON.parse(response.body);
    return { accessToken: data.accessToken, refreshToken: data.refreshToken };
}

async function refreshNadeoToken(audience = 'NadeoServices') {
    if (!nadeoTokens.refreshToken) {
        throw new Error('No refresh token available');
    }

    const response = await httpsRequest(NADEO_AUTH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `nadeo_v1 t=${nadeoTokens.refreshToken}`,
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
        body: JSON.stringify({ audience }),
    });

    if (response.status !== 200) {
        throw new Error(`Nadeo token refresh failed (${response.status})`);
    }

    const data = JSON.parse(response.body);
    nadeoTokens.accessToken = data.accessToken;
    nadeoTokens.refreshToken = data.refreshToken;
    config.nadeoTokens = nadeoTokens;
    saveConfig();
    return nadeoTokens.accessToken;
}

async function nadeoApiRequest(url, retries = 1) {
    if (!nadeoTokens.accessToken) {
        throw new Error('Not authenticated with Nadeo');
    }

    const response = await httpsRequest(url, {
        headers: {
            'Authorization': `nadeo_v1 t=${nadeoTokens.accessToken}`,
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
    });

    if (response.status === 401 && retries > 0) {
        await refreshNadeoToken();
        return nadeoApiRequest(url, retries - 1);
    }

    if (response.status !== 200) {
        throw new Error(`Nadeo API error (${response.status}): ${response.body}`);
    }

    return JSON.parse(response.body);
}

async function translateMapUids(mapUids) {
    if (!mapUids.length) return {};

    const results = {};
    const batchSize = 100;
    for (let i = 0; i < mapUids.length; i += batchSize) {
        const batch = mapUids.slice(i, i + batchSize);
        const uidList = batch.join(',');
        try {
            const data = await nadeoApiRequest(
                `${NADEO_MAPS_BY_UID_URL}?mapUidList=${encodeURIComponent(uidList)}`
            );
            for (const map of data) {
                if (map.mapUid && map.mapId) {
                    results[map.mapUid] = map.mapId;
                }
            }
        } catch (error) {
            log(`Map UID translation batch failed: ${error.message}`);
        }
    }
    return results;
}

async function fetchNadeoPbs(mapUids) {
    const now = Date.now();
    if (nadeoPbCache && now - nadeoPbCacheAt < NADEO_PB_CACHE_TTL_MS) {
        return nadeoPbCache;
    }

    if (!nadeoTokens.accessToken || !nadeoAccountId) {
        return {};
    }

    try {
        const uidToId = await translateMapUids(mapUids);
        const mapIds = Object.values(uidToId);
        if (!mapIds.length) {
            nadeoPbCache = {};
            nadeoPbCacheAt = now;
            return nadeoPbCache;
        }

        const idToUid = {};
        for (const [uid, id] of Object.entries(uidToId)) {
            idToUid[id] = uid;
        }

        const results = {};
        const batchSize = 50;
        for (let i = 0; i < mapIds.length; i += batchSize) {
            const batch = mapIds.slice(i, i + batchSize);
            const idList = batch.join(',');
            try {
                const records = await nadeoApiRequest(
                    `${NADEO_RECORDS_URL}/${nadeoAccountId}/mapRecords?mapIdList=${idList}`
                );
                for (const record of records) {
                    const uid = idToUid[record.mapId];
                    if (uid && record.recordScore && typeof record.recordScore.time === 'number') {
                        results[uid] = {
                            time: record.recordScore.time,
                            medal: record.medal,
                            timestamp: record.timestamp,
                        };
                    }
                }
            } catch (error) {
                log(`Nadeo PB batch fetch failed: ${error.message}`);
            }
        }

        nadeoPbCache = results;
        nadeoPbCacheAt = now;
        log(`Fetched ${Object.keys(results).length} Nadeo PBs`);
        return results;
    } catch (error) {
        log(`Error fetching Nadeo PBs: ${error.message}`);
        return {};
    }
}

let tmioRequestQueue = Promise.resolve();
let tmioNextRequestAt = 0;
let tmioBlockedUntil = 0;
let tmioAccountVersion = 0;
const tmioRecordCache = new Map();
const tmioPendingRecords = new Map();

function validateMapUid(mapUid) {
    if (typeof mapUid !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(mapUid)) {
        throw new Error('Invalid map UID');
    }
    return mapUid;
}

async function tmioApiRequest(url, authToken, accountVersion = tmioAccountVersion) {
    const request = tmioRequestQueue.then(async () => {
        if (authToken !== config.tmioAuthToken || accountVersion !== tmioAccountVersion) throw new Error('Account changed');
        if (Date.now() < tmioBlockedUntil) {
            const error = new Error('Rate limited by trackmania.io. Please try again shortly.');
            error.retryAfterMs = tmioBlockedUntil - Date.now();
            throw error;
        }
        await delay(Math.max(0, tmioNextRequestAt - Date.now()));
        if (authToken !== config.tmioAuthToken || accountVersion !== tmioAccountVersion) throw new Error('Account changed');
        tmioNextRequestAt = Date.now() + TMIO_RATE_LIMIT_MS;
        const response = await httpsRequest(url, { headers: {
            'Authorization': authToken,
            'User-Agent': 'TrackHunter/1.0',
        } });
        if (response.status === 429) {
            const retryAfter = response.headers['retry-after'];
            const seconds = Number(retryAfter);
            const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
            tmioBlockedUntil = Date.now() + Math.max(60000, retryAfterMs || 0);
            const error = new Error('Rate limited by trackmania.io. Please try again shortly.');
            error.retryAfterMs = tmioBlockedUntil - Date.now();
            throw error;
        }
        // A missing leaderboard is a successful lookup with no personal best.
        if (response.status === 404) return null;
        if (response.status !== 200) throw new Error(`trackmania.io API error (${response.status})`);
        return JSON.parse(response.body);
    });
    tmioRequestQueue = request.catch(() => {});
    return request;
}

function resetTmioCache() {
    tmioAccountVersion++;
    tmioRecordCache.clear();
    tmioPendingRecords.clear();
}

async function getTmioPersonalBest(mapUid, forceRefresh = false) {
    validateMapUid(mapUid);
    const authToken = config.tmioAuthToken;
    if (!authToken) throw new Error('Not authenticated');
    const accountVersion = tmioAccountVersion;
    const key = `${accountVersion}:${mapUid}`;
    const cached = tmioRecordCache.get(key);
    if (!forceRefresh && cached && Date.now() - cached.at < TMIO_PB_CACHE_TTL_MS) return cached.pb;
    if (tmioPendingRecords.has(key)) {
        const pending = tmioPendingRecords.get(key);
        if (!forceRefresh) return pending;
        try { await pending; } catch (error) { log('[TMIO] Retrying pending lookup after replay update'); }
        if (accountVersion !== tmioAccountVersion) throw new Error('Account changed');
        return getTmioPersonalBest(mapUid, true);
    }
    const request = (async () => {
        try {
            const data = await tmioApiRequest(`${TMIO_API_BASE}/leaderboard/personal/map/${mapUid}`, authToken, accountVersion);
            if (authToken !== config.tmioAuthToken || accountVersion !== tmioAccountVersion) throw new Error('Account changed');
            const pb = data && typeof data.time === 'number' && data.time > 0 ? {
                time: data.time, medal: data.medal ?? null, timestamp: data.timestamp || null,
            } : null;
            if (tmioRecordCache.size >= 2000) tmioRecordCache.delete(tmioRecordCache.keys().next().value);
            tmioRecordCache.set(key, { at: Date.now(), pb });
            return pb;
        } finally {
            tmioPendingRecords.delete(key);
        }
    })();
    tmioPendingRecords.set(key, request);
    return request;
}

async function fetchTmioPbs(mapUids) {
    if (!Array.isArray(mapUids) || mapUids.length > 1000) throw new Error('Invalid map UID list');
    mapUids.forEach(validateMapUid);
    const results = {};
    for (const uid of new Set(mapUids)) {
        const pb = await getTmioPersonalBest(uid);
        if (pb) results[uid] = pb;
    }
    return results;
}

function stopOAuthServer() {
    if (oauthServer) {
        try { oauthServer.close(); } catch {}
        oauthServer = null;
    }
}

function generateRandomState() {
    return require('crypto').randomBytes(16).toString('hex');
}

async function exchangeOAuthCode(code, clientId, clientSecret, redirectUri) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri,
    }).toString();

    const response = await httpsRequest(TM_OAUTH_TOKEN, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'TrackmaniaMapViewer/1.0',
        },
        body,
    });

    if (response.status !== 200) {
        throw new Error(`OAuth token exchange failed (${response.status}): ${response.body}`);
    }

    return JSON.parse(response.body);
}

async function loginWithUbisoft(email, password) {
    const { ticket, accountId } = await getUbisoftTicket(email, password);
    log(`Ubisoft auth successful, accountId: ${accountId}`);

    const token = await getNadeoToken(ticket, 'NadeoServices');
    nadeoTokens = token;
    nadeoAccountId = accountId;

    config.nadeoTokens = nadeoTokens;
    config.nadeoAccountId = accountId;
    config.nadeoAuthMethod = 'ubisoft';
    config.nadeoEmail = email;
    saveConfig();

    nadeoPbCache = null;
    nadeoPbCacheAt = 0;

    return { success: true, accountId };
}

async function loginWithOAuth(clientId, clientSecret) {
    const state = generateRandomState();
    let port = 0;

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            clearTimeout(timeout);
            const url = new URL(req.url, `http://127.0.0.1`);
            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Authorization failed</h2><p>You can close this window.</p></body></html>');
                server.close();
                oauthServer = null;
                reject(new Error(`OAuth error: ${error}`));
                return;
            }

            if (returnedState !== state) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>State mismatch - possible CSRF</h2></body></html>');
                server.close();
                oauthServer = null;
                reject(new Error('OAuth state mismatch'));
                return;
            }

            if (code) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Authorization successful!</h2><p>You can close this window.</p></body></html>');
                server.close();
                oauthServer = null;

                try {
                    const redirectUri = `http://127.0.0.1:${port}/callback`;
                    const tokens = await exchangeOAuthCode(code, clientId, clientSecret, redirectUri);
                    config.nadeoOAuthTokens = tokens;
                    config.nadeoOAuthClientId = clientId;
                    config.nadeoOAuthClientSecret = clientSecret;
                    config.nadeoAuthMethod = 'oauth';
                    saveConfig();
                    resolve({ success: true });
                } catch (err) {
                    reject(err);
                }
            } else {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>No code received</h2></body></html>');
                server.close();
                oauthServer = null;
                reject(new Error('No authorization code received'));
            }
        });

        server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            log(`OAuth callback server listening on port ${port}`);
            oauthServer = server;

            const redirectUri = `http://127.0.0.1:${port}/callback`;
            const authUrl = new URL(TM_OAUTH_AUTHORIZE);
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set('client_id', clientId);
            authUrl.searchParams.set('scope', '');
            authUrl.searchParams.set('redirect_uri', redirectUri);
            authUrl.searchParams.set('state', state);

            shell.openExternal(authUrl.toString());
            log(`Opened OAuth URL: ${authUrl.toString()}`);
        });

        const timeout = setTimeout(() => {
            server.close();
            oauthServer = null;
            reject(new Error('OAuth login timed out (5 minutes)'));
        }, 5 * 60 * 1000);

        server.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

async function restoreNadeoSession() {
    if (config.nadeoAuthMethod === 'ubisoft' && config.nadeoTokens) {
        nadeoTokens = config.nadeoTokens;
        nadeoAccountId = config.nadeoAccountId;
        if (nadeoTokens.refreshToken) {
            try {
                await refreshNadeoToken();
                log('Nadeo session restored via refresh token');
                return true;
            } catch (error) {
                log(`Failed to restore Nadeo session: ${error.message}`);
            }
        }
    }
    return false;
}

function logoutNadeo() {
    nadeoTokens = { accessToken: null, refreshToken: null };
    nadeoAccountId = null;
    nadeoPbCache = null;
    nadeoPbCacheAt = 0;
    stopOAuthServer();
    delete config.nadeoTokens;
    delete config.nadeoAccountId;
    delete config.nadeoAuthMethod;
    delete config.nadeoEmail;
    delete config.nadeoOAuthTokens;
    delete config.nadeoOAuthClientId;
    delete config.nadeoOAuthClientSecret;
    saveConfig();
}

function isNadeoAuthenticated() {
    return Boolean(nadeoTokens.accessToken);
}

function cleanupFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        log(`Error cleaning up file ${filePath}: ${error.message}`);
    }
}

function isLikelyHtmlResponse(contentType, initialChunk) {
    const normalizedContentType = (contentType || '').toLowerCase();
    const normalizedChunk = (initialChunk || '').toString('utf8', 0, Math.min(initialChunk.length || 0, 512)).trimStart().toLowerCase();

    if (normalizedContentType.includes('text/html') || normalizedContentType.includes('application/xhtml')) {
        return true;
    }

    return normalizedChunk.startsWith('<!doctype html') || normalizedChunk.startsWith('<html');
}

function normalizeMapId(mapId) {
    const value = String(mapId ?? '');
    if (!/^\d{1,12}$/.test(value) || Number(value) <= 0) {
        throw new Error('Invalid map ID');
    }
    return String(Number(value));
}

function isValidCachedMap(mapPath) {
    let fd;
    try {
        if (fs.statSync(mapPath).size < 4) return false;
        fd = fs.openSync(mapPath, 'r');
        const header = Buffer.alloc(3);
        return fs.readSync(fd, header, 0, 3, 0) === 3 && header.toString() === 'GBX';
    } catch (error) {
        if (error.code !== 'ENOENT') log(`[Cache] Cannot read map: ${error.message}`);
        return false;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function sendDownloadProgress(event, data) {
    if (!event.sender.isDestroyed()) event.sender.send('download-progress', data);
}

async function downloadMapFile(url, mapPath, event, mapId, retries = 3, redirects = 0) {
    const signal = launchAbortController.signal;
    const partialPath = `${mapPath}.part`;
    signal.throwIfAborted();
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || redirects > 5) {
        throw new Error('Invalid map download redirect');
    }

    let request;
    const transferTimeout = setTimeout(() => {
        request?.destroy(new Error('Map download timed out. Please retry.'));
    }, 120000);
    try {
        const response = await new Promise((resolve, reject) => {
            request = https.get(parsedUrl, { signal }, resolve);
            request.setTimeout(30000, () => request.destroy(new Error('Map download timed out. Please retry.')));
            request.on('error', reject);
        });
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume();
            if (!response.headers.location) throw new Error('TMX returned an invalid redirect');
            clearTimeout(transferTimeout);
            return await downloadMapFile(new URL(response.headers.location, url).href, mapPath, event, mapId, retries, redirects + 1);
        }
        if (response.statusCode !== 200) {
            response.resume();
            const error = new Error(`TMX download failed with status ${response.statusCode}`);
            error.retryable = response.statusCode >= 500;
            throw error;
        }

        const totalSize = Number(response.headers['content-length']) || 0;
        let downloaded = 0;
        let header = Buffer.alloc(0);
        let validated = false;
        let lastProgress = -1;
        const validator = new Transform({
            transform(chunk, encoding, callback) {
                downloaded += chunk.length;
                if (downloaded > 100 * 1024 * 1024) {
                    callback(new Error('Map download exceeds the size limit'));
                    return;
                }
                if (!validated) {
                    header = Buffer.concat([header, chunk]);
                    if (header.length < 3) { callback(); return; }
                    if (isLikelyHtmlResponse(response.headers['content-type'], header) || header.toString('ascii', 0, 3) !== 'GBX') {
                        callback(new Error('TMX returned an invalid map file. Please retry.'));
                        return;
                    }
                    validated = true;
                    chunk = header;
                    header = null;
                }
                const progress = totalSize ? Math.min(60, Math.round(downloaded / totalSize * 50) + 10) : 50;
                if (progress !== lastProgress) {
                    sendDownloadProgress(event, { mapId, status: 'downloading', progress });
                    lastProgress = progress;
                }
                callback(null, chunk);
            }
        });
        await pipeline(response, validator, fs.createWriteStream(partialPath), { signal });
        if (!validated || downloaded < 4 || (totalSize && downloaded !== totalSize)) {
            throw new Error('TMX returned an incomplete map file. Please retry.');
        }
        signal.throwIfAborted();
        await fs.promises.rename(partialPath, mapPath);
        log(`[Download] Complete: map ${mapId} (${downloaded} bytes)`);
    } catch (error) {
        request?.destroy();
        cleanupFile(partialPath);
        if (!signal.aborted && retries > 0 && (error.retryable || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code))) {
            sendDownloadProgress(event, { mapId, status: 'retry', progress: 5, retryAttempt: 4 - retries, maxRetries: 3, error: 'Connection failed, retrying...' });
            clearTimeout(transferTimeout);
            await delay(2000, undefined, { signal });
            return await downloadMapFile(url, mapPath, event, mapId, retries - 1, redirects);
        }
        throw error;
    } finally {
        clearTimeout(transferTimeout);
    }
}

async function parseReplayForMapUid(filePath) {
    try {
        const { GBX } = await import('gbx');
        const data = await fs.promises.readFile(filePath);
        const gbx = new GBX(data);
        const replay = await gbx.parseHeaders();
        const uid = replay?.mapInfo?.id;
        const time = replay?.time;
        if (uid && typeof time === 'number' && time > 0) {
            return { mapUid: uid, time };
        }
    } catch (error) {
    }
    return null;
}

const replayDebounceTimers = new Map();

function setupReplayWatcher() {
    const replaysDir = path.join(app.getPath('documents'), 'Trackmania', 'Replays', 'Autosaves');
    if (!fs.existsSync(replaysDir)) return;
    replayWatcher?.close();
    try {
        replayWatcher = fs.watch(replaysDir, { persistent: false }, (eventType, filename) => {
            if (!filename) return;
            const name = String(filename).toLowerCase();
            if (!name.endsWith('.replay.gbx') || !name.includes('personalbest')) return;
            clearTimeout(replayDebounceTimers.get(name));
            replayDebounceTimers.set(name, setTimeout(async () => {
                replayDebounceTimers.delete(name);
                try {
                    const filePath = path.join(replaysDir, String(filename));
                    if (!fs.existsSync(filePath)) return;
                    const result = await parseReplayForMapUid(filePath);
                    if (result && mainWindow && !mainWindow.isDestroyed()) {
                        localPbCache = null;
                        log(`[Replay] New PB: ${result.mapUid} (${result.time}ms)`);
                        mainWindow.webContents.send('replay-new-pb', result);
                    }
                } catch (error) {
                    log(`[Replay] Could not read new PB: ${error.message}`);
                }
            }, 1500));
        });
        replayWatcher.on('error', error => log(`[Replay] Watcher failed: ${error.message}`));
    } catch (error) {
        log(`[Replay] Could not watch replays: ${error.message}`);
    }
}

function validateFilterState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid filter settings');
    const normalized = {};
    if (typeof state.includeCached === 'boolean') normalized.includeCached = state.includeCached;
    if (['asc', 'desc'].includes(state.sortDirection)) normalized.sortDirection = state.sortDirection;
    if (['mapId', 'natural', 'name', 'downloads', 'awards', 'difficulty'].includes(state.sortBy)) normalized.sortBy = state.sortBy;
    if (typeof state.yearRange === 'string' && (state.yearRange === '' || /^20\d{2}$/.test(state.yearRange))) normalized.yearRange = state.yearRange;
    if (typeof state.searchTerm === 'string') normalized.searchTerm = state.searchTerm.slice(0, 200);
    if ([0, 20, 60, 100].includes(state.historyLimit)) normalized.historyLimit = state.historyLimit;
    for (const [property, keys] of [['colorFilters', ['white', 'green', 'yellow', 'red', 'black', 'unclassified']], ['seasonFilters', ['Winter', 'Spring', 'Summer', 'Autumn']]]) {
        normalized[property] = {};
        for (const key of keys) {
            if (typeof state[property]?.[key] === 'boolean') normalized[property][key] = state[property][key];
        }
    }
    return normalized;
}

function openTmxInBrowser(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' && parsed.hostname === 'trackmania.exchange' && !parsed.username && !parsed.password) {
            shell.openExternal(parsed.href).catch(error => log(`[Browser] ${error.message}`));
        }
    } catch (error) {
        log('[Browser] Invalid map link');
    }
}

function createWindow() {
    const bounds = config.windowBounds || {};
    mainWindow = new BrowserWindow({
        width: Number.isInteger(bounds.width) ? Math.max(640, Math.min(2560, bounds.width)) : 1200,
        height: Number.isInteger(bounds.height) ? Math.max(500, Math.min(1440, bounds.height)) : 800,
        minWidth: 640,
        minHeight: 500,
        backgroundColor: '#111827',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'icon.png')
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        openTmxInBrowser(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        openTmxInBrowser(url);
    });
    mainWindow.on('close', () => {
        config.windowBounds = mainWindow.getNormalBounds();
        config.windowMaximized = mainWindow.isMaximized();
        try { saveConfig(); } catch (error) { log(`[Window] Could not save size: ${error.message}`); }
        launchAbortController?.abort();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    if (config.windowMaximized === true) mainWindow.maximize();
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    log('Application started');
    loadConfig();
    restoreNadeoSession().catch(error => log(`[Startup] Session restore failed: ${error.message}`));
    app.on('second-instance', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });
    app.whenReady().then(() => {
        createWindow();
        setupReplayWatcher();
    }).catch(error => log(`[Startup] ${error.message}`));
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    launchAbortController?.abort();
    replayWatcher?.close();
    replayWatcher = null;
    for (const timer of replayDebounceTimers.values()) clearTimeout(timer);
    replayDebounceTimers.clear();
    stopOAuthServer();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function handleIpc(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
        try {
            if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
                return { success: false, error: 'Unauthorized request' };
            }
            return await handler(event, ...args);
        } catch (error) {
            log(`[IPC:${channel}] ${error.message}`);
            return { success: false, error: error.message };
        }
    });
}

function persistConfigPatch(patch) {
    const previous = config;
    config = { ...config, ...patch };
    try { saveConfig(); }
    catch (error) { config = previous; throw error; }
}

handleIpc('open-trackmania', async (event, mapId) => {
    try { mapId = normalizeMapId(mapId); } catch (error) { return { success: false, error: error.message }; }
    log(`[Open] Requested map ${mapId}`);
    
    if (activeDownloadId !== null) {
        log(`Download already in progress for map: ${mapId}`);
        return { success: false, error: 'Download already in progress' };
    }
    
    activeDownloadId = mapId;
    launchAbortController = new AbortController();
    let mapPath;
    try {
        cancelDownloadId = mapId;
    
        let exePath = config.trackmaniaPath;
    
        if (!exePath || !fs.existsSync(exePath)) {
            const possiblePaths = [
                'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Trackmania\\Trackmania.exe',
                'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Trackmania\\Trackmania.exe',
                'C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\games\\Trackmania\\Trackmania.exe',
                'C:\\Program Files\\Epic Games\\Trackmania\\Trackmania.exe',
                'C:\\Program Files (x86)\\Epic Games\\Trackmania\\Trackmania.exe',
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'trackmania', 'Trackmania.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Ubisoft Game Launcher', 'games', 'Trackmania', 'Trackmania.exe'),
                'D:\\Games\\Trackmania\\Trackmania.exe',
                'D:\\Games\\Steam\\steamapps\\common\\Trackmania\\Trackmania.exe',
                'E:\\Games\\Trackmania\\Trackmania.exe',
            ];
        
            // Find the first existing executable
            exePath = null;
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    exePath = p;
                    break;
                }
            }
        
            // Save the found path to config to avoid searching again
            if (exePath) {
                config.trackmaniaPath = exePath;
                saveConfig();
            }
        }
    
        const downloadUrl = `https://trackmania.exchange/mapgbx/${mapId}`;
        const tempDir = path.join(os.tmpdir(), 'trackmania-maps');
        mapPath = path.join(tempDir, `${mapId}.Map.Gbx`);
    
        log(`Download URL: ${downloadUrl}`);
        log(`Temp dir: ${tempDir}`);
        log(`Map path: ${mapPath}`);
        log(`Exe exists: ${Boolean(exePath && fs.existsSync(exePath))}`);
    
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
            log(`Created temp dir: ${tempDir}`);
        }
    
        const isRunning = await checkTrackmaniaRunning();
        log(`Trackmania running: ${isRunning}`);
    
        if (isValidCachedMap(mapPath)) {
            cleanupFile(`${mapPath}.part`);
            log(`Map already cached at: ${mapPath}`);
            const stats = fs.statSync(mapPath);
            log(`Cached map file size: ${stats.size} bytes`);
            sendDownloadProgress(event, { mapId, status: 'cached', progress: 100 });
        } else {
            log('Starting download...');
            sendDownloadProgress(event, { mapId, status: 'starting', progress: 0 });
            await downloadMapFile(downloadUrl, mapPath, event, mapId);
        }
        
        log(`Map file exists: ${fs.existsSync(mapPath)}`);
        if (fs.existsSync(mapPath)) {
            const stats = fs.statSync(mapPath);
            log(`Map file size: ${stats.size} bytes`);
        }
        
        if (exePath) {
            log(`Found Trackmania at: ${exePath}`);
            if (!isRunning) {
                log('Trackmania not running, launching first...');
                await startTrackmania(exePath);
                
                sendDownloadProgress(event, { mapId, status: 'waiting', progress: 60 });
                log('Waiting for Trackmania to start (polling every 2s)...');
                
                let attempts = 0;
                const maxAttempts = 60;
                let processStarted = false;
                
                while (attempts < maxAttempts && !processStarted) {
                    await delay(2000, undefined, { signal: launchAbortController.signal });
                    attempts++;
                    
                    processStarted = await checkTrackmaniaRunning();
                    if (processStarted) {
                        log('Trackmania process detected');
                    }
                    
                    const progress = 60 + Math.min(attempts, 35);
                    sendDownloadProgress(event, { mapId, status: 'waiting', progress, attempts });
                }

                if (!processStarted) {
                    throw new Error('Timeout waiting for Trackmania to start');
                }
            }

            await waitForTrackmaniaLogin(event, mapId);
            sendDownloadProgress(event, { mapId, status: 'launching', progress: 90 });
            
            log(`Opening map: ${mapPath}`);
            launchAbortController.signal.throwIfAborted();
            const openError = await shell.openPath(mapPath);
            if (openError) throw new Error('Could not open the map. Set the Trackmania executable in Settings and check the .Gbx file association.');
            log('shell.openPath called');
            sendDownloadProgress(event, { mapId, status: 'complete', progress: 100 });
            return { success: true, method: 'shell-openPath' };
        } else {
            log(`Exe not found, trying shell.openPath`);
            launchAbortController.signal.throwIfAborted();
            const openError = await shell.openPath(mapPath);
            if (openError) throw new Error('Could not open the map. Set the Trackmania executable in Settings and check the .Gbx file association.');
            sendDownloadProgress(event, { mapId, status: 'complete', progress: 100 });
            return { success: true, method: 'shell-open' };
        }
    } catch (error) {
        const cancelled = launchAbortController.signal.aborted;
        if (mapPath) cleanupFile(`${mapPath}.part`);
        log(`Error: ${error.message}`);
        log(`Stack: ${error.stack}`);
        sendDownloadProgress(event, { mapId, status: cancelled ? 'cancelled' : 'error', error: error.message });
        return { success: false, cancelled, error: cancelled ? 'Launch cancelled' : error.message };
    } finally {
        cancelDownloadId = null;
        activeDownloadId = null;
        launchAbortController = null;
    }
});

handleIpc('is-map-cached', async (event, mapId) => {
    try {
        const id = normalizeMapId(mapId);
        return isValidCachedMap(path.join(os.tmpdir(), 'trackmania-maps', `${id}.Map.Gbx`));
    } catch (error) {
        log(`[Cache] ${error.message}`);
        return false;
    }
});

handleIpc('get-cached-map-ids', async () => {
    try {
        const tempDir = path.join(os.tmpdir(), 'trackmania-maps');
        const files = await fs.promises.readdir(tempDir).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        const mapIds = files.filter(file => /^\d+\.Map\.Gbx$/.test(file) && isValidCachedMap(path.join(tempDir, file)))
            .map(file => Number(file.split('.')[0]));
        return { success: true, mapIds };
    } catch (error) {
        log(`[Cache] Could not list maps: ${error.message}`);
        return { success: false, error: error.message, mapIds: [] };
    }
});

handleIpc('clear-cached-maps', async () => {
    try {
        if (activeDownloadId !== null) return { success: false, error: 'Cancel the current launch before clearing cached maps.' };
        const tempDir = path.join(os.tmpdir(), 'trackmania-maps');
        if (!fs.existsSync(tempDir)) return { success: true, count: 0 };
        const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.Map.Gbx'));
        for (const file of files) {
            fs.unlinkSync(path.join(tempDir, file));
        }
        log(`Cleared ${files.length} cached maps`);
        return { success: true, count: files.length };
    } catch (error) {
        log(`Error clearing cached maps: ${error.message}`);
        return { success: false, error: error.message };
    }
});

function startTrackmania(exePath, args = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(exePath, args, { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
    });
}

handleIpc('open-map-direct', async (event, mapId) => {
    try {
        mapId = normalizeMapId(mapId);
        if (config.trackmaniaPath && fs.existsSync(config.trackmaniaPath)) {
            await startTrackmania(config.trackmaniaPath, [`/joinmap=${mapId}`]);
        } else {
            await shell.openExternal(`trackmania://joinmap/${mapId}`);
        }
        return { success: true };
    } catch (error) {
        log(`[Open] Direct launch failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

handleIpc('get-trackmania-path', async () => {
    return config.trackmaniaPath || null;
});

handleIpc('select-trackmania-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Trackmania.exe',
        filters: [{ name: 'Executables', extensions: ['exe'] }],
        properties: ['openFile']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        if (selectedPath.toLowerCase().endsWith('trackmania.exe')) {
            persistConfigPatch({ trackmaniaPath: selectedPath });
            return { success: true, path: selectedPath };
        } else {
            return { success: false, error: 'Please select a file named Trackmania.exe' };
        }
    }
    return { success: false, canceled: true };
});

handleIpc('get-tmx-user', async () => {
    return config.tmxUser || null;
});

handleIpc('save-tmx-user', async (event, payload) => {
    try {
        const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 200) : '';
        const userId = Number.isSafeInteger(Number(payload?.userId)) && Number(payload?.userId) > 0 ? Number(payload.userId) : null;
        persistConfigPatch({ tmxUser: name || userId ? { name, userId } : null });
        return { success: true };
    } catch (error) {
        log(`Error saving TMX user: ${error.message}`);
        return { success: false, error: error.message };
    }
});

handleIpc('get-local-pbs', async () => {
    try {
        const pbs = await loadLocalPersonalBests();
        return { success: true, pbs };
    } catch (error) {
        log(`Error loading local PBs: ${error.message}`);
        return { success: false, error: error.message };
    }
});

handleIpc('save-filter-state', async (event, state) => {
    try {
        persistConfigPatch({ filterState: validateFilterState(state) });
        return { success: true };
    } catch (error) {
        log(`Error saving filter state: ${error.message}`);
        return { success: false, error: error.message };
    }
});

handleIpc('load-filter-state', async () => {
    try {
        return config.filterState ? validateFilterState(config.filterState) : null;
    } catch (error) {
        log(`Error loading filter state: ${error.message}`);
        return null;
    }
});

handleIpc('cancel-download', async (event, mapId) => {
    try { mapId = normalizeMapId(mapId); } catch (error) { return false; }
    if (cancelDownloadId === mapId) {
        cancelDownloadId = null;
        launchAbortController?.abort();
        log(`Download cancelled for map: ${mapId}`);
        return true;
    }
    return false;
});

handleIpc('check-clean-marker', async () => {
    const markerPath = path.join(os.tmpdir(), 'trackmania-clean-marker');
    try {
        if (fs.existsSync(markerPath)) {
            fs.unlinkSync(markerPath);
            log('Clean marker found and removed');
            return true;
        }
    } catch (error) {
        log(`Error checking clean marker: ${error.message}`);
    }
    return false;
});

handleIpc('log', async (event, message) => {
    if (typeof message !== 'string') return { success: false, error: 'Invalid log message' };
    log(`[Renderer] ${message.slice(0, 2000)}`);
    return { success: true };
});

handleIpc('nadeo-login-ubisoft', async (event, payload) => {
    try {
        const { email, password } = payload || {};
        if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > 320 || password.length > 1024) throw new Error('Invalid login details');
        const result = await loginWithUbisoft(email, password);
        return result;
    } catch (error) {
        log(`Nadeo Ubisoft login failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

handleIpc('nadeo-login-oauth', async (event, payload) => {
    try {
        const { clientId, clientSecret } = payload || {};
        if (typeof clientId !== 'string' || typeof clientSecret !== 'string' || !clientId || !clientSecret || clientId.length > 1024 || clientSecret.length > 1024) throw new Error('Invalid OAuth details');
        const result = await loginWithOAuth(clientId, clientSecret);
        return result;
    } catch (error) {
        log(`Nadeo OAuth login failed: ${error.message}`);
        stopOAuthServer();
        return { success: false, error: error.message };
    }
});

handleIpc('nadeo-logout', async () => {
    logoutNadeo();
    return { success: true };
});

handleIpc('nadeo-status', async () => {
    return {
        authenticated: isNadeoAuthenticated(),
        authMethod: config.nadeoAuthMethod || null,
        accountId: nadeoAccountId,
    };
});

handleIpc('nadeo-get-pbs', async (event, payload) => {
    try {
        const mapUids = payload?.mapUids;
        if (!Array.isArray(mapUids) || mapUids.length > 1000) throw new Error('Invalid map UID list');
        mapUids.forEach(validateMapUid);
        if (!isNadeoAuthenticated()) {
            return { success: false, error: 'Not authenticated', pbs: {} };
        }
        const pbs = await fetchNadeoPbs(mapUids || []);
        return { success: true, pbs };
    } catch (error) {
        log(`Error fetching Nadeo PBs: ${error.message}`);
        return { success: false, error: error.message, pbs: {} };
    }
});

handleIpc('nadeo-restore-session', async () => {
    try {
        const restored = await restoreNadeoSession();
        return { success: restored };
    } catch (error) {
        log(`Nadeo session restore failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

handleIpc('tmio-get-auth-token', async () => {
    return config.tmioAuthToken || null;
});

handleIpc('tmio-save-auth-token', async (event, token) => {
    try {
        if (typeof token !== 'string' || token.length > 8192) throw new Error('Invalid auth token');
        const trimmed = token.trim();
        persistConfigPatch({ tmioAuthToken: trimmed || null });
        resetTmioCache();
        return { success: true };
    } catch (error) {
        log(`Error saving TMIO auth token: ${error.message}`);
        return { success: false, error: error.message };
    }
});

handleIpc('tmio-get-pbs', async (event, payload) => {
    try {
        const mapUids = payload?.mapUids;
        if (!Array.isArray(mapUids) || mapUids.length > 1000) throw new Error('Invalid map UID list');
        mapUids.forEach(validateMapUid);
        if (!config.tmioAuthToken) {
            return { success: false, error: 'Not authenticated', pbs: {} };
        }
        const pbs = await fetchTmioPbs(mapUids || []);
        return { success: true, pbs };
    } catch (error) {
        log(`Error fetching trackmania.io PBs: ${error.message}`);
        return { success: false, error: error.message, pbs: {} };
    }
});

handleIpc('tmio-get-pb-single', async (event, payload) => {
    try {
        const pb = await getTmioPersonalBest(payload?.mapUid, payload?.forceRefresh === true);
        return { success: true, pb };
    } catch (error) {
        log(`[TMIO] PB lookup failed: ${error.message}`);
        return { success: false, error: error.message, retryAfterMs: error.retryAfterMs || 0 };
    }
});

let tmioLoginWindow = null;

handleIpc('tmio-login', async () => {
    return new Promise(resolve => {
        tmioLoginWindow?.close();
        const loginWindow = new BrowserWindow({
            width: 900, height: 700, title: 'Login to trackmania.io',
            webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        tmioLoginWindow = loginWindow;
        let resolved = false;
        let polling = false;
        let pollInterval;
        let loginTimeout;

        function finish(result) {
            if (resolved) return;
            resolved = true;
            clearInterval(pollInterval);
            clearTimeout(loginTimeout);
            if (tmioLoginWindow === loginWindow) tmioLoginWindow = null;
            if (!loginWindow.isDestroyed()) loginWindow.close();
            resolve(result);
        }

        async function checkForToken() {
            if (resolved || polling || loginWindow.isDestroyed()) return;
            polling = true;
            try {
                if (new URL(loginWindow.webContents.getURL()).origin !== 'https://trackmania.io') return;
                const token = await loginWindow.webContents.executeJavaScript('localStorage.getItem("tmio-secret")', true);
                if (resolved || loginWindow.isDestroyed()) return;
                if (typeof token === 'string' && token.length > 10 && token.length <= 8192) {
                    try { persistConfigPatch({ tmioAuthToken: token }); }
                    catch (error) {
                        finish({ success: false, error: 'Could not save login. Please retry.' });
                        return;
                    }
                    resetTmioCache();
                    log('[TMIO] Login saved successfully');
                    finish({ success: true });
                }
            } catch (error) {
                // Navigation may interrupt token retrieval. The next poll retries it.
            } finally {
                polling = false;
            }
        }

        pollInterval = setInterval(checkForToken, 1000);
        loginTimeout = setTimeout(() => finish({ success: false, error: 'Login timed out. Please retry.' }), 5 * 60 * 1000);
        loginWindow.webContents.on('did-finish-load', checkForToken);
        loginWindow.on('closed', () => finish({ success: false, error: 'Login window closed' }));
        loginWindow.loadURL('https://trackmania.io').catch(error => {
            log(`[TMIO] Login page failed: ${error.message}`);
            finish({ success: false, error: 'Could not load trackmania.io. Check your connection and retry.' });
        });
    });
});
