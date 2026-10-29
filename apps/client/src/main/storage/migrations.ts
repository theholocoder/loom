import type { Kysely } from 'kysely';

// Bundled, forward-only migrations. A migration's version is its position in
// this list (the first is version 1), and the database's `PRAGMA user_version`
// records the last one applied. Never edit or reorder a shipped migration:
// append a new one.

export type Migration = (db: Kysely<any>) => Promise<void>;

export const migrations: Migration[] = [
  async (db) => {
    await db.schema
      .createTable('settings')
      .addColumn('key', 'text', (c) => c.primaryKey())
      .addColumn('value', 'text', (c) => c.notNull())
      .execute();
  },
];
