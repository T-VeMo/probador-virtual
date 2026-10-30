// Puente seguro entre la ventana y el proceso principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tryon', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key),
  setPrefs: (prefs) => ipcRenderer.invoke('settings:setPrefs', prefs),
  getToken: () => ipcRenderer.invoke('decart:token'),
  fetchImage: (url) => ipcRenderer.invoke('image:fetch', url),
  close: () => ipcRenderer.send('window:close'),
  minimize: () => ipcRenderer.send('window:minimize'),
  pin: (on) => ipcRenderer.send('window:pin', on),
  openExternal: (url) => ipcRenderer.send('open:external', url),
  log: (level, msg, data) => ipcRenderer.send('log', level, String(msg), data ? JSON.stringify(data).slice(0, 800) : ''),
});
