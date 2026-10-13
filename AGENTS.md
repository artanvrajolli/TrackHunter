# AGENTS.md - TrackHunter

Electron desktop app for browsing and downloading Trackmania maps from the Trackmania Exchange API. Vanilla JavaScript (ES6+), no framework, no build system or bundler.

## Build & Run Commands

```bash
npm install            # Install dependencies
npm run start          # Launch Electron in dev mode
npm run build          # Build Windows executable (NSIS installer + portable)
npm run track:clean    # Clean temp maps and history files
npm run check          # Check main, preload, scripts, tests, and inline renderer syntax
npm test               # Run isolated regression tests (Node 20+)
```

Run `npm run check` and `npm test` after functional changes. No lint or typecheck commands exist. Also verify UI changes manually via `npm run start` and check:
- Browser DevTools console (renderer errors)
- Log file at `%TEMP%/trackmania-viewer.log` (main process logs)

CI runs on `v*` tag push via `.github/workflows/build.yml` (Node 20, Windows). It runs `npm ci`, syntax checks, regression tests, and `npm run build`, then creates a draft GitHub release. `.github/workflows/check.yml` checks pushes to main and pull requests on Windows and Linux with Node 20.

## File Structure

| File | Purpose |
|---|---|
| `main.js` | Electron main process: window, IPC handlers, file I/O, game integration |
| `preload.js` | Context bridge — exposes IPC methods via `contextBridge.exposeInMainWorld()` |
| `index.html` | Renderer: all UI HTML, inline CSS (`<style>`), inline JS (`<script>`) |
| `scripts/track-clean.js` | Utility to purge temp map/history files |
| `scripts/check.js` | Syntax checks, including the inline renderer script |
| `tests/*.test.js` | Isolated Node regression tests for main and renderer behavior |
| `.github/workflows/build.yml` | CI: builds on version tag push, creates GitHub release |

## IPC Pattern (3-step)

1. **main.js**: add handler with `handleIpc('channel-name', async (event, arg) => { ... })` (wraps `ipcMain.handle` with sender validation and error handling)
2. **preload.js**: expose via `methodName: (arg) => ipcRenderer.invoke('channel-name', arg)`
3. **index.html** `<script>`: call `window.electronAPI.methodName(arg)`

Always validate IPC arguments in main.js. Never expose `node` or `shell` directly to the renderer. IPC handlers should return `{ success, error, ...data }` objects so the renderer can branch on success/failure uniformly.

## JavaScript Conventions

- `const` by default, `let` only when reassignment is needed, never `var`
- Prefer `async/await` over raw Promises or callbacks
- Wrap all async ops in `try/catch` — log via `log()` function, show user-friendly message via `displayError()`
- Use CommonJS `require()` in main.js and preload.js (ES modules are not supported — electron-store@7 is CommonJS)
- Arrow functions for callbacks, named functions for top-level declarations
- Template literals for HTML generation and string interpolation
- No transpilation — write code that runs directly in Electron's Chromium + Node
- Dynamic `import()` is acceptable for ESM-only packages (e.g., `const { GBX } = await import('gbx')`)

## CSS Conventions

- All CSS is inline in `<style>` at the top of index.html
- kebab-case class names (`.map-card`, `.filter-bar`, `.pb-spinner`)
- CSS custom properties for colors (e.g., `--accent: #00ff88`)
- Flexbox for layout, no CSS frameworks
- No inline `style=""` attributes — always use classes

## HTML/JS in index.html

- `<style>` block at top, `<script>` block at bottom — no external files
- Event handlers via HTML attributes: `onclick="functionName()"`
- DOM access via `document.getElementById()` / `document.querySelector()`
- State stored in module-scoped `let`/`const` variables at top of `<script>`
- Persistent state via `electron-store` (main process) or `localStorage` (renderer)
- A single syntax error in `<script>` breaks the entire inline block — all functions become undefined

## Naming Conventions

| Type | Convention | Example |
|---|---|---|
| Variables/functions | camelCase | `mapId`, `fetchMaps`, `tmioPbs` |
| Constants | SCREAMING_SNAKE_CASE | `API_URL_BASE`, `BATCH_SIZE` |
| CSS classes | kebab-case | `.map-card`, `.personal-best` |
| IPC channels | kebab-case | `tmio-get-pb-single`, `open-trackmania` |
| Files | kebab-case | `main.js`, `preload.js` |

## Security

- `contextIsolation: true` and `nodeIntegration: false` are mandatory in BrowserWindow config
- All renderer↔main communication goes through preload.js contextBridge
- Never log or expose auth tokens, secrets, or file paths to the renderer console
- Validate and sanitize all IPC inputs in main.js handlers

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| electron | ^28.0.0 (dev) | Desktop app runtime |
| electron-builder | ^24.9.1 (dev) | Packaging (NSIS + portable) |
| electron-store | ^7.0.3 | Persistent key-value config |
| gbx | ^1.0.0-rc12 | GBX replay/map file parsing |
| gbxremote | ^0.2.1 | TM server protocol |
| trackmania.io | ^3.2.2 | Trackmania.io API client |

