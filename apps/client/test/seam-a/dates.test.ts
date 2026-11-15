import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { dateSettingsOf as dates } from '../../src/shared/dates';
import { startMain, waitFor } from './harness';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-dates-'));
  dirs.push(dir);
  return dir;
}

describe('how dates and times are written', () => {
  it("follows the system's regional format", async () => {
    const main = await startMain({ userDataDir: tempUserData(), systemLocale: 'fr-FR' });
    expect(await main.api.invoke('settings.systemLocale')).toBe('fr-FR');
    await main.close();
  });

  it('matches the system until set, and is kept', async () => {
    const userDataDir = tempUserData();
    const main = await startMain({ userDataDir });
    expect(dates(await waitFor(main.api, 'settings', () => true))).toEqual({ dateFormat: 'system', hourCycle: 'system' });

    await main.api.invoke('settings.setDateFormat', { dateFormat: 'de-DE' });
    const set = await main.api.invoke('settings.setDateFormat', { hourCycle: '12h' });
    expect(dates(set)).toEqual({ dateFormat: 'de-DE', hourCycle: '12h' });
    await main.close();

    const again = await startMain({ userDataDir });
    expect(dates(await waitFor(again.api, 'settings', () => true))).toEqual({ dateFormat: 'de-DE', hourCycle: '12h' });
    await again.close();
  });

  it('refuses a format or clock Loom does not offer, setting neither', async () => {
    const main = await startMain({ userDataDir: tempUserData() });
    await expect(main.api.invoke('settings.setDateFormat', { dateFormat: 'xx-YY' as never })).rejects.toThrow('"xx-YY" is not a regional format');
    await expect(main.api.invoke('settings.setDateFormat', { dateFormat: 'fr-FR', hourCycle: '36h' as never })).rejects.toThrow('"36h" is not a clock');
    expect(dates(await waitFor(main.api, 'settings', () => true))).toEqual({ dateFormat: 'system', hourCycle: 'system' });
    await main.close();
  });

  it('falls back to the system when the database holds one Loom no longer offers', async () => {
    const userDataDir = tempUserData();
    await (await startMain({ userDataDir })).close();
    const db = new Database(join(userDataDir, 'loom.db'));
    const insert = db.prepare('insert into settings (key, value) values (?, ?)');
    insert.run('dateFormat', '"tlh-QO"');
    insert.run('hourCycle', '12');
    db.close();

    const main = await startMain({ userDataDir });
    expect(dates(await waitFor(main.api, 'settings', () => true))).toEqual({ dateFormat: 'system', hourCycle: 'system' });
    await main.close();
  });
});
