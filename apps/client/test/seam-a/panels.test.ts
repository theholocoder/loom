import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/storage/database';
import { migrations } from '../../src/main/storage/migrations';
import { DEFAULT_SESSION_PANELS, PANEL_MAX_SIZE, type SessionPanels } from '../../src/shared/panels';
import { DEFAULT_INBOX, INBOX_WIDTH } from '../../src/shared/window';
import { startMain, tempDir, waitFor } from './harness';

/** The migration that brought in the Panel model. */
const PANELS_MIGRATION = 18;

/**
 * A userData whose database is just before the Panel model, with a Project and two
 * archived Sessions (7 and 8) in it, and `sidebar` as the old app-wide
 * sidebar setting when given.
 */
async function before(sidebar?: unknown): Promise<string> {
  const userDataDir = tempDir('loom-panels-');
  await (await openDatabase(userDataDir, { migrations: migrations.slice(0, PANELS_MIGRATION - 1) })).destroy();
  const db = new Database(join(userDataDir, 'loom.db'));
  db.prepare("insert into projects (id, name, branch_prefix, created_at) values (1, 'billing-api', 'loom', 1)").run();
  db.prepare("insert into checkouts (project_id, environment_id, path) values (1, 'native', ?)").run(userDataDir);
  for (const id of [7, 8]) {
    db.prepare("insert into sessions (id, project_id, title, working_copy_kind, working_copy_path, agent, status, created_at, updated_at, archived_at) values (?, 1, ?, 'checkout', ?, 'OpenCode', 'archived', 1, 1, 1)").run(
      id,
      `Session ${id}`,
      userDataDir,
    );
  }
  if (sidebar !== undefined) db.prepare("insert into settings (key, value) values ('sidebar', ?)").run(JSON.stringify(sidebar));
  db.close();
  return userDataDir;
}

const panelsOf = (main: Awaited<ReturnType<typeof startMain>>, sessionId: number) => waitFor(main.api, 'panels', () => true, { sessionId });
const stored = (userDataDir: string, key: string) => {
  const db = new Database(join(userDataDir, 'loom.db'), { readonly: true });
  const row = db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined;
  db.close();
  return row && (JSON.parse(row.value) as unknown);
};

describe("the old sidebar's settings", () => {
  it("become the Layout's widths and every Session's Side area, keeping the width and the last view", async () => {
    const userDataDir = await before({ open: true, view: 'changes', width: 600 });
    const main = await startMain({ userDataDir });

    expect((await waitFor(main.api, 'settings', () => true)).layout).toEqual({ area: {}, stack: {}, width: { changes: 600 }, height: {} });
    for (const id of [7, 8]) {
      expect(await panelsOf(main, id)).toEqual({ side: { panels: ['changes'], shown: 'changes', open: true }, dock: { panels: [], shown: null, open: false } });
    }
    await main.close();
    expect(stored(userDataDir, 'sidebar')).toBeUndefined();
  });

  it('as Loom had them until changed: closed, at the preferred widths', async () => {
    const main = await startMain({ userDataDir: await before() });
    expect((await waitFor(main.api, 'settings', () => true)).layout).toEqual({ area: {}, stack: {}, width: {}, height: {} });
    expect((await panelsOf(main, 7)).side).toEqual({ panels: ['changes'], shown: 'changes', open: false });
  });

  it('fall back to those for what Loom no longer takes, keeping the width within bounds', async () => {
    const main = await startMain({ userDataDir: await before({ open: 'yes', view: 'terminal', width: 5 }) });
    expect((await waitFor(main.api, 'settings', () => true)).layout.width).toEqual({ changes: 280 });
    expect((await panelsOf(main, 7)).side).toEqual({ panels: ['changes'], shown: 'changes', open: false });
  });
});

