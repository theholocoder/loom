import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, sql, SqliteDialect } from 'kysely';
import { migrations as bundled, type Migration } from './migrations';
import type { Schema } from './schema';
import { listSnapshots, snapshotsDir, takeSnapshot } from './snapshots';

export const DATABASE_FILE = 'loom.db';

export type LoomDatabase = Kysely<Schema>;

/** The database file failed `PRAGMA quick_check`, or isn't a database at all. Loom never repairs it. */
export class DatabaseDamagedError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`the database ${path} is damaged: ${problem}`);
  }
}

export interface OpenOptions {
  /** The migrations to apply; the bundled ones unless a test injects its own. */
  migrations?: Migration[];
  /** The time snapshots are named with. */
  now?: () => number;
}

/**
 * Opens (creating if needed) the Client's database in `userDataDir`, checks
 * it, snapshots it if a migration is pending, and migrates it. Throws
 * DatabaseDamagedError if the file is damaged, and refuses a schema newer
 * than this Client knows; either way without writing to it.
 */
export async function openDatabase(userDataDir: string, options: OpenOptions = {}): Promise<LoomDatabase> {
  const all = options.migrations ?? bundled;
  const path = join(userDataDir, DATABASE_FILE);
  const sqlite = new BetterSqlite3(path);
  let current: number;
  try {
    current = check(sqlite, path);
    if (current > all.length) throw newerSchema(userDataDir, path, current, all.length);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    if (current > 0 && current < all.length) takeSnapshot(sqlite, userDataDir, current, (options.now ?? Date.now)());
  } catch (error) {
    // Closed before anything moves the file, which Windows wouldn't allow while open.
    sqlite.close();
    throw error;
  }
  const db = new Kysely<Schema>({ dialect: new SqliteDialect({ database: sqlite }) });
  try {
    await migrate(db, all, current);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return db;
}

/** Runs `PRAGMA quick_check` and returns the schema version. */
function check(sqlite: BetterSqlite3.Database, path: string): number {
  let result: unknown[];
  try {
    result = sqlite.pragma('quick_check', { simple: false }) as unknown[];
  } catch (error) {
    throw new DatabaseDamagedError(path, (error as Error).message);
  }
  const problems = result.map((row) => Object.values(row as object)[0]).filter((message) => message !== 'ok');
  if (problems.length) throw new DatabaseDamagedError(path, problems.join('; '));
  return sqlite.pragma('user_version', { simple: true }) as number;
}

function newerSchema(userDataDir: string, path: string, current: number, known: number): Error {
  const snapshots = listSnapshots(userDataDir);
  return new Error(
    `The database ${path} is at schema version ${current}, but this Client only knows up to version ${known}. ` +
      `Update Loom to a version that knows schema version ${current}. ` +
      (snapshots.length
        ? `Snapshots taken before earlier migrations are in ${snapshotsDir(userDataDir)}: ${snapshots.join(', ')}.`
        : `There are no snapshots in ${snapshotsDir(userDataDir)}.`),
  );
}

/** Applies every migration past `current`, all in one transaction. */
async function migrate(db: Kysely<Schema>, all: Migration[], current: number): Promise<void> {
  if (current === all.length) return;
  await db.transaction().execute(async (trx) => {
    for (let version = current + 1; version <= all.length; version++) {
      await all[version - 1]!(trx);
    }
    await sql.raw(`PRAGMA user_version = ${all.length}`).execute(trx);
  });
}
