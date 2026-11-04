import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { startMain, waitFor } from './harness';
import { openDatabase } from '../../src/main/storage/database';
import { migrations, type Migration } from '../../src/main/storage/migrations';

// The database is a file on disk the Client owns; these tests read it the way
// a user backing it up would, with main closed.
function inspect(userDataDir: string) {
  const db = new Database(join(userDataDir, 'loom.db'), { readonly: true });
  try {
    return {
      journalMode: db.pragma('journal_mode', { simple: true }),
      userVersion: db.pragma('user_version', { simple: true }),
      tables: (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[]).map((t) => t.name),
    };
  } finally {
    db.close();
  }
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-storage-'));
  dirs.push(dir);
  return dir;
}

describe('the local database', () => {
  it('is created in userData in WAL mode and migrated to the current schema', async () => {
    const userDataDir = tempUserData();

    const main = await startMain({ userDataDir });
    await main.close();

    expect(existsSync(join(userDataDir, 'loom.db'))).toBe(true);
    expect(inspect(userDataDir)).toEqual({ journalMode: 'wal', userVersion: migrations.length, tables: ['checkouts', 'events', 'projects', 'queued_messages', 'sessions', 'settings', 'sqlite_sequence'] });
  });

  it('keeps its data and schema version when main starts again', async () => {
    const userDataDir = tempUserData();
    await (await startMain({ userDataDir })).close();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("insert into settings (key, value) values ('marker', '\"kept\"')").run();
    db.close();

    await (await startMain({ userDataDir })).close();

    const after = new Database(join(userDataDir, 'loom.db'), { readonly: true });
    expect(after.prepare("select value from settings where key = 'marker'").get()).toEqual({ value: '"kept"' });
    expect(after.pragma('user_version', { simple: true })).toBe(migrations.length);
    after.close();
  });

  it('takes no snapshot when it is created or already current', async () => {
    const userDataDir = tempUserData();
    await (await startMain({ userDataDir })).close();
    await (await startMain({ userDataDir })).close();

    expect(snapshots(userDataDir)).toEqual([]);
  });
});

describe('snapshots', () => {
  it('are taken with VACUUM INTO before a pending migration, named with the version they were taken at', async () => {
    const userDataDir = tempUserData();
    const from = migrations.length - 1;
    await (await openDatabase(userDataDir, { migrations: migrations.slice(0, from) })).destroy();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("insert into settings (key, value) values ('marker', '\"before\"')").run();
    db.close();

    await (await startMain({ userDataDir })).close();

    const taken = snapshots(userDataDir);
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatch(new RegExp(`-v${from}\\.db$`));
    const snapshot = new Database(join(userDataDir, 'snapshots', taken[0]!), { readonly: true });
    expect(snapshot.pragma('user_version', { simple: true })).toBe(from);
    expect(snapshot.prepare("select value from settings where key = 'marker'").get()).toEqual({ value: '"before"' });
    snapshot.close();
    expect(inspect(userDataDir).userVersion).toBe(migrations.length);
  });

  it('keeps only the last three', async () => {
    const userDataDir = tempUserData();
    const list: Migration[] = [];
    let now = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      list.push(async (db) => void (await db.schema.createTable(`t${i}`).addColumn('id', 'integer').execute()));
      await (await openDatabase(userDataDir, { migrations: [...list], now: () => (now += 60_000) })).destroy();
    }

    expect(snapshots(userDataDir).map((name) => name.replace(/^.*-v/, 'v'))).toEqual(['v2.db', 'v3.db', 'v4.db']);
  });
});

describe('a schema newer than the Client knows', () => {
  it('refuses to start, naming both versions and the snapshots, and leaves the file untouched', async () => {
    const userDataDir = tempUserData();
    await (await startMain({ userDataDir })).close();
    const newer = migrations.length + 1;
    const db = new Database(join(userDataDir, 'loom.db'));
    db.pragma(`user_version = ${newer}`);
    db.close();
    const before = readFileSync(join(userDataDir, 'loom.db'));

    const started = startMain({ userDataDir });

    await expect(started).rejects.toThrow(`schema version ${newer}, but this Client only knows up to version ${migrations.length}`);
    await expect(started).rejects.toThrow(join(userDataDir, 'snapshots'));
    expect(readFileSync(join(userDataDir, 'loom.db')).equals(before)).toBe(true);
    expect(snapshots(userDataDir)).toEqual([]);
  });
});

