/*
 * PokeCall - processo principal do Electron
 * Cria a janela do app e expoe a captura de tela (desktopCapturer) para o renderer.
 */

const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// Corrige a "tela preta" ao RECEBER o compartilhamento de tela de outra pessoa:
// a decodificação de vídeo por hardware (GPU) do Electron costuma falhar e
// entregar quadros pretos. Sem aceleração, decodifica por software e funciona.
app.disableHardwareAcceleration();

let mainWindow = null;

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
