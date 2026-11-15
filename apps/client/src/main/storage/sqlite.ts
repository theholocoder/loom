// The SQLite connection under Kysely: better-sqlite3 when its prebuilt binary
// loads, else Node's own node:sqlite. better-sqlite3's Linux prebuild needs
// glibc 2.34 (Ubuntu 22.04, Debian 12, RHEL 9), while Electron runs on older
// Linux; node:sqlite, built into Electron's Node, runs wherever Electron does.
// Both open the same file in the same way, so either can follow the other.
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import type { SqliteDatabase } from 'kysely';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type SqliteDriver = 'better-sqlite3' | 'node:sqlite';

/** An open SQLite database, whichever driver opened it. */
export interface Sqlite {
  /** Every row `statement` gives. */
  all(statement: string, ...params: unknown[]): Record<string, unknown>[];
  /** Runs `statement`, which may give rows or not, for what it does. */
  run(statement: string, ...params: unknown[]): void;
  /** Defines a deterministic SQL function of one argument. */
  function(name: string, fn: (value: unknown) => unknown): void;
  /** The connection as Kysely's SqliteDialect takes it. */
  readonly kysely: SqliteDatabase;
  close(): void;
}

// Loaded only when used: requiring better-sqlite3 is cheap, but its binary
// loads on first use, and node:sqlite warns that it is experimental.
const load = createRequire(import.meta.url);

/** Busy timeout, as better-sqlite3 sets by default; node:sqlite would wait for nothing. */
const BUSY_TIMEOUT_MS = 5000;

let betterSqlite3Loads: boolean | undefined;

/** Whether better-sqlite3's binary loads here, tried once. */
function betterSqlite3Available(): boolean {
  if (betterSqlite3Loads === undefined) {
    try {
      const Database = load('better-sqlite3') as typeof BetterSqlite3;
      new Database(':memory:').close();
      betterSqlite3Loads = true;
    } catch (error) {
      console.warn(`better-sqlite3 could not load (${(error as Error).message}); Loom opens its database with node:sqlite instead.`);
      betterSqlite3Loads = false;
    }
  }
  return betterSqlite3Loads;
}

/** Opens (creating if needed) the database at `path`, with `driver`, or the best one that loads. */
export function openSqlite(path: string, driver?: SqliteDriver): Sqlite {
  const chosen = driver ?? (betterSqlite3Available() ? 'better-sqlite3' : 'node:sqlite');
  return chosen === 'better-sqlite3' ? openBetterSqlite3(path) : openNodeSqlite(path);
}

function openBetterSqlite3(path: string): Sqlite {
  const Database = load('better-sqlite3') as typeof BetterSqlite3;
  const db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
  return {
    all: (statement, ...params) => db.prepare(statement).all(...params) as Record<string, unknown>[],
    run: (statement, ...params) => {
      const prepared = db.prepare(statement);
      if (prepared.reader) prepared.all(...params);
      else prepared.run(...params);
    },
    function: (name, fn) => db.function(name, { deterministic: true }, fn),
    kysely: db,
    close: () => db.close(),
  };
}

function openNodeSqlite(path: string): Sqlite {
  const { DatabaseSync: Database } = load('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
  const db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
  const input = (params: readonly unknown[]) => params as SQLInputValue[];
  return {
    all: (statement, ...params) => db.prepare(statement).all(...input(params)) as Record<string, unknown>[],
    run: (statement, ...params) => {
      const prepared = db.prepare(statement);
      if (prepared.columns().length) prepared.all(...input(params));
      else prepared.run(...input(params));
    },
    function: (name, fn) => db.function(name, { deterministic: true }, (value) => fn(value) as SQLInputValue),
    kysely: {
      close: () => db.close(),
      prepare: (statement) => {
        const prepared = db.prepare(statement);
        return {
          // A statement that gives columns gives rows, RETURNING included, as better-sqlite3's `reader` says.
          reader: prepared.columns().length > 0,
          all: (params) => prepared.all(...input(params)),
          run: (params) => prepared.run(...input(params)),
          iterate: (params) => prepared.iterate(...input(params)),
        };
      },
    },
    close: () => db.close(),
  };
}