describe('Session info, which is no longer a Panel', () => {
  it('goes from the Panels and the Layout an earlier Loom kept, the area it leaves empty hidden', async () => {
    const userDataDir = tempDir('loom-panels-');
    await (await openDatabase(userDataDir, { migrations: migrations.slice(0, PANELS_MIGRATION) })).destroy();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("insert into projects (id, name, branch_prefix, created_at) values (1, 'billing-api', 'loom', 1)").run();
    db.prepare("insert into checkouts (project_id, environment_id, path) values (1, 'native', ?)").run(userDataDir);
    const states: Record<number, unknown> = {
      7: { side: { panels: ['info', 'changes'], shown: 'info', open: true }, dock: { panels: [], shown: null, open: false } },
      8: { side: { panels: ['info'], shown: 'info', open: true }, dock: { panels: ['terminal:1'], shown: 'terminal:1', open: true } },
    };
    for (const id of [7, 8]) {
      db.prepare("insert into sessions (id, project_id, title, working_copy_kind, working_copy_path, agent, status, created_at, updated_at, archived_at) values (?, 1, ?, 'checkout', ?, 'OpenCode', 'archived', 1, 1, 1)").run(id, `Session ${id}`, userDataDir);
      db.prepare('insert into session_panels (session_id, state) values (?, ?)').run(id, JSON.stringify(states[id]));
    }
    db.prepare("insert into settings (key, value) values ('layout', ?)").run(JSON.stringify({ width: { info: 500, changes: 700 }, height: { info: 200 } }));
    db.close();

    const main = await startMain({ userDataDir });
    expect(await panelsOf(main, 7)).toEqual({ side: { panels: ['changes'], shown: 'changes', open: true }, dock: { panels: [], shown: null, open: false } });
    expect((await panelsOf(main, 8)).side).toEqual({ panels: [], shown: null, open: false });
    expect((await waitFor(main.api, 'settings', () => true)).layout).toEqual({ area: {}, stack: {}, width: { changes: 700 }, height: {} });
    await main.close();
    expect(stored(userDataDir, 'layout')).toEqual({ width: { changes: 700 }, height: {} });
  });
});

describe("a Session's Panels", () => {
  it("are a new Session's until changed, then kept as left, but for its Terminals, which end with Loom", async () => {
    const userDataDir = await before();
    await (await startMain({ userDataDir })).close();
    // A Session from after the migration has none of its own yet.
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("insert into sessions (id, project_id, title, working_copy_kind, working_copy_path, agent, status, created_at, updated_at, archived_at) values (9, 1, 'New', 'checkout', ?, 'OpenCode', 'archived', 1, 1, 1)").run(userDataDir);
    db.close();
    const main = await startMain({ userDataDir });
    expect(await panelsOf(main, 9)).toEqual(DEFAULT_SESSION_PANELS);

    const panels: SessionPanels = {
      side: { panels: ['changes'], shown: 'changes', open: false },
      dock: { panels: ['terminal:3', 'terminal:4'], shown: 'terminal:4', open: true },
    };
    await main.api.invoke('sessions.setPanels', { id: 7, panels });
    expect(await panelsOf(main, 7)).toEqual(panels);
    await main.close();

    const again = await startMain({ userDataDir });
    expect(await panelsOf(again, 7)).toEqual({ side: panels.side, dock: { panels: [], shown: null, open: false } });
  });

  it('refuse Panels Loom has not, one open twice, or a Session that is not there', async () => {
    const main = await startMain({ userDataDir: await before() });
    const set = (panels: unknown, id = 7) => main.api.invoke('sessions.setPanels', { id, panels: panels as SessionPanels });
    await expect(set({ ...DEFAULT_SESSION_PANELS, side: { panels: ['files'], shown: null, open: true } })).rejects.toThrow('"files" is not a Panel.');
    await expect(set({ ...DEFAULT_SESSION_PANELS, side: { panels: ['terminal'], shown: null, open: true } })).rejects.toThrow('"terminal" is not a Panel.');
    await expect(set({ side: { panels: ['changes'], shown: 'changes', open: true }, dock: { panels: ['changes'], shown: 'changes', open: true } })).rejects.toThrow('Panel "changes" is open twice.');
    await expect(set({ side: DEFAULT_SESSION_PANELS.side })).rejects.toThrow('The dock area is missing');
    await expect(set(DEFAULT_SESSION_PANELS, 99)).rejects.toThrow('unknown Session 99');
    expect(await panelsOf(main, 7)).toEqual({ side: { panels: ['changes'], shown: 'changes', open: false }, dock: DEFAULT_SESSION_PANELS.dock });
  });

  it("keep a split area's second stack, its Terminals going with Loom and a stack left with none going too", async () => {
    const userDataDir = await before();
    const main = await startMain({ userDataDir });
    const panels: SessionPanels = {
      side: { panels: ['changes'], shown: 'changes', open: true, second: { panels: ['highlights', 'terminal:2'], shown: 'terminal:2' } },
      dock: { panels: ['issue'], shown: 'issue', open: true, second: { panels: ['terminal:3'], shown: 'terminal:3' } },
    };
    await main.api.invoke('sessions.setPanels', { id: 7, panels });
    expect(await panelsOf(main, 7)).toEqual(panels);
    await main.close();

    const again = await startMain({ userDataDir });
    expect(await panelsOf(again, 7)).toEqual({
      side: { panels: ['changes'], shown: 'changes', open: true, second: { panels: ['highlights'], shown: 'highlights' } },
      dock: { panels: ['issue'], shown: 'issue', open: true },
    });
  });

  it('refuse a Panel open in both stacks of an area', async () => {
    const main = await startMain({ userDataDir: await before() });
    await expect(
      main.api.invoke('sessions.setPanels', { id: 7, panels: { ...DEFAULT_SESSION_PANELS, side: { panels: ['changes'], shown: 'changes', open: true, second: { panels: ['changes'], shown: 'changes' } } } }),
    ).rejects.toThrow('Panel "changes" is open twice.');
  });

  it('show their first Panel when told to show one that is not open', async () => {
    const main = await startMain({ userDataDir: await before() });
    await main.api.invoke('sessions.setPanels', { id: 7, panels: { ...DEFAULT_SESSION_PANELS, side: { panels: ['changes', 'terminal:2'], shown: 'terminal:1', open: true } } });
    expect((await panelsOf(main, 7)).side.shown).toBe('changes');
  });

  it('go with their Session when it is deleted', async () => {
    const userDataDir = await before();
    const main = await startMain({ userDataDir });
    await main.api.invoke('sessions.setPanels', { id: 8, panels: DEFAULT_SESSION_PANELS });
    await main.api.invoke('sessions.delete', { id: 8 });
    await main.close();
    const db = new Database(join(userDataDir, 'loom.db'), { readonly: true });
    expect(db.prepare('select session_id from session_panels order by session_id').all()).toEqual([{ session_id: 7 }]);
    db.close();
  });
});

