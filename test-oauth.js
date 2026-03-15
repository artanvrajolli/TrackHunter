const { app, BrowserWindow, session } = require('electron');
app.whenReady().then(() => {
    let win = new BrowserWindow({width: 800, height: 600});
    win.loadURL('https://players.trackmania.com/');
    win.webContents.on('did-navigate', (event, url) => {
        console.log('Navigated to:', url);
    });
    session.defaultSession.webRequest.onSendHeaders((details) => {
        if (details.requestHeaders['Authorization']) {
            console.log('Got Auth Header for:', details.url);
            console.log('Auth:', details.requestHeaders['Authorization'].substring(0, 30) + '...');
        }
    });
});