describe('a damaged database', () => {
  /** A database at the current schema with a marker, a snapshot of it, then a damaged file in its place. */
  async function damagedWithSnapshot(userDataDir: string) {
    await (await openDatabase(userDataDir, { migrations: migrations.slice(0, migrations.length - 1) })).destroy();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("insert into settings (key, value) values ('marker', '\"snapshotted\"')").run();
    db.close();
    await (await startMain({ userDataDir })).close();
    damage(userDataDir);
  }

  it('is reported to the renderer with its path and the snapshots, and is not repaired', async () => {
    const userDataDir = tempUserData();
    await damagedWithSnapshot(userDataDir);
    const damagedBytes = readFileSync(join(userDataDir, 'loom.db'));

    const main = await startMain({ userDataDir });

    const status = await waitFor(main.api, 'database', (s) => s.state === 'damaged');
    expect(status).toMatchObject({
      state: 'damaged',
      path: join(userDataDir, 'loom.db'),
      snapshots: snapshots(userDataDir).map((name) => join(userDataDir, 'snapshots', name)).reverse(),
    });
    await expect(main.api.invoke('projects.list')).rejects.toThrow();
    await main.close();
    expect(readFileSync(join(userDataDir, 'loom.db')).equals(damagedBytes)).toBe(true);
  });

  it('restores the latest snapshot, moving the damaged file aside, then starts', async () => {
    const userDataDir = tempUserData();
    await damagedWithSnapshot(userDataDir);
    const damagedBytes = readFileSync(join(userDataDir, 'loom.db'));
    const main = await startMain({ userDataDir });

    await main.api.invoke('database.restoreLatestSnapshot');

    expect(await waitFor(main.api, 'database', (s) => s.state === 'ok')).toEqual({ state: 'ok' });
    expect(await main.api.invoke('projects.list')).toEqual([]);
    await main.close();
    const aside = readdirSync(userDataDir).filter((name) => name.startsWith('loom.db.damaged-'));
    expect(aside.length).toBeGreaterThan(0);
    expect(readFileSync(join(userDataDir, aside.find((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))!)).equals(damagedBytes)).toBe(true);
    const restored = new Database(join(userDataDir, 'loom.db'), { readonly: true });
    expect(restored.prepare("select value from settings where key = 'marker'").get()).toEqual({ value: '"snapshotted"' });
    expect(restored.pragma('user_version', { simple: true })).toBe(migrations.length);
    restored.close();
  });

  it('with no snapshot, reports none and cannot be restored', async () => {
    const userDataDir = tempUserData();
    writeFileSync(join(userDataDir, 'loom.db'), 'this is not a database, just some text that is long enough to fill a header');

    const main = await startMain({ userDataDir });

    expect(await waitFor(main.api, 'database', (s) => s.state === 'damaged')).toMatchObject({ snapshots: [] });
    await expect(main.api.invoke('database.restoreLatestSnapshot')).rejects.toThrow('no snapshot');
    await main.close();
    expect(existsSync(join(userDataDir, 'loom.db'))).toBe(true);
  });
});

/** Overwrites the middle of the database file, as a failing disk might. */
function damage(userDataDir: string) {
  const path = join(userDataDir, 'loom.db');
  const bytes = readFileSync(path);
  const pageSize = bytes.readUInt16BE(16) || 65536;
  expect(statSync(path).size).toBeGreaterThan(pageSize);
  bytes.fill(0xa5, pageSize, bytes.length);
  writeFileSync(path, bytes);
}

function snapshots(userDataDir: string): string[] {
  const dir = join(userDataDir, 'snapshots');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
