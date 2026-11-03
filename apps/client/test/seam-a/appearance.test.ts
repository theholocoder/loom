import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { startMain, waitFor } from './harness';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-appearance-'));
  dirs.push(dir);
  return dir;
}
const appearance = (s: { theme: string; uiFont: string; monoFont: string }) => ({ theme: s.theme, uiFont: s.uiFont, monoFont: s.monoFont });

describe('the theme and fonts', () => {
  it('are Midnight, Inter and IBM Plex Mono until set, and are kept', async () => {
    const userDataDir = tempUserData();
    const main = await startMain({ userDataDir });
    expect(appearance(await waitFor(main.api, 'settings', () => true))).toEqual({ theme: 'midnight', uiFont: 'Inter', monoFont: 'IBM Plex Mono' });

    await main.api.invoke('settings.setAppearance', { theme: 'mocha' });
    const set = await main.api.invoke('settings.setAppearance', { uiFont: 'Figtree', monoFont: 'Fira Code' });
    expect(appearance(set)).toEqual({ theme: 'mocha', uiFont: 'Figtree', monoFont: 'Fira Code' });
    await main.close();

    const again = await startMain({ userDataDir });
    expect(appearance(await waitFor(again.api, 'settings', () => true))).toEqual({ theme: 'mocha', uiFont: 'Figtree', monoFont: 'Fira Code' });
    await again.close();
  });

  it('refuses a theme or font Loom does not offer', async () => {
    const main = await startMain({ userDataDir: tempUserData() });

    await expect(main.api.invoke('settings.setAppearance', { theme: 'neon' as never })).rejects.toThrow('"neon" is not a theme');
    await expect(main.api.invoke('settings.setAppearance', { uiFont: 'Comic Sans' as never })).rejects.toThrow('not a UI font');
    await expect(main.api.invoke('settings.setAppearance', { monoFont: 'Courier' as never })).rejects.toThrow('not a monospace font');
    expect(appearance(await waitFor(main.api, 'settings', () => true))).toEqual({ theme: 'midnight', uiFont: 'Inter', monoFont: 'IBM Plex Mono' });
    await main.close();
  });

  it('fall back to the defaults when the database holds one Loom no longer offers', async () => {
    const userDataDir = tempUserData();
    await (await startMain({ userDataDir })).close();
    const db = new Database(join(userDataDir, 'loom.db'));
    const insert = db.prepare('insert into settings (key, value) values (?, ?)');
    insert.run('theme', '"neon"');
    insert.run('uiFont', '"Papyrus"');
    insert.run('monoFont', '42');
    db.close();

    const main = await startMain({ userDataDir });
    expect(appearance(await waitFor(main.api, 'settings', () => true))).toEqual({ theme: 'midnight', uiFont: 'Inter', monoFont: 'IBM Plex Mono' });
    await main.close();
  });
});
