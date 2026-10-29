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
  async (db) => {
    await db.schema
      .createTable('projects')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('branch_prefix', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('checkouts')
      .addColumn('project_id', 'integer', (c) => c.primaryKey().references('projects.id').onDelete('cascade'))
      .addColumn('environment_id', 'text', (c) => c.notNull())
      .addColumn('path', 'text', (c) => c.notNull())
      .addUniqueConstraint('checkouts_environment_path', ['environment_id', 'path'])
      .execute();
  },
];
