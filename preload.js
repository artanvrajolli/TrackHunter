const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    openTrackmania: (mapId) => ipcRenderer.invoke('open-trackmania', mapId),
    openMapDirect: (mapId) => ipcRenderer.invoke('open-map-direct', mapId),
    isMapCached: (mapId) => ipcRenderer.invoke('is-map-cached', mapId),
    getCachedMapIds: () => ipcRenderer.invoke('get-cached-map-ids'),
    clearCachedMaps: () => ipcRenderer.invoke('clear-cached-maps'),
    saveFilterState: (state) => ipcRenderer.invoke('save-filter-state', state),
    loadFilterState: () => ipcRenderer.invoke('load-filter-state'),
    getTrackmaniaPath: () => ipcRenderer.invoke('get-trackmania-path'),
    selectTrackmaniaPath: () => ipcRenderer.invoke('select-trackmania-path'),
    getTmxUser: () => ipcRenderer.invoke('get-tmx-user'),
    saveTmxUser: (payload) => ipcRenderer.invoke('save-tmx-user', payload),
    getLocalPbs: () => ipcRenderer.invoke('get-local-pbs'),
    checkCleanMarker: () => ipcRenderer.invoke('check-clean-marker'),
    cancelDownload: (mapId) => ipcRenderer.invoke('cancel-download', mapId),
    log: (message) => ipcRenderer.invoke('log', message),
    getControllerStatus: () => ipcRenderer.invoke('get-controller-status'),
    setControllerOverlayEnabled: (enabled) => ipcRenderer.invoke('set-controller-overlay-enabled', enabled),
    openControllerOverlay: () => ipcRenderer.invoke('open-controller-overlay'),
    closeControllerOverlay: () => ipcRenderer.invoke('close-controller-overlay'),
    onControllerAction: (callback) => {
        const listener = (event, action) => callback(action);
        ipcRenderer.on('controller-action', listener);
        return () => ipcRenderer.removeListener('controller-action', listener);
    },
    onControllerStatus: (callback) => {
        const listener = (event, status) => callback(status);
        ipcRenderer.on('controller-status', listener);
        return () => ipcRenderer.removeListener('controller-status', listener);
    },
    onControllerOverlayShown: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('controller-overlay-shown', listener);
        return () => ipcRenderer.removeListener('controller-overlay-shown', listener);
    },
    onControllerOverlayHidden: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('controller-overlay-hidden', listener);
        return () => ipcRenderer.removeListener('controller-overlay-hidden', listener);
    },
    nadeoLoginUbisoft: (payload) => ipcRenderer.invoke('nadeo-login-ubisoft', payload),
    nadeoLoginOAuth: (payload) => ipcRenderer.invoke('nadeo-login-oauth', payload),
    nadeoLogout: () => ipcRenderer.invoke('nadeo-logout'),
    nadeoStatus: () => ipcRenderer.invoke('nadeo-status'),
    nadeoGetPbs: (payload) => ipcRenderer.invoke('nadeo-get-pbs', payload),
    nadeoRestoreSession: () => ipcRenderer.invoke('nadeo-restore-session'),
    tmioGetAuthToken: () => ipcRenderer.invoke('tmio-get-auth-token'),
    tmioSaveAuthToken: (token) => ipcRenderer.invoke('tmio-save-auth-token', token),
    tmioGetPbs: (payload) => ipcRenderer.invoke('tmio-get-pbs', payload),
    tmioGetPbSingle: (payload) => ipcRenderer.invoke('tmio-get-pb-single', payload),
    tmioLogin: () => ipcRenderer.invoke('tmio-login'),
    onDownloadProgress: (callback) => {
        const listener = (event, data) => callback(data);
        ipcRenderer.on('download-progress', listener);
        return () => ipcRenderer.removeListener('download-progress', listener);
    },
    onReplayNewPb: (callback) => {
        const listener = (event, data) => callback(data);
        ipcRenderer.on('replay-new-pb', listener);
        return () => ipcRenderer.removeListener('replay-new-pb', listener);
    }
});
