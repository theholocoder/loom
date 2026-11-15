// Keybindings: the user remaps Loom's shortcuts, or turns the single-key ones
// off, in Settings; main keeps them, refuses a shortcut Loom can't run, and
// takes a shortcut set from any other action that had it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { bindingsOf, DEFAULT_KEYBINDINGS, SHORTCUTS } from '../../src/shared/shortcuts';
import { startMain, waitFor } from './harness';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-keybindings-'));
  dirs.push(dir);
  return dir;
}

describe('keybindings', () => {
  it("are Loom's own until remapped, and a remap is kept", async () => {
    const userDataDir = tempUserData();
    const main = await startMain({ userDataDir });
    const settings = await waitFor(main.api, 'settings', () => true);
    expect(settings.keybindings).toEqual(DEFAULT_KEYBINDINGS);
    expect(bindingsOf(settings.keybindings).archive).toEqual(SHORTCUTS.archive.shortcut);

    await main.api.invoke('settings.setKeybinding', { name: 'archive', shortcut: { key: 'a', ctrl: true, shift: true } });
    await main.api.invoke('settings.setKeybinding', { name: 'markUnread', shortcut: null });
    await main.api.invoke('settings.setSingleKeyShortcuts', { on: false });
    await main.close();

    const again = await startMain({ userDataDir });
    const kept = (await waitFor(again.api, 'settings', () => true)).keybindings;
    expect(kept).toEqual({ remapped: { archive: { key: 'a', ctrl: true, shift: true }, markUnread: null }, singleKeys: false });
    const bindings = bindingsOf(kept);
    expect(bindings.archive).toEqual({ key: 'a', ctrl: true, shift: true });
    expect(bindings.markUnread).toBeUndefined();
    // The single-key ones are off: j steps through nothing.
    expect(bindings.nextWaiting).toBeUndefined();
    expect(bindings.palette).toEqual(SHORTCUTS.palette.shortcut);
    await again.close();
  });

  it('take a shortcut set from the action that had it, which is left with none', async () => {
    const main = await startMain({ userDataDir: tempUserData() });

    const settings = await main.api.invoke('settings.setKeybinding', { name: 'archive', shortcut: { key: 'n', ctrl: true } });
    expect(settings.keybindings.remapped).toEqual({ archive: { key: 'n', ctrl: true }, newSession: null });

    // Back to its own, archive takes e from nothing; New Session gets Ctrl+N back by resetting it.
    await main.api.invoke('settings.setKeybinding', { name: 'archive', shortcut: 'default' });
    const reset = await main.api.invoke('settings.setKeybinding', { name: 'newSession', shortcut: 'default' });
    expect(reset.keybindings.remapped).toEqual({});
    await main.close();
  });

  it('reset all at once', async () => {
    const main = await startMain({ userDataDir: tempUserData() });
    await main.api.invoke('settings.setKeybinding', { name: 'toggleDiff', shortcut: { key: 'g' } });
    await main.api.invoke('settings.setSingleKeyShortcuts', { on: false });

    const reset = await main.api.invoke('settings.resetKeybindings');
    expect(reset.keybindings).toEqual(DEFAULT_KEYBINDINGS);
    await main.close();
  });

  it("refuse a shortcut Loom can't run, or an action that has none to remap", async () => {
    const main = await startMain({ userDataDir: tempUserData() });
    const set = (shortcut: unknown, name = 'archive') => main.api.invoke('settings.setKeybinding', { name, shortcut } as never);

    await expect(set({ key: 'enter' })).rejects.toThrow('Without Ctrl');
    await expect(set({ key: ' ' })).rejects.toThrow('Without Ctrl');
    await expect(set({ key: 'escape', ctrl: true })).rejects.toThrow('Escape');
    await expect(set({ key: 'tab', ctrl: true })).rejects.toThrow('Tab');
    await expect(set({ key: 'shift', ctrl: true })).rejects.toThrow('a key besides');
    await expect(set({ key: '3', ctrl: true })).rejects.toThrow('Ctrl 1…9');
    await expect(set({ key: 'c', ctrl: true })).rejects.toThrow('Ctrl C');
    await expect(set({ key: 'backspace', ctrl: true })).rejects.toThrow('by the word');
    await expect(set({ key: 'arrowleft', ctrl: true, shift: true })).rejects.toThrow('by the word');
    await expect(set({ key: 'c', ctrl: true, shift: true })).rejects.toThrow('Terminals keep Ctrl Shift C');
    await expect(set({ key: 'K', ctrl: true })).rejects.toThrow('not a key');
    await expect(set('ctrl+k')).rejects.toThrow('not a key');
    await expect(set({ key: 'g' }, 'send')).rejects.toThrow('"send"');
    await expect(set({ key: 'g' }, 'inboxPosition')).rejects.toThrow('"inboxPosition"');
    await expect(main.api.invoke('settings.setSingleKeyShortcuts', { on: 'no' as never })).rejects.toThrow('true or false');
    expect((await waitFor(main.api, 'settings', () => true)).keybindings).toEqual(DEFAULT_KEYBINDINGS);

    // Ctrl+Z is Undo's: it may go back there, and F-keys need no Ctrl.
    await set({ key: 'y', ctrl: true, shift: true }, 'undo');
    await set({ key: 'z', ctrl: true }, 'undo');
    await set({ key: 'f2' }, 'reply');
    await main.close();
  });

  it('drop what the database holds that Loom no longer takes', async () => {
    const userDataDir = tempUserData();
    await (await startMain({ userDataDir })).close();
    const db = new Database(join(userDataDir, 'loom.db'));
    const remapped = { archive: { key: 'x', ctrl: true, shift: true }, gone: { key: 'q' }, reply: { key: 'enter' }, markUnread: null };
    db.prepare('insert into settings (key, value) values (?, ?)').run('keybindings', JSON.stringify({ remapped, singleKeys: 'maybe' }));
    db.close();

    const main = await startMain({ userDataDir });
    expect((await waitFor(main.api, 'settings', () => true)).keybindings).toEqual({ remapped: { archive: { key: 'x', ctrl: true, shift: true }, markUnread: null }, singleKeys: true });
    await main.close();
  });
});
