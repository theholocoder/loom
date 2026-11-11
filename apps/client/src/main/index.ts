// The Electron entry point: wires createLoom to the window and IPC.
import { join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { THEMES, type Theme } from '../shared/appearance';
import { MIN_WINDOW } from '../shared/window';
import { systemClock } from './clock';
import { bridgeBinaryPath } from './environments/bridge-path';
import { serveApi } from './ipc';
import { createLoom, type Loom } from './loom';
import { isWebLink } from '../shared/links';
import { guardQuit, quitQuestion } from './quit';
import type { Session } from '../shared/api';

// Lets tests run the app against a temporary userData.
if (process.env.LOOM_USER_DATA_DIR) app.setPath('userData', process.env.LOOM_USER_DATA_DIR);

let window: BrowserWindow | undefined;
let loom: Loom | undefined;

function createWindow(theme: Theme): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // Down to this size, the window's panes give way without scrolling it sideways.
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    title: 'Loom',
    // The saved theme's background, so the window never shows another first.
    backgroundColor: THEMES[theme].background,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true },
  });
  // The window only ever shows Loom: a link that slips past the renderer's own
  // handling opens in the system browser, if it's a web link, never in here.
  const openOutside = (url: string) => {
    if (isWebLink(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openOutside(url);
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
    // no settings or Sessions: the window opens with the default theme and
    // closes without asking, and follows both once a snapshot is restored.
    let theme: Theme | undefined;
    let sessions: Session[] = [];
    let stopWatching: (() => void)[] | undefined;
    const api = loom.api;
    const stopWatchingDatabase = api.subscribe('database', (database) => {
      if (database.state !== 'ok' || stopWatching) return;
      stopWatching = [
        api.subscribe('settings', (settings) => {
          if (window && settings.theme !== theme) window.setBackgroundColor(THEMES[settings.theme].background);
          theme = settings.theme;
        }),
        api.subscribe('sessions', (list) => (sessions = list)),
      ];
    });
    const win = (window = createWindow(theme ?? 'midnight'));
    win.on(
      'close',
      guardQuit({
        question: () => quitQuestion(sessions),
        confirm: async (message) => {
          const options = { type: 'warning' as const, message, buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true };
          return (await dialog.showMessageBox(win, options)).response === 0;
        },
        quit: () => app.quit(),
      }),
    );
    win.on('closed', () => {
      window = undefined;
      stopWatchingDatabase();
      for (const stop of stopWatching ?? []) stop();
    });
  });
}
