/*
 * PokeCall - processo principal do Electron
 * Cria a janela do app e expoe a captura de tela (desktopCapturer) para o renderer.
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
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
function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.showInactive();
    return overlayWindow;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const w = 330;
  const h = 190;
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: area.x + area.width - w - 24,
    y: area.y + area.height - h - 24,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
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
ipcMain.on('overlay-resize', (e, height) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const nh = Math.max(96, Math.min(560, Math.round(height)));
  if (nh === b.height) return;
  win.setBounds({ x: b.x, y: b.y + (b.height - nh), width: b.width, height: nh });
});

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
