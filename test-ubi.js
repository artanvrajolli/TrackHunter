const { app, BrowserWindow, session } = require('electron');
app.whenReady().then(() => {
    let win = new BrowserWindow({width: 800, height: 600});
    win.loadURL('https://connect.ubisoft.com/login');
    win.webContents.on('did-navigate', (event, url) => {
        console.log('Navigated to:', url);
    });
    session.defaultSession.webRequest.onSendHeaders((details) => {
        const auth = details.requestHeaders['Authorization'];
        const ubiAppId = details.requestHeaders['Ubi-AppId'];
        if ((auth && auth.startsWith('Ubi_v1')) || ubiAppId) {
            console.log('Headers:', details.url, auth, ubiAppId);
        }
    });
});
