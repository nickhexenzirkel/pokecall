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

  // Janela suspensa (overlay sempre no topo).
  overlay: {
    toggle: () => ipcRenderer.send('overlay-toggle'),
    close: () => ipcRenderer.send('overlay-close'),
    onVisible: (cb) => ipcRenderer.on('overlay-visible', (_e, v) => cb(v)),
    // App -> overlay (estado e mensagens).
    push: (payload) => ipcRenderer.send('overlay-state', payload),
    onState: (cb) => ipcRenderer.on('overlay-state', (_e, s) => cb(s)),
    // Overlay -> app (microfone, mensagem enviada).
    action: (payload) => ipcRenderer.send('overlay-action', payload),
    onAction: (cb) => ipcRenderer.on('overlay-action', (_e, a) => cb(a)),
    resize: (h) => ipcRenderer.send('overlay-resize', h),
    focusApp: () => ipcRenderer.send('focus-main'),
  },

  // Atualização automática.
  updates: {
    onAvailable: (cb) => ipcRenderer.on('update-available', (_e, v) => cb(v)),
    onDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, v) => cb(v)),
    restart: () => ipcRenderer.send('restart-to-update'),
  },
});
