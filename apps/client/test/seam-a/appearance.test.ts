import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, THEMES, windowLook, type Appearance } from '../../src/shared/appearance';
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

const look = (s: Appearance) => ({ theme: s.theme, lightTheme: s.lightTheme, darkTheme: s.darkTheme, fontSize: s.fontSize, density: s.density, accent: s.accent });

describe('matching the system, the font size, density and accent', () => {
  it('are a fixed theme, Daylight and Midnight to match with, the default size, comfortable and the theme’s accent until set, and are kept', async () => {
    const userDataDir = tempUserData();
    const main = await startMain({ userDataDir });
    expect(look(await waitFor(main.api, 'settings', () => true))).toEqual({ theme: 'midnight', lightTheme: 'daylight', darkTheme: 'midnight', fontSize: 'default', density: 'comfortable', accent: 'theme' });

    const set = await main.api.invoke('settings.setAppearance', { theme: 'system', lightTheme: 'paper', darkTheme: 'nord', fontSize: 'large', density: 'compact', accent: 'teal' });
    expect(look(set)).toEqual({ theme: 'system', lightTheme: 'paper', darkTheme: 'nord', fontSize: 'large', density: 'compact', accent: 'teal' });
    await main.close();

    const again = await startMain({ userDataDir });
    expect(look(await waitFor(again.api, 'settings', () => true))).toEqual({ theme: 'system', lightTheme: 'paper', darkTheme: 'nord', fontSize: 'large', density: 'compact', accent: 'teal' });
    await again.close();
  });

  it('refuses a dark theme for light mode, a light one for dark mode, and a size, density or accent Loom does not offer, setting none of what was asked', async () => {
    const main = await startMain({ userDataDir: tempUserData() });

    await expect(main.api.invoke('settings.setAppearance', { lightTheme: 'nord' as never })).rejects.toThrow('"nord" is not a light theme');
    await expect(main.api.invoke('settings.setAppearance', { darkTheme: 'paper' as never })).rejects.toThrow('"paper" is not a dark theme');
    await expect(main.api.invoke('settings.setAppearance', { fontSize: 'huge' as never })).rejects.toThrow('"huge" is not a font size');
    await expect(main.api.invoke('settings.setAppearance', { density: 'roomy' as never })).rejects.toThrow('"roomy" is not a density');
    await expect(main.api.invoke('settings.setAppearance', { theme: 'system', accent: 'gold' as never })).rejects.toThrow('"gold" is not an accent colour');
    expect(look(await waitFor(main.api, 'settings', () => true))).toEqual({ theme: 'midnight', lightTheme: 'daylight', darkTheme: 'midnight', fontSize: 'default', density: 'comfortable', accent: 'theme' });
    await main.close();
  });

  it('fall back to the defaults when the database holds one Loom no longer offers', async () => {
    const userDataDir = tempUserData();
    await (await startMain({ userDataDir })).close();
    const db = new Database(join(userDataDir, 'loom.db'));
    const insert = db.prepare('insert into settings (key, value) values (?, ?)');
    insert.run('lightTheme', '"midnight"');
    insert.run('darkTheme', '"daylight"');
    insert.run('fontSize', '"tiny"');
    insert.run('density', '7');
    insert.run('accent', '"gold"');
    db.close();

    const main = await startMain({ userDataDir });
    expect(look(await waitFor(main.api, 'settings', () => true))).toEqual({ theme: 'midnight', lightTheme: 'daylight', darkTheme: 'midnight', fontSize: 'default', density: 'comfortable', accent: 'theme' });
    await main.close();
  });
});

describe('the window main opens', () => {
  it('has the background of the theme shown, by the system’s mode when matching it, and zooms by the font size', () => {
    const appearance = { ...DEFAULT_APPEARANCE, theme: 'system' as const, lightTheme: 'paper' as const, darkTheme: 'mocha' as const, fontSize: 'larger' as const };

    expect(windowLook(appearance, false)).toEqual({ background: THEMES.paper.background, zoom: 1.25 });
    expect(windowLook(appearance, true)).toEqual({ background: THEMES.mocha.background, zoom: 1.25 });
    expect(windowLook({ ...appearance, theme: 'nord', fontSize: 'small' }, false)).toEqual({ background: THEMES.nord.background, zoom: 0.9 });
  });
});
