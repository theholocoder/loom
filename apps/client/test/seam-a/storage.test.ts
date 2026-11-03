import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { startMain } from './harness';
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
    expect(inspect(userDataDir)).toEqual({ journalMode: 'wal', userVersion: migrations.length, tables: ['checkouts', 'events', 'projects', 'sessions', 'settings', 'sqlite_sequence'] });
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

function snapshots(userDataDir: string): string[] {
  const dir = join(userDataDir, 'snapshots');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
