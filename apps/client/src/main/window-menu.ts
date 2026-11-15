// Loom's window has no menu bar: on Linux and Windows there is no application
// menu at all, and Chromium handles copying, pasting, undoing and selecting in
// text fields by itself. Without the menu's accelerators, reloading and the
// developer tools are kept for development by the window's own key handler,
// and a built app leaves every key to Loom (Ctrl+R never reloads it). macOS
// has no menu bar in the window: there the global menu keeps its app and Edit
// menus, which Cmd+C, Cmd+V and Cmd+Q need, and does the same in development.
import type { Input, MenuItemConstructorOptions } from 'electron';

/** Where Loom runs. */
export interface MenuContext {
  platform: NodeJS.Platform;
  /** Whether Loom runs from source rather than as a packaged app. */
  dev: boolean;
}

/** What the window's own key handler can do. */
export type WindowAction = 'reload' | 'forceReload' | 'toggleDevTools';

/** The application menu's template, or null for none. */
export function applicationMenu({ platform, dev }: MenuContext): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  const view: MenuItemConstructorOptions = { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] };
  return [{ role: 'appMenu' }, { role: 'editMenu' }, ...(dev ? [view] : []), { role: 'windowMenu' }];
}

/** A key press, as Electron's `before-input-event` gives it. */
export type KeyInput = Pick<Input, 'type' | 'code' | 'control' | 'shift' | 'meta' | 'alt'>;

/**
 * What a key press in the window does in place of the menu, if anything: only
 * in development, and never on macOS, whose menu has it. Keys are matched by
 * where they sit, so Ctrl+R reloads on any keyboard layout.
 */
export function windowShortcut(input: KeyInput, { platform, dev }: MenuContext): WindowAction | undefined {
  if (!dev || platform === 'darwin' || input.type !== 'keyDown' || input.alt || input.meta) return undefined;
  if (input.code === 'F12') return input.control || input.shift ? undefined : 'toggleDevTools';
  if (!input.control) return undefined;
  if (input.code === 'KeyR') return input.shift ? 'forceReload' : 'reload';
  if (input.code === 'KeyI' && input.shift) return 'toggleDevTools';
  return undefined;
}
