// Snapshots: whole-file copies of the Client's database, taken with
// `VACUUM INTO` before each migration (ADR 0007), so an upgrade, a downgrade
// or a damaged file never silently destroys the developer's data.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

export const SNAPSHOTS_DIR = 'snapshots';
const KEEP = 3;
const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-v\d+\.db$/;

export function snapshotsDir(userDataDir: string): string {
  return join(userDataDir, SNAPSHOTS_DIR);
}

/** Every snapshot's path, oldest first. */
export function listSnapshots(userDataDir: string): string[] {
  const dir = snapshotsDir(userDataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => SNAPSHOT_NAME.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Copies the open database, at schema version `version`, into a new snapshot,
 * then prunes all but the last three. Must not run inside a transaction.
 */
export function takeSnapshot(sqlite: BetterSqlite3.Database, userDataDir: string, version: number, now: number): void {
  const dir = snapshotsDir(userDataDir);
  mkdirSync(dir, { recursive: true });
  sqlite.prepare('VACUUM INTO ?').run(join(dir, `${stamp(now)}-v${version}.db`));
  for (const old of listSnapshots(userDataDir).slice(0, -KEEP)) rmSync(old, { force: true });
}

/**
 * Moves the database file and its -wal and -shm aside under a timestamped
 * name, never deleting them, then copies the latest snapshot into its place.
 * The database must be closed.
 */
export function restoreLatestSnapshot(databasePath: string, userDataDir: string, now: number): void {
  const latest = listSnapshots(userDataDir).at(-1);
  if (!latest) throw new Error('there is no snapshot to restore');
  const aside = `${databasePath}.damaged-${stamp(now)}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(databasePath + suffix)) renameSync(databasePath + suffix, aside + suffix);
  }
  copyFileSync(latest, databasePath);
}

/** A sortable, file-name-safe UTC timestamp. */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}
