const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
    let win = new BrowserWindow({width: 800, height: 600, webPreferences: { contextIsolation: true, nodeIntegration: false }});
    win.loadURL('https://connect.ubisoft.com/login');
    
    win.webContents.session.webRequest.onCompleted({urls: ['*://public-ubiservices.ubi.com/v3/profiles/sessions*']}, async (details) => {
        if (details.method === 'POST') {
            console.log('User logged in to Ubisoft Connect. Getting Ubi Ticket...');
            try {
                const ticket = await win.webContents.executeJavaScript('window.localStorage.getItem("PROD_UBI_TICKET")');
                if (ticket) {
                    console.log('Ticket length:', ticket.length, ticket.substring(0, 20));
                    
                    // Now do token exchange for Nadeo core
                    const fetch = require('node-fetch') || globalThis.fetch; 
                    const response = await fetch('https://prod.trackmania.core.nadeo.online/v2/authentication/token/ubiservices', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'ubi_v1 t=' + ticket
                        },
                        body: JSON.stringify({ audience: "NadeoLiveServices" })
                    });
                    const json = await response.json();
                    console.log('Nadeo Live Token:', json.accessToken ? 'OK' : 'FAIL', json);
                    
                    if (json.accessToken) {
                        const recordRes = await fetch('https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/Personal_Best/map/lD_igtNjrujFLZe3kgWxV85aGYj/surround/1/1?onlyWorld=true', {
                            headers: { 'Authorization': 'nadeo_v1 t=' + json.accessToken }
                        });
                        const recordJson = await recordRes.json();
                        console.log('Map PB:', JSON.stringify(recordJson));
                    }
                    
                    app.quit();
                }
            } catch (e) {
                console.error(e);
            }
        }
    });
});