## Adding New Features

1. Define IPC handler in `main.js` with `handleIpc()`
2. Expose it in `preload.js` inside the `electronAPI` object
3. Add UI in `index.html` — HTML markup, CSS styles, JS handler functions
4. For persistent settings, use `electron-store` in main process; for session state, use JS variables in renderer

## Logging & Debugging

- Main process: use the `log()` function (writes to `%TEMP%/trackmania-viewer.log` and console)
- Renderer: call `window.electronAPI.log(message)` to forward logs to the main process log file
- Run `npm run check` and `npm test`; also exercise UI changes with `npm run start`
- Check DevTools console for renderer-side errors; check the log file for main process errors
- Prefix log messages with context tags (e.g., `[Download]`, `[GBX Telemetry]`, `[Open]`)

## Caching Pattern

Multiple in-memory caches with TTL are used throughout `main.js`:
- `localPbCache` / `LOCAL_PB_CACHE_TTL_MS` (60s) — local replay PBs
- `nadeoPbCache` / `NADEO_PB_CACHE_TTL_MS` (60s) — Nadeo API PBs
- `tmioRecordCache` / `TMIO_PB_CACHE_TTL_MS` (60s) — trackmania.io PBs per map and account session, including successful lookups with no record

Pattern: check `Date.now() - cacheAt < TTL`, return cached if fresh, otherwise fetch and update. `tmioPendingRecords` deduplicates in-flight PB lookups; account changes clear caches. Transient failures are never cached as missing records.

## Rate Limiting

trackmania.io enforces ~40 req/min. All TMIO lookups use a main-process queue with `TMIO_RATE_LIMIT_MS = 1600` between request starts. A 429 pauses all queued lookups for at least 60 seconds, respecting a longer `Retry-After` header. The renderer retries visible failures after the cooldown.

## Common Pitfalls

- **ES module errors**: Keep electron-store at v7 (CommonJS). v8+ requires ESM.
- **Syntax errors in `<script>`**: A single syntax error (e.g., stray `return` outside a function) breaks the entire inline script block — all functions become undefined.
- **Rate-limited APIs**: use `getTmioPersonalBest()` so all trackmania.io lookups share pacing, deduplication, and cooldown handling.
- **Stale observer references**: After re-rendering `content.innerHTML`, all DOM references and observers are invalidated. Call `setupTmioObserver()` again after each render.
- **Dynamic import in CommonJS**: `gbx` is ESM-only; use `const { GBX } = await import('gbx')` inside an async function, not at module top level.

## Replay File Watcher

`main.js` watches `Documents/Trackmania/Replays/Autosaves` for new `*personalbest*.replay.gbx` files via `fs.watch`. When detected:
1. File is parsed with `gbx` to extract map UID and time
2. `replay-new-pb` IPC event is sent to the renderer
3. Renderer applies the local replay time to the card and history immediately, then forces an online PB refresh if authenticated

Flow: `setupReplayWatcher()` → `fs.watch` callback → `parseReplayForMapUid()` → `mainWindow.webContents.send('replay-new-pb')` → `window.electronAPI.onReplayNewPb()` in renderer → `tmioGetPbSingle` → `updateMapCardPb`

## Key APIs Used

- **Trackmania Exchange**: `https://trackmania.exchange/api/maps` — map search, metadata, thumbnails
- **Trackmania.io**: `https://trackmania.io/api/leaderboard/personal/map/{mapUid}` — personal bests
- **Nadeo**: `https://prod.trackmania.core.nadeo.online/` — official API for records, maps, auth
- **Ubisoft**: `https://public-ubiservices.ubi.com/v3/profiles/sessions` — authentication
- Auth token stored in browser localStorage under key `tmio-secret` on trackmania.io

## Reliability patterns

- Register IPC via `handleIpc()`, which rejects requests from other windows/frames and converts unexpected exceptions to structured failures. Validate payloads inside each handler too.
- Use `persistConfigPatch()` for settings changes; it writes configuration atomically and restores the previous in-memory values if saving fails.
- Downloads stream through GBX signature validation into `.part` files, then rename on completion. `launchAbortController` cancels transfers and startup waits; release the launch lock only in `finally`.
- Use `getCachedMapIds()` for bulk cache discovery instead of one IPC call per map.
- Map refreshes use an abort controller and request generation so late responses cannot replace current results. Invalidate `preprocessedMaps` when map data changes.
- Do not interpolate map names into JavaScript event handler strings; use escaped `data-map-name` attributes.

## Error Handling

- IPC handlers: return `{ success: false, error: error.message }` on failure, never throw
- API calls: retry with backoff on 5xx errors (downloadMapFile has 3 retries with 2s delay)
- Nadeo API: auto-refreshes expired tokens on 401 (1 retry via `nadeoApiRequest(url, retries=1)`)
- All catch blocks should call `log()` for diagnostics and return a graceful fallback value
