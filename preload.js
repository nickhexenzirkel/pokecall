/*
 * PokeCall - preload
 * Ponte segura entre o renderer (a interface) e o processo principal.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pokecall', {
  // Retorna a lista de telas/janelas para o usuario escolher o que compartilhar.
  getSources: () => ipcRenderer.invoke('get-sources'),

  // Controles da barra de titulo personalizada.
  win: {
    minimize: () => ipcRenderer.send('win-minimize'),
    maximize: () => ipcRenderer.send('win-maximize'),
    close: () => ipcRenderer.send('win-close'),
  },

  // Atualização automática.
  updates: {
    onAvailable: (cb) => ipcRenderer.on('update-available', (_e, v) => cb(v)),
    onDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, v) => cb(v)),
    restart: () => ipcRenderer.send('restart-to-update'),
  },
});
