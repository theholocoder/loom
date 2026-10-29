import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, sql, SqliteDialect } from 'kysely';
import { migrations, type Migration } from './migrations';
import type { Schema } from './schema';

export const DATABASE_FILE = 'loom.db';

export type LoomDatabase = Kysely<Schema>;

/** Opens (creating if needed) the Client's database in `userDataDir` and migrates it. */
export async function openDatabase(userDataDir: string): Promise<LoomDatabase> {
  const sqlite = new BetterSqlite3(join(userDataDir, DATABASE_FILE));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = new Kysely<Schema>({ dialect: new SqliteDialect({ database: sqlite }) });
  try {
    await migrate(db, migrations);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return db;
}

/** Applies every migration past the database's `user_version`, all in one transaction. */
async function migrate(db: Kysely<Schema>, all: Migration[]): Promise<void> {
  const { rows } = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
  const current = rows[0]?.user_version ?? 0;
  if (current > all.length) {
    throw new Error(`the database is at schema version ${current}, newer than this Client's ${all.length}`);
  }
  if (current === all.length) return;
  await db.transaction().execute(async (trx) => {
    for (let version = current + 1; version <= all.length; version++) {
      await all[version - 1]!(trx);
    }
    await sql.raw(`PRAGMA user_version = ${all.length}`).execute(trx);
  });
}
