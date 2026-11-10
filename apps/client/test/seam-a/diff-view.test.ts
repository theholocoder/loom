import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { startMain, tempDir, waitFor } from './harness';

describe("the Changes view's layout settings", () => {
  it('are all off until set, and are kept across a restart', async () => {
    const userDataDir = tempDir('loom-diff-view-');
    const main = await startMain({ userDataDir });
    expect((await waitFor(main.api, 'settings', () => true)).diffView).toEqual({ fileList: false, wrap: false, sideBySide: false });

    const set = await main.api.invoke('settings.setDiffView', { fileList: true, wrap: false, sideBySide: true });
    expect(set.diffView).toEqual({ fileList: true, wrap: false, sideBySide: true });
    await main.close();

    const again = await startMain({ userDataDir });
    expect((await waitFor(again.api, 'settings', () => true)).diffView).toEqual({ fileList: true, wrap: false, sideBySide: true });
    await again.close();
  });

  it('refuse anything but true or false', async () => {
    const main = await startMain({ userDataDir: tempDir('loom-diff-view-') });
    await expect(main.api.invoke('settings.setDiffView', { fileList: 'yes' as never, wrap: false, sideBySide: false })).rejects.toThrow('true or false');
    await expect(main.api.invoke('settings.setDiffView', { fileList: true, wrap: false } as never)).rejects.toThrow('true or false');
    await main.close();
  });

  it('fall back to the default for what the database holds that Loom no longer takes', async () => {
    const userDataDir = tempDir('loom-diff-view-');
    await (await startMain({ userDataDir })).close();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare('insert into settings (key, value) values (?, ?)').run('diffView', JSON.stringify({ fileList: true, wrap: 'always' }));
    db.close();

    const main = await startMain({ userDataDir });
    expect((await waitFor(main.api, 'settings', () => true)).diffView).toEqual({ fileList: true, wrap: false, sideBySide: false });
    await main.close();
  });
});
