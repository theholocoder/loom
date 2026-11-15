import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { startMain, tempDir, waitFor } from './harness';
import { FOLD_CASE, openDatabase } from '../../src/main/storage/database';
import { migrations } from '../../src/main/storage/migrations';

// better-sqlite3's Linux prebuild needs glibc 2.34; on an older Linux, Loom
// falls back to Node's own node:sqlite, which must keep the same database.
describe('the node:sqlite driver', () => {
  it('runs main, keeping what it is given across a restart, in the same file better-sqlite3 reads', async () => {
    const userDataDir = tempDir('loom-node-sqlite-');
    const main = await startMain({ userDataDir, sqliteDriver: 'node:sqlite' });
    await main.api.invoke('settings.setStuckAfterMinutes', { minutes: 42 });
    await main.close();

    const again = await startMain({ userDataDir, sqliteDriver: 'node:sqlite' });
    await waitFor(again.api, 'settings', (s) => s.stuckAfterMinutes === 42);
    await again.close();

    const file = new Database(join(userDataDir, 'loom.db'), { readonly: true });
    expect(file.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(file.pragma('user_version', { simple: true })).toBe(migrations.length);
    file.close();
  });

  it('opens a database better-sqlite3 wrote, snapshotting it before a pending migration', async () => {
    const userDataDir = tempDir('loom-node-sqlite-');
    await (await openDatabase(userDataDir, { migrations: migrations.slice(0, -1), driver: 'better-sqlite3' })).destroy();

    const db = await openDatabase(userDataDir, { driver: 'node:sqlite' });
    const { rows } = await sql<{ user_version: number }>`pragma user_version`.execute(db);
    expect(rows).toEqual([{ user_version: migrations.length }]);
    await db.destroy();
    expect(readdirSync(join(userDataDir, 'snapshots'))).toHaveLength(1);
  });

  it('folds case as JavaScript does, and gives back inserted ids and changed rows', async () => {
    const db = await openDatabase(tempDir('loom-node-sqlite-'), { driver: 'node:sqlite' });
    const { rows } = await sql<{ folded: string }>`select ${sql.raw(FOLD_CASE)}('ÉCOLE Straße') as folded`.execute(db);
    expect(rows).toEqual([{ folded: 'école straße' }]);

    const inserted = await db.insertInto('settings').values({ key: 'a', value: '1' }).executeTakeFirst();
    expect(inserted.numInsertedOrUpdatedRows).toBe(1n);
    const updated = await db.updateTable('settings').set({ value: '2' }).where('key', '=', 'a').executeTakeFirst();
    expect(updated.numUpdatedRows).toBe(1n);
    expect(await db.selectFrom('settings').select('value').where('key', '=', 'a').executeTakeFirst()).toEqual({ value: '2' });
    await db.destroy();
  });
});
