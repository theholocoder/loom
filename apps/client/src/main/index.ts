// The Electron entry point: wires createLoom to the window and IPC.
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, Notification, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { DEFAULT_APPEARANCE, windowLook, type Appearance, type WindowLook } from '../shared/appearance';
import { MIN_WINDOW } from '../shared/window';
import { systemClock } from './clock';
import { bridgeBinaryPath } from './environments/bridge-path';
import { serveApi } from './ipc';
import { createLoom, type Loom } from './loom';
import type { DesktopNotification } from './notifications';
import { isWebLink } from '../shared/links';
import { guardQuit, quitQuestion } from './quit';
import { selfTest } from './self-test';
import { startTelemetry } from './telemetry';
import type { SqliteDriver } from './storage/sqlite';
import type { Updater } from './updates';
import type { Session } from '../shared/api';
import { applicationMenu, windowShortcut, type MenuContext, type WindowAction } from './window-menu';

// Lets tests run the app against a temporary userData.
if (process.env.LOOM_USER_DATA_DIR) app.setPath('userData', process.env.LOOM_USER_DATA_DIR);

let window: BrowserWindow | undefined;
const menuContext: MenuContext = { platform: process.platform, dev: !app.isPackaged };
let loom: Loom | undefined;
/** Every Session, as main last said, for what to ask before quitting. */
let sessions: Session[] = [];
/** Set once the user has said to quit with Sessions Working, so the window closes without asking again. */
let quitConfirmed = false;
/**
 * CI's check of a packaged build (see self-test.ts): Loom starts, opens its
 * database, connects the bridge, then quits, exiting 1 if any of it failed.
 */
const selfTesting = !!process.env.LOOM_SELF_TEST;
const SELF_TEST_TIMEOUT_MS = 60_000;
// As early as can be, with userData settled: Sentry keeps what it couldn't send yet there.
const telemetry = startTelemetry({ selfTesting });

function createWindow(look: WindowLook): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // Down to this size, the window's panes give way without scrolling it sideways.
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    title: 'Loom',
    // The window and taskbar icon. Linux and Windows take it from here; macOS takes it from the app bundle.
    icon: join(import.meta.dirname, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    // The saved theme's background, so the window never shows another first.
    backgroundColor: look.background,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      zoomFactor: look.zoom,
      // Whether the renderer reports errors too (telemetry.ts).
      additionalArguments: telemetry.rendererArguments,
    },
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

/** What to ask before quitting, or null to quit without asking. */
function quitAsking(): string | null {
  return quitConfirmed ? null : quitQuestion(sessions);
}

/** Asks `message` before quitting; resolves true, and quits from then on without asking, if the user says to quit. */
async function askToQuit(message: string): Promise<boolean> {
  const options = { type: 'warning' as const, message, buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true };
  const quit = (window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)).response === 0;
  if (quit) quitConfirmed = true;
  return quit;
}

/**
 * electron-updater against this repository's GitHub Releases (the `publish`
 * of electron-builder.yml), stable releases only. Updates download in the
 * background and install on quit; Loom restarts only when the user asks.
 * None in development, in the self-test, or outside an AppImage on Linux,
 * which is the only Linux build that can update itself.
 */
function releaseUpdater(): Updater | undefined {
  if (!app.isPackaged || selfTesting || process.env.LOOM_NO_UPDATES) return undefined;
  if (process.platform === 'linux' && !process.env.APPIMAGE) return undefined;
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  return {
    checkAndDownload: async () => {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable || !result.downloadPromise) return null;
      await result.downloadPromise;
      return result.updateInfo.version;
    },
    quitAndInstall: async () => {
      const message = quitAsking();
      if (message !== null && !(await askToQuit(message))) return;
      quitConfirmed = true;
      if (process.platform === 'linux') {
        // electron-updater would start the new AppImage at once, while this
        // Loom still holds the single-instance lock as it shuts down, so it
        // would quit straight away. Instead, the update installs as on any
        // quit, and the new AppImage starts once this Loom has exited.
        let appImage = process.env.APPIMAGE!;
        autoUpdater.once('appimage-filename-updated', (path: string) => (appImage = path));
        // After electron-updater's own quit handler, which installs.
        app.once('quit', () => app.relaunch({ execPath: appImage, args: process.argv.slice(1) }));
        app.quit();
        return;
      }
      // The installer waits for Loom to exit, then starts it again.
      autoUpdater.quitAndInstall(false, true);
    },
  };
}

async function runSelfTest(started: Loom): Promise<void> {
  let code = 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${SELF_TEST_TIMEOUT_MS / 1000} s`)), SELF_TEST_TIMEOUT_MS)));
    console.log(`Loom ${app.getVersion()} self-test passed: ${await Promise.race([selfTest(started.api), timeout])}`);
  } catch (error) {
    console.error(`Loom ${app.getVersion()} self-test failed: ${(error as Error).message}`);
    code = 1;
  } finally {
    clearTimeout(timer);
  }
  loom = undefined;
  await started.close();
  app.exit(code);
}

/** LOOM_SQLITE_DRIVER=node:sqlite opens the database the way Linux older than glibc 2.34 does. */
function sqliteDriverOverride(): SqliteDriver | undefined {
  const driver = process.env.LOOM_SQLITE_DRIVER;
  return driver === 'better-sqlite3' || driver === 'node:sqlite' ? driver : undefined;
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
        updater: releaseUpdater(),
        sqliteDriver: sqliteDriverOverride(),
        sendFeedback: telemetry.sendFeedback,
      });
    } catch (error) {
      console.error('Loom could not start:', error);
      if (!selfTesting) dialog.showErrorBox('Loom could not start', (error as Error).message);
      app.exit(1);
      return;
    }
    serveApi(loom.api);
    telemetry.watch(loom.api);
    if (selfTesting) {
      void runSelfTest(loom);
      return;
    }
    // A topic gives its current value as soon as it's subscribed to, so the
    // saved look is known before the window opens. A damaged database serves
    // no settings or Sessions: the window opens with the default look and
    // closes without asking, and follows both once a snapshot is restored.
    // Matching the system, the theme follows its light or dark mode too.
    let appearance: Appearance = DEFAULT_APPEARANCE;
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
        question: quitAsking,
        confirm: askToQuit,
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
