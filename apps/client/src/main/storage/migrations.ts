import { sql, type Kysely } from 'kysely';

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
  async (db) => {
    // One Panel model (ADR 0009): each Session's Panels, and the Layout's sizes in settings.
    await db.schema
      .createTable('session_panels')
      .addColumn('session_id', 'integer', (c) => c.primaryKey().references('sessions.id').onDelete('cascade'))
      .addColumn('state', 'text', (c) => c.notNull())
      .execute();
    // The sidebar was app-wide, `{ open, view, width }`, with Session info and Changes as its views,
    // closed on Session info at 420px until changed. Every Session had both views, as it left them.
    const row = (await db.selectFrom('settings').select('value').where('key', '=', 'sidebar').executeTakeFirst()) as { value: string } | undefined;
    let sidebar: Record<string, unknown> = {};
    try {
      const parsed: unknown = row ? JSON.parse(row.value) : {};
      if (typeof parsed === 'object' && parsed !== null) sidebar = parsed as Record<string, unknown>;
    } catch {
      // Unreadable: as if never set.
    }
    const open = typeof sidebar.open === 'boolean' ? sidebar.open : false;
    const view = sidebar.view === 'changes' ? 'changes' : 'info';
    const state = JSON.stringify({ side: { panels: ['info', 'changes'], shown: view, open }, dock: { panels: [], shown: null, open: false } });
    const sessions = (await db.selectFrom('sessions').select('id').execute()) as Array<{ id: number }>;
    if (sessions.length) await db.insertInto('session_panels').values(sessions.map(({ id }) => ({ session_id: id, state }))).execute();
    // The one width both views had becomes each one's.
    if (typeof sidebar.width === 'number' && Number.isFinite(sidebar.width)) {
      const width = Math.min(1200, Math.max(280, Math.round(sidebar.width)));
      const layout = JSON.stringify({ width: { info: width, changes: width }, height: {} });
      await db.insertInto('settings').values({ key: 'layout', value: layout }).onConflict((c) => c.column('key').doUpdateSet({ value: layout })).execute();
    }
    await db.deleteFrom('settings').where('key', '=', 'sidebar').execute();
  },
  async (db) => {
    // Session info is no longer a Panel: the Glance strip and Session details took its place.
    // A Side area or Dock left with none is hidden; one that showed it shows its first Panel.
    const rows = (await db.selectFrom('session_panels').selectAll().execute()) as Array<{ session_id: number; state: string }>;
    for (const row of rows) {
      let state: unknown;
      try {
        state = JSON.parse(row.state);
      } catch {
        continue; // Unreadable: dropped for the default when loaded.
      }
      if (typeof state !== 'object' || state === null) continue;
      let changed = false;
      for (const area of Object.values(state as Record<string, unknown>)) {
        if (typeof area !== 'object' || area === null) continue;
        const panels = (area as Record<string, unknown>).panels;
        if (!Array.isArray(panels) || !panels.includes('info')) continue;
        const kept = panels.filter((panel) => panel !== 'info');
        const at = area as Record<string, unknown>;
        at.panels = kept;
        if (at.shown === 'info') at.shown = kept[0] ?? null;
        if (kept.length === 0) at.open = false;
        changed = true;
      }
      if (changed) await db.updateTable('session_panels').set({ state: JSON.stringify(state) }).where('session_id', '=', row.session_id).execute();
    }
    const layout = (await db.selectFrom('settings').select('value').where('key', '=', 'layout').executeTakeFirst()) as { value: string } | undefined;
    if (!layout) return;
    try {
      const sizes: unknown = JSON.parse(layout.value);
      if (typeof sizes !== 'object' || sizes === null) return;
      for (const dimension of Object.values(sizes as Record<string, unknown>)) {
        if (typeof dimension === 'object' && dimension !== null) delete (dimension as Record<string, unknown>).info;
      }
      await db.updateTable('settings').set({ value: JSON.stringify(sizes) }).where('key', '=', 'layout').execute();
    } catch {
      // Unreadable: the Layout reads it as unset.
    }
  },
  async (db) => {
    // Session highlights (ADR 0010): each Session's Highlights, and how far its turns have been checked.
    await db.schema
      .createTable('highlights')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('session_id', 'integer', (c) => c.notNull().references('sessions.id').onDelete('cascade'))
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('text', 'text', (c) => c.notNull())
      .addColumn('item_id', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('resolved_by', 'text')
      .addColumn('resolved_reason', 'text')
      .addColumn('resolved_item_id', 'integer')
      .addColumn('resolved_at', 'integer')
      .execute();
    await db.schema.createIndex('highlights_session').on('highlights').column('session_id').execute();
    await db.schema
      .createTable('highlight_checks')
      .addColumn('session_id', 'integer', (c) => c.primaryKey().references('sessions.id').onDelete('cascade'))
      .addColumn('checked_through', 'integer', (c) => c.notNull())
      .addColumn('seen_through', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('error', 'text')
      .execute();
    // Their checks' usage, apart from the Sessions' own: like usage_buckets, it outlives the Session and its Project.
    await db.schema
      .createTable('highlight_usage')
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
      .addPrimaryKeyConstraint('highlight_usage_pk', ['session_id', 'day', 'model'])
      .execute();
    await db.schema.createIndex('highlight_usage_day').on('highlight_usage').column('day').execute();
  },
  async (db) => {
    // Each model's name as the agent gave it, so the dashboard names models as the rest of the Client does.
    for (const table of ['usage_buckets', 'highlight_usage']) await db.schema.alterTable(table).addColumn('model_name', 'text').execute();
  },
  async (db) => {
    // A Project's colour, avatar and default model, chosen by the user. Every
    // Project keeps the colour it had, picked by id among the first three.
    await db.schema.alterTable('projects').addColumn('color', 'text', (c) => c.notNull().defaultTo('blue')).execute();
    await db.schema.alterTable('projects').addColumn('avatar', 'text').execute();
    await db.schema.alterTable('projects').addColumn('default_model', 'text').execute();
    await db.schema.alterTable('projects').addColumn('default_effort', 'text').execute();
    await sql`update projects set color = case id % 3 when 0 then 'blue' when 1 then 'orange' else 'aqua' end`.execute(db);
  },
];
