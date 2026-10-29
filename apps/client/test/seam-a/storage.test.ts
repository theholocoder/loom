import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { startMain } from './harness';

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
    expect(inspect(userDataDir)).toEqual({ journalMode: 'wal', userVersion: 3, tables: ['checkouts', 'projects', 'sessions', 'settings', 'sqlite_sequence'] });
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
    expect(after.pragma('user_version', { simple: true })).toBe(3);
    after.close();
  });
});
