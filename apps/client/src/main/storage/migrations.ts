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
  async (db) => {
    await db.schema
      .createTable('sessions')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('project_id', 'integer', (c) => c.notNull().references('projects.id').onDelete('cascade'))
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('working_copy_kind', 'text', (c) => c.notNull())
      .addColumn('working_copy_path', 'text', (c) => c.notNull())
      .addColumn('agent', 'text', (c) => c.notNull())
      .addColumn('agent_session_id', 'text')
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('waiting_reason', 'text')
      .addColumn('error', 'text')
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('updated_at', 'integer', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('sessions_project').on('sessions').column('project_id').execute();
  },
  async (db) => {
    await db.schema.alterTable('sessions').addColumn('unread', 'integer', (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable('sessions').addColumn('branch', 'text').execute();
  },
  async (db) => {
    await db.schema.alterTable('sessions').addColumn('issue_number', 'integer').execute();
    await db.schema.alterTable('sessions').addColumn('issue_url', 'text').execute();
    await db.schema.alterTable('sessions').addColumn('merge_request_number', 'integer').execute();
    await db.schema.alterTable('sessions').addColumn('merge_request_url', 'text').execute();
  },
  async (db) => {
    await db.schema
      .createTable('events')
      .addColumn('session_id', 'integer', (c) => c.notNull().references('sessions.id').onDelete('cascade'))
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('data', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('events_pk', ['session_id', 'seq'])
      .execute();
  },
  async (db) => {
    await db.schema.alterTable('projects').addColumn('trusted', 'integer').execute();
  },
  async (db) => {
    await db.schema
      .createTable('queued_messages')
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .addColumn('session_id', 'integer', (c) => c.notNull().references('sessions.id').onDelete('cascade'))
      .addColumn('text', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('queued_messages_session').on('queued_messages').column('session_id').execute();
  },
  async (db) => {
    await db.schema.alterTable('sessions').addColumn('model', 'text').execute();
    await db.schema.alterTable('sessions').addColumn('effort', 'text').execute();
    await db.schema.alterTable('sessions').addColumn('context_used', 'integer').execute();
    await db.schema.alterTable('sessions').addColumn('context_size', 'integer').execute();
  },
  async (db) => {
    await db.schema.alterTable('queued_messages').addColumn('attachments', 'text').execute();
  },
  async (db) => {
    await db.schema.alterTable('sessions').addColumn('merge_request_branch', 'text').execute();
    await db.schema.alterTable('sessions').addColumn('merge_request_by_hand', 'integer', (c) => c.notNull().defaultTo(0)).execute();
    // A link made before keeps to the branch it was last seen on.
    await db.updateTable('sessions').set((eb) => ({ merge_request_branch: eb.ref('branch') })).where('merge_request_number', 'is not', null).execute();
  },
  async (db) => {
    // Usage outlives its Session's Project: no foreign keys, the Project's name copied in.
    await db.schema
      .createTable('usage_buckets')
      .addColumn('session_id', 'integer', (c) => c.notNull())
      .addColumn('day', 'text', (c) => c.notNull())
      .addColumn('model', 'text', (c) => c.notNull())
      .addColumn('project_id', 'integer', (c) => c.notNull())
      .addColumn('project_name', 'text', (c) => c.notNull())
      .addColumn('input_tokens', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('output_tokens', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('cache_read_tokens', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('cache_write_tokens', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('reasoning_tokens', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('cost', 'real', (c) => c.notNull().defaultTo(0))
      .addPrimaryKeyConstraint('usage_buckets_pk', ['session_id', 'day', 'model'])
      .execute();
    await db.schema.createIndex('usage_buckets_day').on('usage_buckets').column('day').execute();
    await db.schema
      .createTable('session_spans')
      .addColumn('session_id', 'integer', (c) => c.notNull())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('started_at', 'integer', (c) => c.notNull())
      .addColumn('ended_at', 'integer', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('session_spans_ended').on('session_spans').column('ended_at').execute();
    // Unknown for a conversation from before: its first report is where its cost is counted from.
    await db.schema.alterTable('sessions').addColumn('reported_cost', 'real').execute();
    await db.schema.alterTable('sessions').addColumn('wait_carried_ms', 'integer', (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable('sessions').addColumn('archived_at', 'integer').execute();
    await db.schema.alterTable('sessions').addColumn('stuck_count', 'integer', (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable('sessions').addColumn('merge_request_state', 'text').execute();
    // A Session archived before has its last status change as its archive time.
    await db.updateTable('sessions').set((eb) => ({ archived_at: eb.ref('updated_at') })).where('status', '=', 'archived').execute();
    await db.updateTable('sessions').set({ merge_request_state: 'open' }).where('merge_request_number', 'is not', null).execute();
  },
  async (db) => {
    await db.schema
      .createTable('babysit')
      .addColumn('session_id', 'integer', (c) => c.primaryKey().references('sessions.id').onDelete('cascade'))
      .addColumn('state', 'text', (c) => c.notNull())
      .execute();
  },
  async (db) => {
    await db.schema.alterTable('sessions').addColumn('auto_prompt', 'integer', (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable('sessions').addColumn('auto_prompts_in_a_row', 'integer', (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable('sessions').addColumn('babysit_off', 'integer', (c) => c.notNull().defaultTo(0)).execute();
  },
  async (db) => {
    await db.schema.alterTable('projects').addColumn('removed_at', 'integer').execute();
    await db.schema.alterTable('projects').addColumn('identity', 'text').execute();
  },
  async (db) => {
    await db.schema.alterTable('sessions').addColumn('snoozed_until', 'integer').execute();
  },
  async (db) => {
    // A Session from before asked the user, as Supervised does.
    await db.schema.alterTable('sessions').addColumn('approval_mode', 'text', (c) => c.notNull().defaultTo('supervised')).execute();
  },
];
