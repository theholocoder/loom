import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/storage/database';
import { beforeSquash, migrations } from '../../src/main/storage/migrations';

// feat/panels appended five migrations over main's 17, then squashed them into
// one before merging (#235). This proves the one gives a version-17 database
// the schema and data the five did. It goes, with the five, once it has passed.

const MAIN = 17;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-squash-'));
  dirs.push(dir);
  return dir;
}

/** A database at main's version, as main left it: a few Projects and Sessions, and the sidebar setting if given. */
async function mainDatabase(sidebar: string | undefined, sessions: number): Promise<string> {
  const dir = tempDir();
  await (await openDatabase(dir, { migrations: migrations.slice(0, MAIN) })).destroy();
  const db = new Database(join(dir, 'loom.db'));
  for (let id = 1; id <= 4; id++) db.prepare('insert into projects (id, name, branch_prefix, created_at) values (?, ?, ?, ?)').run(id, `project ${id}`, 'loom/', 1000 + id);
  for (let id = 1; id <= sessions; id++) {
    db.prepare(
      "insert into sessions (id, project_id, title, working_copy_kind, working_copy_path, agent, status, created_at, updated_at) values (?, ?, ?, 'worktree', ?, 'claude', 'idle', 1, 1)",
    ).run(id, (id % 4) + 1, `session ${id}`, `/tmp/wt${id}`);
  }
  db.prepare("insert into settings (key, value) values ('theme', '\"dark\"')").run();
  if (sidebar !== undefined) db.prepare("insert into settings (key, value) values ('sidebar', ?)").run(sidebar);
  db.close();
  return join(dir, 'loom.db');
}

/** The database at `file`, copied and migrated with `list`. */
async function migrated(file: string, list: typeof migrations) {
  const dir = tempDir();
  copyFileSync(file, join(dir, 'loom.db'));
  await (await openDatabase(dir, { migrations: list })).destroy();
  const db = new Database(join(dir, 'loom.db'), { readonly: true });
  try {
    return {
      schema: db.prepare("select type, name, tbl_name, sql from sqlite_master where name not like 'sqlite_%' order by type, name").all(),
      sessionPanels: db.prepare('select * from session_panels order by session_id').all(),
      settings: db.prepare('select * from settings order by key').all(),
      projects: db.prepare('select * from projects order by id').all(),
    };
  } finally {
    db.close();
  }
}

describe('the squashed feat/panels migration', () => {
  it('replaces five', () => {
    expect(beforeSquash).toHaveLength(5);
    expect(migrations).toHaveLength(MAIN + 1);
  });

  it.each([
    ['an open sidebar on Session info, widened', JSON.stringify({ open: true, view: 'info', width: 512.6 }), 3],
    ['a closed sidebar on Changes', JSON.stringify({ open: false, view: 'changes', width: 300 }), 3],
    ['an open sidebar on Changes, too wide', JSON.stringify({ open: true, view: 'changes', width: 5000 }), 2],
    ['a sidebar with no width', JSON.stringify({ open: true, view: 'changes' }), 2],
    ['a sidebar with a width that is not a number', JSON.stringify({ open: true, width: 'wide' }), 1],
    ['an unreadable sidebar', '{not json', 2],
    ['a sidebar that is not an object', '42', 2],
    ['no sidebar setting', undefined, 3],
    ['no Sessions', JSON.stringify({ open: true, view: 'info', width: 420 }), 0],
  ])('gives a version-17 database with %s the schema and data the five did', async (_, sidebar, sessions) => {
    const file = await mainDatabase(sidebar, sessions);

    const five = await migrated(file, [...migrations.slice(0, MAIN), ...beforeSquash]);
    const one = await migrated(file, migrations);

    expect(one).toEqual(five);
    expect(one.sessionPanels).toHaveLength(sessions);
  });
});
