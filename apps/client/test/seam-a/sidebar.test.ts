import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../src/shared/api';
import { startMain, tempDir, waitFor } from './harness';

describe("the right sidebar's settings", () => {
  it('are closed, on Session info, at the default width until set, and are kept', async () => {
    const userDataDir = tempDir('loom-sidebar-');
    const main = await startMain({ userDataDir });
    expect((await waitFor(main.api, 'settings', () => true)).sidebar).toEqual({ open: false, view: 'info', width: 420 });

    await main.api.invoke('settings.setSidebar', { open: true });
    const set = await main.api.invoke('settings.setSidebar', { view: 'changes', width: 600 });
    expect(set.sidebar).toEqual({ open: true, view: 'changes', width: 600 });
    await main.close();

    const again = await startMain({ userDataDir });
    expect((await waitFor(again.api, 'settings', () => true)).sidebar).toEqual({ open: true, view: 'changes', width: 600 });
    await again.close();
  });

  it('keep the width within the minimum and maximum, and refuse a view Loom has not', async () => {
    const main = await startMain({ userDataDir: tempDir('loom-sidebar-') });
    expect((await main.api.invoke('settings.setSidebar', { width: 10 })).sidebar.width).toBe(SIDEBAR_MIN_WIDTH);
    expect((await main.api.invoke('settings.setSidebar', { width: 99_999 })).sidebar.width).toBe(SIDEBAR_MAX_WIDTH);
    await expect(main.api.invoke('settings.setSidebar', { view: 'terminal' as never })).rejects.toThrow('"terminal" is not a sidebar view');
    await expect(main.api.invoke('settings.setSidebar', { width: Number.NaN })).rejects.toThrow('width');
    await main.close();
  });

  it('fall back to the defaults for what the database holds that Loom no longer takes', async () => {
    const userDataDir = tempDir('loom-sidebar-');
    await (await startMain({ userDataDir })).close();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare('insert into settings (key, value) values (?, ?)').run('sidebar', JSON.stringify({ open: true, view: 'terminal', width: 5 }));
    db.close();

    const main = await startMain({ userDataDir });
    expect((await waitFor(main.api, 'settings', () => true)).sidebar).toEqual({ open: true, view: 'info', width: SIDEBAR_MIN_WIDTH });
    await main.close();
  });
});