describe('the Layout', () => {
  it("keeps each Panel kind's width and height, within its minimum and the maximum, across restarts", async () => {
    const userDataDir = await before();
    const main = await startMain({ userDataDir });
    await main.api.invoke('settings.setPanelSize', { kind: 'changes', dimension: 'width', size: 700.4 });
    await main.api.invoke('settings.setPanelSize', { kind: 'changes', dimension: 'height', size: 10 });
    await main.api.invoke('settings.setPanelSize', { kind: 'terminal', dimension: 'height', size: 99_999 });
    expect((await main.api.invoke('settings.setPanelSize', { kind: 'terminal', dimension: 'width', size: 10 })).layout).toEqual({
      area: {},
      stack: {},
      width: { changes: 700, terminal: 320 },
      height: { changes: 120, terminal: PANEL_MAX_SIZE.height },
    });
    await main.close();

    const again = await startMain({ userDataDir });
    expect((await waitFor(again.api, 'settings', () => true)).layout).toEqual({ area: {}, stack: {}, width: { changes: 700, terminal: 320 }, height: { changes: 120, terminal: PANEL_MAX_SIZE.height } });
  });

  it('keeps the area each Panel kind was moved to across restarts', async () => {
    const userDataDir = await before();
    const main = await startMain({ userDataDir });
    await main.api.invoke('settings.setPanelPlace', { kind: 'changes', area: 'dock' });
    expect((await main.api.invoke('settings.setPanelPlace', { kind: 'terminal', area: 'side' })).layout.area).toEqual({ changes: 'dock', terminal: 'side' });
    await main.close();

    const again = await startMain({ userDataDir });
    expect((await waitFor(again.api, 'settings', () => true)).layout.area).toEqual({ changes: 'dock', terminal: 'side' });
  });

  it('keeps which kinds sit in the second stack of a split area across restarts, a move to the other area taking a kind back to its first', async () => {
    const userDataDir = await before();
    const main = await startMain({ userDataDir });
    await main.api.invoke('settings.setPanelPlace', { kind: 'terminal', area: 'side', stack: 'second' });
    await main.api.invoke('settings.setPanelPlace', { kind: 'highlights', area: 'side', stack: 'second' });
    const { layout } = await main.api.invoke('settings.setPanelPlace', { kind: 'highlights', area: 'dock' });
    expect(layout.area).toEqual({ terminal: 'side', highlights: 'dock' });
    expect(layout.stack).toEqual({ terminal: 'second' });
    await main.close();

    const again = await startMain({ userDataDir });
    expect((await waitFor(again.api, 'settings', () => true)).layout.stack).toEqual({ terminal: 'second' });
  });

  it('keeps every change asked for at once, as when a split area is resized and sizes both its Panels', async () => {
    const userDataDir = await before();
    const main = await startMain({ userDataDir });
    await Promise.all([
      main.api.invoke('settings.setPanelSize', { kind: 'changes', dimension: 'width', size: 600 }),
      main.api.invoke('settings.setPanelSize', { kind: 'terminal', dimension: 'width', size: 600 }),
      main.api.invoke('settings.setPanelPlace', { kind: 'terminal', area: 'side', stack: 'second' }),
    ]);
    await main.close();

    const again = await startMain({ userDataDir });
    const { layout } = await waitFor(again.api, 'settings', () => true);
    expect(layout.width).toEqual({ changes: 600, terminal: 600 });
    expect(layout.stack).toEqual({ terminal: 'second' });
  });

  it('refuses to move a kind Loom has not, or to an area or a stack it has not', async () => {
    const main = await startMain({ userDataDir: await before() });
    await expect(main.api.invoke('settings.setPanelPlace', { kind: 'files' as never, area: 'dock' })).rejects.toThrow('"files" is not a Panel.');
    await expect(main.api.invoke('settings.setPanelPlace', { kind: 'changes', area: 'top' as never })).rejects.toThrow('not "top"');
    await expect(main.api.invoke('settings.setPanelPlace', { kind: 'changes', area: 'side', stack: 'third' as never })).rejects.toThrow('not "third"');
    expect((await waitFor(main.api, 'settings', () => true)).layout.area).toEqual({});
  });

  it('refuses a kind Loom has not, or a size that is not a number', async () => {
    const main = await startMain({ userDataDir: await before() });
    await expect(main.api.invoke('settings.setPanelSize', { kind: 'files' as never, dimension: 'width', size: 400 })).rejects.toThrow('"files" is not a Panel.');
    await expect(main.api.invoke('settings.setPanelSize', { kind: 'info' as never, dimension: 'width', size: 400 })).rejects.toThrow('"info" is not a Panel.');
    await expect(main.api.invoke('settings.setPanelSize', { kind: 'changes', dimension: 'depth' as never, size: 400 })).rejects.toThrow('not "depth"');
    await expect(main.api.invoke('settings.setPanelSize', { kind: 'changes', dimension: 'width', size: Number.NaN })).rejects.toThrow('number of pixels');
  });

  it('drops what the database holds that Loom no longer takes', async () => {
    const userDataDir = await before();
    await (await startMain({ userDataDir })).close();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("insert or replace into settings (key, value) values ('layout', ?)").run(JSON.stringify({ area: { changes: 'dock', files: 'side', terminal: 'top' }, stack: { changes: 'second', terminal: 'third', files: 'second', issue: 'first' }, width: { files: 300, info: 400, changes: 5000, terminal: 'wide' }, height: 12 }));
    db.close();

    const main = await startMain({ userDataDir });
    expect((await waitFor(main.api, 'settings', () => true)).layout).toEqual({ area: { changes: 'dock' }, stack: { changes: 'second' }, width: { changes: PANEL_MAX_SIZE.width }, height: {} });
  });
});

