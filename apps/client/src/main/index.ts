// The Electron entry point: wires createLoom to the window and IPC.
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, Notification, shell } from 'electron';
import { DEFAULT_APPEARANCE, windowLook, type Appearance, type WindowLook } from '../shared/appearance';
import { MIN_WINDOW } from '../shared/window';
import { systemClock } from './clock';
import { bridgeBinaryPath } from './environments/bridge-path';
import { serveApi } from './ipc';
import { createLoom, type Loom } from './loom';
import type { DesktopNotification } from './notifications';
import { isWebLink } from '../shared/links';
import { guardQuit, quitQuestion } from './quit';
import type { Session } from '../shared/api';
import { applicationMenu, windowShortcut, type MenuContext, type WindowAction } from './window-menu';

// Lets tests run the app against a temporary userData.
if (process.env.LOOM_USER_DATA_DIR) app.setPath('userData', process.env.LOOM_USER_DATA_DIR);

let window: BrowserWindow | undefined;
const menuContext: MenuContext = { platform: process.platform, dev: !app.isPackaged };
let loom: Loom | undefined;

function createWindow(look: WindowLook): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // Down to this size, the window's panes give way without scrolling it sideways.
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    title: 'Loom',
    // The saved theme's background, so the window never shows another first.
    backgroundColor: look.background,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, zoomFactor: look.zoom },
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
  // With no menu bar, the window keeps reloading and the developer tools in development.
  const actions: Record<WindowAction, () => void> = {
    reload: () => win.webContents.reload(),
    forceReload: () => win.webContents.reloadIgnoringCache(),
    toggleDevTools: () => win.webContents.toggleDevTools(),
  };
  win.webContents.on('before-input-event', (event, input) => {
    const action = windowShortcut(input, menuContext);
    if (!action) return;
    event.preventDefault();
    actions[action]();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

/** Notifications shown and not yet clicked or closed: held, so that a click still reaches its handler. */
const shownNotifications = new Set<Notification>();

/** Shows a desktop notification; a click brings the window up front and opens its Session. */
function notify({ title, body, onClick }: DesktopNotification): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  shownNotifications.add(notification);
  notification.on('click', () => {
    shownNotifications.delete(notification);
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    onClick();
  });
  notification.on('close', () => shownNotifications.delete(notification));
  notification.show();
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
    const menu = applicationMenu(menuContext);
    Menu.setApplicationMenu(menu && Menu.buildFromTemplate(menu));
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
        notify,
        windowFocused: () => !!window && window.isFocused(),
        // The regional format, which on Windows and macOS may differ from the UI language the renderer's Intl takes.
        systemLocale: app.getSystemLocale(),
      });
    } catch (error) {
      console.error('Loom could not start:', error);
      dialog.showErrorBox('Loom could not start', (error as Error).message);
      app.exit(1);
      return;
    }
    serveApi(loom.api);
    // A topic gives its current value as soon as it's subscribed to, so the
    // saved look is known before the window opens. A damaged database serves
    // no settings or Sessions: the window opens with the default look and
    // closes without asking, and follows both once a snapshot is restored.
    // Matching the system, the theme follows its light or dark mode too.
    let appearance: Appearance = DEFAULT_APPEARANCE;
    let sessions: Session[] = [];
    let stopWatching: (() => void)[] | undefined;
    const api = loom.api;
    const currentLook = () => windowLook(appearance, nativeTheme.shouldUseDarkColors);
    let shown = currentLook();
    const showLook = () => {
      const look = currentLook();
      if (window && look.background !== shown.background) window.setBackgroundColor(look.background);
      if (window && look.zoom !== shown.zoom) window.webContents.setZoomFactor(look.zoom);
      shown = look;
    };
    nativeTheme.on('updated', showLook);
    const stopWatchingDatabase = api.subscribe('database', (database) => {
      if (database.state !== 'ok' || stopWatching) return;
      stopWatching = [
        api.subscribe('settings', (settings) => {
          appearance = settings;
          showLook();
        }),
        api.subscribe('sessions', (list) => (sessions = list)),
      ];
    });
    const win = (window = createWindow(shown));
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
      nativeTheme.off('updated', showLook);
      for (const stop of stopWatching ?? []) stop();
    });
  });
}
