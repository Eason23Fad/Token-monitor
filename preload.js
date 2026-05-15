const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('minimize'),
  close: () => ipcRenderer.send('close'),
  fetchAll: (apiKey) => ipcRenderer.invoke('api:fetch', apiKey),
  getProxyStats: () => ipcRenderer.invoke('api:getProxyStats'),
  startProxy: () => ipcRenderer.invoke('api:startProxy'),
  stopProxy: () => ipcRenderer.invoke('api:stopProxy'),
  resetProxyStats: () => ipcRenderer.invoke('api:resetProxyStats'),
});
