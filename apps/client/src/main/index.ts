// The Electron entry point: wires createLoom to the window and IPC.
import { join } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { systemClock } from './clock';
import { bridgeBinaryPath } from './environments/bridge-path';
import { serveApi } from './ipc';
import { createLoom, type Loom } from './loom';

// Lets tests run the app against a temporary userData.
if (process.env.LOOM_USER_DATA_DIR) app.setPath('userData', process.env.LOOM_USER_DATA_DIR);

let window: BrowserWindow | undefined;
let loom: Loom | undefined;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Loom',
    backgroundColor: '#0f1117',
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true },
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

function bridgeDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bridge') : join(app.getAppPath(), '../../bridge/dist');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.on('window-all-closed', () => app.quit());

  let closing = false;
  app.on('will-quit', (event) => {
    if (!loom || closing) return;
    closing = true;
    event.preventDefault();
    void loom.close().finally(() => app.quit());
    loom = undefined;
  });

  void app.whenReady().then(async () => {
    try {
      loom = await createLoom({
        userDataDir: app.getPath('userData'),
        appVersion: app.getVersion(),
        bridgePath: bridgeBinaryPath(bridgeDir()),
        clock: systemClock,
        chooseFolder: async () => {
          const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
          const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
      });
    } catch (error) {
      console.error('Loom could not start:', error);
      dialog.showErrorBox('Loom could not start', (error as Error).message);
      app.exit(1);
      return;
    }
    serveApi(loom.api);
    window = createWindow();
    window.on('closed', () => (window = undefined));
  });
}