describe("the Inbox's width and whether it is shown", () => {
  it('are kept across restarts, the width within its least and most', async () => {
    const userDataDir = await before();
    const main = await startMain({ userDataDir });
    expect((await waitFor(main.api, 'settings', () => true)).inbox).toEqual(DEFAULT_INBOX);
    await main.api.invoke('settings.setInbox', { width: 300.6 });
    expect((await main.api.invoke('settings.setInbox', { open: false })).inbox).toEqual({ width: 301, open: false });
    expect((await main.api.invoke('settings.setInbox', { width: 10_000 })).inbox).toEqual({ width: INBOX_WIDTH.max, open: false });
    expect((await main.api.invoke('settings.setInbox', { width: 10 })).inbox).toEqual({ width: INBOX_WIDTH.min, open: false });
    await main.close();

    const again = await startMain({ userDataDir });
    expect((await waitFor(again.api, 'settings', () => true)).inbox).toEqual({ width: INBOX_WIDTH.min, open: false });
  });

  it('refuse a width that is not a number, or a shown that is not true or false', async () => {
    const main = await startMain({ userDataDir: await before() });
    await expect(main.api.invoke('settings.setInbox', { width: Number.NaN })).rejects.toThrow('number of pixels');
    await expect(main.api.invoke('settings.setInbox', { open: 'yes' as never })).rejects.toThrow('true or false');
  });

  it('fall back to the defaults for what the database holds that Loom no longer takes', async () => {
    const userDataDir = await before();
    await (await startMain({ userDataDir })).close();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("insert or replace into settings (key, value) values ('inbox', ?)").run(JSON.stringify({ width: 'wide', open: false }));
    db.close();

    const main = await startMain({ userDataDir });
    expect((await waitFor(main.api, 'settings', () => true)).inbox).toEqual({ width: DEFAULT_INBOX.width, open: false });
  });
});
