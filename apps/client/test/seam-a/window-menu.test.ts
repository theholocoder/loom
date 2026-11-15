import { describe, expect, it } from 'vitest';
import { applicationMenu, windowShortcut } from '../../src/main/window-menu';

/** A key press as Electron's `before-input-event` gives it. */
function press(code: string, held: { control?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {}) {
  return { type: 'keyDown', code, control: false, shift: false, meta: false, alt: false, ...held };
}

const linux = (dev: boolean) => ({ platform: 'linux' as const, dev });

describe("the window's menu", () => {
  it('has no menu bar on Linux and Windows', () => {
    expect(applicationMenu({ platform: 'linux', dev: false })).toBeNull();
    expect(applicationMenu({ platform: 'win32', dev: true })).toBeNull();
  });

  it("keeps macOS's app and Edit menus, which copy and paste need there", () => {
    const roles = applicationMenu({ platform: 'darwin', dev: false })!.map((item) => item.role);
    expect(roles).toEqual(['appMenu', 'editMenu', 'windowMenu']);
  });

  it('adds reload and the developer tools to the macOS menu in development only', () => {
    const view = applicationMenu({ platform: 'darwin', dev: true })!.find((item) => item.label === 'View');
    expect(view?.submenu).toEqual([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }]);
  });
});

describe("the window's shortcuts without a menu bar", () => {
  it('reloads and opens the developer tools in development', () => {
    expect(windowShortcut(press('KeyR', { control: true }), linux(true))).toBe('reload');
    expect(windowShortcut(press('KeyR', { control: true, shift: true }), linux(true))).toBe('forceReload');
    expect(windowShortcut(press('KeyI', { control: true, shift: true }), linux(true))).toBe('toggleDevTools');
    expect(windowShortcut(press('F12'), linux(true))).toBe('toggleDevTools');
  });

  it('leaves every key to Loom in a built app, so Ctrl+R never reloads it', () => {
    expect(windowShortcut(press('KeyR', { control: true }), linux(false))).toBeUndefined();
    expect(windowShortcut(press('KeyI', { control: true, shift: true }), linux(false))).toBeUndefined();
    expect(windowShortcut(press('F12'), linux(false))).toBeUndefined();
  });

  it("leaves Loom's own Ctrl shortcuts and typing alone", () => {
    expect(windowShortcut(press('KeyB', { control: true }), linux(true))).toBeUndefined();
    expect(windowShortcut(press('KeyR'), linux(true))).toBeUndefined();
    expect(windowShortcut({ ...press('KeyR', { control: true }), type: 'keyUp' }, linux(true))).toBeUndefined();
  });

  it('leaves the keys to the menu on macOS', () => {
    expect(windowShortcut(press('KeyR', { control: true }), { platform: 'darwin', dev: true })).toBeUndefined();
  });
});
