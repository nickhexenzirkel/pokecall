/*
 * PokeCall - processo principal do Electron
 * Cria a janela do app e expoe a captura de tela (desktopCapturer) para o renderer.
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// OBS: NÃO desabilitar a aceleração de hardware. Isso trava/congela a captura
// e a decodificação de vídeo no Electron (bug conhecido do desktopCapturer).
// A "tela preta" em Netflix/Disney+/etc é DRM (resolve-se desligando a
// aceleração de hardware NO NAVEGADOR de quem compartilha), não aqui.

let mainWindow = null;
let overlayWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#1e1f22',
    title: 'PokeCall',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,            // janela sem moldura -> usamos barra de titulo propria
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Não desacelerar quando a janela perde o foco (Alt+Tab) — senão a
      // captura/compartilhamento de tela congela e fica preto para quem assiste.
      backgroundThrottling: false,
      // O Robô de Música toca sozinho (o player fica escondido), sem exigir
      // que cada pessoa clique em algo para o som começar.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow = win;
  return win;
}

// ------- Atualização automática (GitHub Releases) -------
function setupAutoUpdate() {
  if (!app.isPackaged) return; // só no app instalado, não em desenvolvimento

  const notify = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // se o usuário não reiniciar, instala ao fechar

  autoUpdater.on('update-available', (info) => notify('update-available', info?.version));
  autoUpdater.on('update-downloaded', (info) => notify('update-downloaded', info?.version));
  autoUpdater.on('error', (err) => console.error('autoUpdater', err));

  // Instala agora, quando o usuário clicar em "Reiniciar" no app.
  ipcMain.on('restart-to-update', () => {
    autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates().catch((err) => console.error('checkForUpdates', err));
  // Checa de novo a cada 30 min, caso o app fique aberto muito tempo.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000);
}

/* ================= JANELA SUSPENSA (OVERLAY) =================
 * Janelinha sempre no topo, para falar e comentar sem sair do que voce esta
 * assistindo (YouTube, jogo, etc). Fica por cima ate de janelas em tela cheia.
 */
const OVERLAY_MIN_W = 240;
const OVERLAY_MIN_H = 96;
const OVERLAY_MAX_W = 900;
const OVERLAY_MAX_H = 900;

// Lugar e tamanho da janelinha ficam salvos entre as sessoes.
function overlayStateFile() {
  return path.join(app.getPath('userData'), 'overlay-window.json');
}

function readOverlayState() {
  try {
    const raw = JSON.parse(fs.readFileSync(overlayStateFile(), 'utf8'));
    if (!raw || typeof raw.width !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
}

function saveOverlayState(extra) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    const b = overlayWindow.getBounds();
    const prev = readOverlayState() || {};
    fs.writeFileSync(
      overlayStateFile(),
      JSON.stringify({ ...b, manual: prev.manual, ...extra })
    );
  } catch {
    /* se nao der para salvar, tudo bem: volta ao padrao na proxima vez */
  }
}

// Garante que a janelinha nasca dentro de algum monitor que existe hoje.
function fitToDisplay(b) {
  const area = screen.getDisplayMatching(b).workArea;
  const width = Math.min(Math.max(b.width, OVERLAY_MIN_W), OVERLAY_MAX_W);
  const height = Math.min(Math.max(b.height, OVERLAY_MIN_H), OVERLAY_MAX_H);
  return {
    width,
    height,
    x: Math.min(Math.max(b.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(b.y, area.y), area.y + area.height - height),
  };
}

function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.showInactive();
    return overlayWindow;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const saved = readOverlayState();
  const start = fitToDisplay(
    saved || { width: 330, height: 190, x: area.x + area.width - 354, y: area.y + area.height - 214 }
  );
  const win = new BrowserWindow({
    width: start.width,
    height: start.height,
    x: start.x,
    y: start.y,
    minWidth: OVERLAY_MIN_W,
    minHeight: OVERLAY_MIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // O redimensionamento e feito pela alcinha do canto (janela transparente
    // nao lida bem com as bordas nativas de resize).
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'PokeCall',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' = nivel alto o bastante para ficar sobre janelas em tela cheia.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  win.once('ready-to-show', () => win.showInactive()); // aparece sem roubar o foco
  win.on('moved', () => saveOverlayState());
  win.on('close', () => saveOverlayState());
  win.on('closed', () => {
    overlayWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay-visible', false);
  });

  overlayWindow = win;
  return win;
}

function closeOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  overlayWindow = null;
}

ipcMain.on('overlay-toggle', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    closeOverlay();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay-visible', false);
  } else {
    createOverlay();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay-visible', true);
  }
});

ipcMain.on('overlay-close', () => {
  closeOverlay();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay-visible', false);
});

// App -> overlay (estado do microfone, quem transmite, mensagens novas).
ipcMain.on('overlay-state', (_e, payload) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('overlay-state', payload);
});

// Overlay -> app (ligar/desligar microfone, enviar mensagem).
ipcMain.on('overlay-action', (_e, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay-action', payload);
});

// A janelinha cresce/encolhe conforme as mensagens, ancorada embaixo.
// Só vale enquanto o usuário não define um tamanho na mão.
ipcMain.on('overlay-resize', (e, height) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const nh = Math.max(OVERLAY_MIN_H, Math.min(OVERLAY_MAX_H, Math.round(height)));
  if (nh === b.height) return;
  win.setBounds({ x: b.x, y: b.y + (b.height - nh), width: b.width, height: nh });
});

// Estado inicial da janelinha (tamanho manual ou automático).
ipcMain.handle('overlay-config', () => {
  const saved = readOverlayState();
  return { manual: !!(saved && saved.manual) };
});

ipcMain.handle('overlay-bounds', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win && !win.isDestroyed() ? win.getBounds() : null;
});

// Arrastar a alcinha do canto: o usuário passa a mandar no tamanho.
ipcMain.on('overlay-set-size', (e, size) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || !size) return;
  const b = win.getBounds();
  win.setBounds(fitToDisplay({
    x: b.x,
    y: b.y,
    width: Math.round(size.width),
    height: Math.round(size.height),
  }));
  saveOverlayState({ manual: true });
});

// Voltar ao tamanho automático (duplo clique na faixa de cima).
ipcMain.on('overlay-auto-size', () => saveOverlayState({ manual: false }));

// Trazer a janela principal para a frente (botao "abrir app" do overlay).
ipcMain.on('focus-main', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// Controles da janela (barra de titulo personalizada).
ipcMain.on('win-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('win-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

app.whenReady().then(() => {
  // Lista as telas e janelas disponiveis para compartilhar, com miniaturas.
  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
  });

  createWindow();
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => closeOverlay());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
