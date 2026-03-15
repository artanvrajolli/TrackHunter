const { app, BrowserWindow, session } = require('electron');
app.whenReady().then(() => {
    let win = new BrowserWindow({width: 800, height: 600, webPreferences: { nodeIntegration: false }});
    win.loadURL('https://connect.ubisoft.com/login');
    
    // We poll localStorage every second to see if a token appears
    setInterval(async () => {
        try {
            const loc = await win.webContents.executeJavaScript('JSON.stringify(localStorage);');
            if (loc.includes('ticket') || loc.includes('token')) {
                console.log('Got LocalStorage:', loc.substring(0, 100));
            }
        } catch(e) {}
    }, 1000);
});
