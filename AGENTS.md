# AGENTS.md - Trackmania Map Viewer

## Project Overview

This is an Electron-based desktop application for browsing and downloading Trackmania maps from the Trackmania Exchange API. It uses vanilla JavaScript (ES6+) with no build system or framework.

## Build Commands

```bash
# Install dependencies
npm install

# Start development mode
npm run start

# Build production executable
npm run build
```

- `npm run start` - Runs the Electron app in development mode
- `npm run build` - Uses electron-builder to create Windows executable (NSIS installer)

## Code Style Guidelines

### General Principles

- Use ES6+ features (const/let, arrow functions, template literals, async/await)
- Keep code simple and readable - no over-engineering
- Use descriptive variable and function names
- Add comments only when code intent is not obvious

### File Structure

- **main.js** - Electron main process (window management, IPC handlers, file operations)
- **preload.js** - Preload script for secure context bridge between main and renderer
- **index.html** - Renderer process (UI and frontend JavaScript)
- **package.json** - Project configuration

### JavaScript (main.js, preload.js)

- Use CommonJS `require()` for Node.js modules
- Use `const` by default, `let` only when reassignment is needed
- Prefer `async/await` over raw promises or callbacks
- Use `ipcMain.handle()` for request-response IPC patterns
- Use `contextBridge.exposeInMainWorld()` to expose APIs to renderer

Example IPC handler:
```javascript
ipcMain.handle('my-handler', async (event, arg) => {
    // async operations here
    return result;
});
```

### HTML/CSS (index.html)

- Inline CSS in `<style>` tag at top of HTML
- Inline JavaScript in `<script>` tag at bottom of HTML
- Use kebab-case for CSS class names
- Use semantic HTML elements
- Use flexbox for layout
- Use CSS custom properties (variables) for colors

### Naming Conventions

- **Variables/functions**: camelCase (e.g., `mapId`, `fetchMaps`)
- **Constants**: SCREAMING_SNAKE_CASE (e.g., `API_URL_BASE`)
- **CSS classes**: kebab-case (e.g., `.map-card`, `.filter-bar`)
- **Files**: kebab-case (e.g., `main.js`, `preload.js`)

### Error Handling

- Wrap async operations in try/catch blocks
- Log errors with meaningful messages using the `log()` function
- Display user-friendly error messages in the UI
- Always handle potential null/undefined values

Example:
```javascript
try {
    const data = await fetchData();
    processData(data);
} catch (error) {
    log(`Error processing data: ${error.message}`);
    displayError('Failed to process data');
}
```

### UI Patterns

- Use CSS classes for styling (no inline styles)
- Use event handlers in HTML (e.g., `onclick="functionName()"`)
- Use template literals for generating HTML
- Use `loading="lazy"` for images

### Working with the Renderer Process

- All DOM manipulation should be in index.html's `<script>` section
- Use `document.getElementById()` and `document.querySelector()` for DOM access
- Use `addEventListener()` for event handling
- Use `localStorage` or `electron-store` for persistent data

### API Integration

- Use `fetch()` for HTTP requests
- Use async/await for API calls
- Handle API errors gracefully
- Use loading states during async operations

Example:
```javascript
async function fetchMaps() {
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Failed to fetch maps:', error);
        return null;
    }
}
```

### Security

- Never use `nodeIntegration: true` in BrowserWindow
- Always use `contextIsolation: true`
- Use preload script with contextBridge for IPC
- Validate all IPC arguments
- Don't expose sensitive APIs to renderer

### Testing

- No formal test framework is set up
- Test manually by running `npm run start`
- Check browser console for JavaScript errors
- Check the log file at `%TEMP%/trackmania-viewer.log` for main process logs

### Adding New Features

1. **IPC Communication**: Add handler in main.js, expose in preload.js, call in renderer
2. **UI Elements**: Add HTML in index.html, add CSS in style tag, add JS handlers
3. **State Management**: Use JavaScript variables for runtime state, electron-store for persistence

### Dependencies

- **electron** (^28.0.0) - Desktop app framework
- **electron-builder** (^24.9.1) - Build tool for creating executables
- **electron-store** (^8.2.0) - Persistent key-value storage

### Common Issues

- **Module not found**: Ensure npm install was run
- **ES Module error**: Use electron-store@8 for CommonJS compatibility
- **Context isolation errors**: Check preload.js contextBridge setup

### Resources

- Electron Docs: https://www.electronjs.org/docs
- Trackmania Exchange API: https://trackmania.exchange/
