# TrackHunter

A desktop application for browsing and downloading Trackmania maps from the Trackmania Exchange API.

## Features

- Browse Trackmania maps from TM Exchange
- Download maps directly to your game
- Filter Nadeo campaign maps by year, season, and campaign color
- Search maps by name and sort the results
- View thumbnails, medal targets, and personal bests from trackmania.io
- Relaunch maps from your recent history
- Reuse downloaded maps and cancel downloads or launch preparation

## Installation

### From Release
Download the latest release from the [Releases](https://github.com/artanvrajolli/TrackHunter/releases) page:
- **Portable**: Run directly without installation
- **Setup**: Install to your system

### Build from Source

```bash
# Install the locked dependency versions
npm ci

# Start in development mode
npm run start

# Check all JavaScript, including the inline renderer script
npm run check

# Run regression tests (Node 20 or newer)
npm test

# Build the Windows executable
npm run build
```

## Everyday use

Click a map to download and open it in Trackmania. If automatic detection fails, choose `Trackmania.exe` in Settings. Map launching requires Windows and a working `.Gbx` file association.

- **Ctrl/Cmd+F** focuses the map search; **Escape** clears a focused search.
- **Tab** moves between controls and map cards; **Enter/Space** activates a card.
- **Ctrl/Cmd+Click** opens the map's Exchange page in your default browser.
- **Escape** closes Settings or History, or cancels launch preparation. The launch dialog also has a Cancel button.

Filter choices, including All Years, and the window size are remembered. Failed map refreshes keep the previous results visible and offer Retry. Downloads become cached only after a complete transfer with a valid GBX signature; a failed game launch keeps the downloaded map available for another attempt.

Connect trackmania.io in Settings to load online PBs. Requests are paced across the app, repeated lookups are cached for 60 seconds, and rate limits pause lookups before automatic retry. New local PB replays update visible cards and history immediately while the online record catches up.

## Verification

`npm run check` validates JavaScript syntax without starting Electron. `npm test` uses Node's built-in test runner with isolated temporary folders and a local HTTP server; it does not launch Trackmania or use real credentials. The regression suite covers interrupted downloads, cancellation, redirects, failed launches, cache integrity, IPC validation, settings write failures, PB caching/rate limits, stale map responses, and debounced search.

For changes to the desktop UI, also run `npm run start` and inspect the renderer console and `%TEMP%/trackmania-viewer.log`. Actual game launch, Ubisoft authentication, and replay detection require a Windows machine with Trackmania installed. CI runs syntax and regression checks on Windows and Linux; tagged releases also run those checks before packaging.

## Tech Stack

- **Electron** - Desktop application framework
- **Trackmania Exchange API** - Map data source

## License

MIT
