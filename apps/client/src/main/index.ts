// The Electron entry point: wires createLoom to the window and IPC.
import { join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { THEMES, type Theme } from '../shared/appearance';
import { systemClock } from './clock';
import { bridgeBinaryPath } from './environments/bridge-path';
import { serveApi } from './ipc';
import { createLoom, type Loom } from './loom';

// Lets tests run the app against a temporary userData.
if (process.env.LOOM_USER_DATA_DIR) app.setPath('userData', process.env.LOOM_USER_DATA_DIR);

let window: BrowserWindow | undefined;
let loom: Loom | undefined;

function createWindow(theme: Theme): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Loom',
    // The saved theme's background, so the window never shows another first.
    backgroundColor: THEMES[theme].background,
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
        openExternal: (url) => shell.openExternal(url),
      });
    } catch (error) {
      console.error('Loom could not start:', error);
      dialog.showErrorBox('Loom could not start', (error as Error).message);
      app.exit(1);
      return;
    }
    serveApi(loom.api);
    // A topic gives its current value as soon as it's subscribed to, so the
    // saved theme is known before the window opens. A damaged database serves
    // no settings: the window opens with the default theme, and follows the
    // settings once a snapshot is restored.
    let theme: Theme | undefined;
    let stopWatchingTheme: (() => void) | undefined;
    const api = loom.api;
    const stopWatchingDatabase = api.subscribe('database', (database) => {
      if (database.state !== 'ok' || stopWatchingTheme) return;
      stopWatchingTheme = api.subscribe('settings', (settings) => {
        if (window && settings.theme !== theme) window.setBackgroundColor(THEMES[settings.theme].background);
        theme = settings.theme;
      });
    });
    window = createWindow(theme ?? 'midnight');
    window.on('closed', () => {
      window = undefined;
      stopWatchingDatabase();
      stopWatchingTheme?.();
    });
  });
}
