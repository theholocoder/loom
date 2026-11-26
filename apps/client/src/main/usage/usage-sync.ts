// Counting usage from each agent's own records (ADR 0012). For an agent that
// keeps them (AgentAdapter.usage), Loom lists its conversations in each
// Environment, Loom's and the user's own alike, and counts each step that
// used the model on the day it completed, under its model: a Session's own
// conversation's and its Subagents' for that Session, Session highlights'
// checks' for Session highlights, and any other's for "outside Loom". How far
// each conversation has been counted is kept, so nothing is counted twice
// however often Loom looks. The steps from before Loom first read the
// records are counted into the past once, in the background. It is agent
// agnostic: an agent only has to list its conversations and their steps
// (AgentUsageSource).
import type { Transaction } from 'kysely';
import { totalTokens, type TokenCounts } from '../../shared/api';
import type { AgentConversation, AgentUsageSource, UsageStep } from '../agents/adapter';
import type { Clock } from '../clock';
import type { BridgeCall } from '../environments/exec';
import type { LoomDatabase } from '../storage/database';
import type { AgentConversationsTable, ConversationOwner, Schema } from '../storage/schema';
import { dayOf, recordTurn } from './usage';

/**
 * How far before the last change seen a listing starts again: a conversation
 * that changed while the agent was being listed is read again. Reading one
 * again counts nothing twice.
 */
export const SYNC_OVERLAP_MS = 5 * 60_000;

/** The longest chain of Subagents followed up to the conversation that started it. */
const MAX_DEPTH = 16;
/** Ids asked of the database at once. */
const ID_BATCH = 500;
/** Sorts after any step id: at a conversation's first reading, every step completed by then is the past's. */
const ALL_STEPS = '￿';

type Agent = { name: string; usage: AgentUsageSource };

export interface UsageSyncOptions {
  db: LoomDatabase;
  clock: Clock;
  /** The agents whose own records Loom reads, by name, as their Sessions name them. */
  agents: ReadonlyArray<Agent>;
  /** How to ask the Environment with this id, if Loom has it and it is connected. */
  environment: (id: string) => BridgeCall | undefined;
  /**
   * Whether a folder in the Environment is one of Loom's own (a worktree it
   * made, Session highlights' checks' folder): what ran there before Loom
   * first read the records was counted from Loom's runs, or was a Session's
   * since deleted.
   */
  loomFolder: (environmentId: string, directory: string) => boolean;
  /** What a Session's usage is filed under: undefined for one Loom no longer has. */
  session: (id: number) => { projectId: number; projectName: string; modelName: (model: string) => string | undefined } | undefined;
  /** Usage was added to a Session's own. */
  onSessionUsage: (id: number, tokens: TokenCounts, cost: number) => void;
}

/** Whose a conversation is, once known. */
interface Owner {
  owner: ConversationOwner;
  sessionId: number | null;
}

/** Usage added up by day and model. */
type Tally = Map<string, { day: string; model: string; tokens: TokenCounts; cost: number }>;

const NOTHING: TokenCounts = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

export class UsageSync {
  /** The agents' records read at least once, by `agent\0environment`: their usage is counted from them, not from what Loom's runs report. */
  private readonly covered = new Set<string>();
  /** The reading going on for each, and the one asked to follow it. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Map<string, Promise<void>>();
  /** The counting of the past going on for each. */
  private readonly backfills = new Map<string, Promise<void>>();
  /** Those with past steps still to count, as far as Loom knows. */
  private readonly pastPending = new Set<string>();
  /** The last failure reported for each, so a lasting one is reported once. */
  private readonly failures = new Map<string, string>();
  private stopped = false;

  private constructor(private readonly options: UsageSyncOptions) {}

  static async load(options: UsageSyncOptions): Promise<UsageSync> {
    const sync = new UsageSync(options);
    for (const row of await options.db.selectFrom('usage_syncs').select(['agent', 'environment_id']).execute()) sync.covered.add(keyOf(row.agent, row.environment_id));
    const pending = await options.db.selectFrom('agent_conversations').select(['agent', 'environment_id']).where('backfill_through', 'is not', null).groupBy(['agent', 'environment_id']).execute();
    for (const row of pending) sync.pastPending.add(keyOf(row.agent, row.environment_id));
    return sync;
  }

  /**
   * Whether the agent's usage in the Environment is counted from its own
   * records: once they have been read. Until then, what Loom's runs report
   * is counted instead.
   */
  covers(agent: string, environmentId: string): boolean {
    return this.covered.has(keyOf(agent, environmentId));
  }

  /** Whether usage from before Loom first read some agent's records is still being counted. */
  countingPast(): boolean {
    return this.pastPending.size > 0;
  }

  /** Files the agent's conversation `id` as a Session highlights check of Session `sessionId`, before it uses anything. */
  async registerHighlights(agent: string, environmentId: string, id: string, sessionId: number): Promise<void> {
    await this.options.db
      .insertInto('agent_conversations')
      .values({ agent, environment_id: environmentId, id, owner: 'highlights', session_id: sessionId, seen_through: 0, counted_through: 0, counted_step: '', backfill_through: null, model: null, past_total: null, ...columnsOf(NOTHING, 0) })
      // A reading that came first may have filed it as outside Loom, before it used anything.
      .onConflict((oc) => oc.columns(['agent', 'environment_id', 'id']).doUpdateSet({ owner: 'highlights', session_id: sessionId }))
      .execute();
  }

  /**
   * Reads the agent's records in the Environment (every agent's, without
   * one) and counts what changed. One asked while one runs follows it.
   * Never rejects: a failure is logged, and what it missed is counted next time.
   */
  sync(environmentId: string, agent?: string): Promise<void> {
    const agents = this.options.agents.filter((a) => agent === undefined || a.name === agent);
    return Promise.all(agents.map((a) => this.syncOne(a, environmentId))).then(() => {});
  }

  /** Starts no more readings, and resolves once those going on have ended: what they leave is counted at the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.running.values(), ...this.again.values(), ...this.backfills.values()]);
  }

  private syncOne(agent: Agent, environmentId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const key = keyOf(agent.name, environmentId);
    const current = this.running.get(key);
    if (current) {
      let next = this.again.get(key);
      if (!next) {
        next = current.then(() => {
          this.again.delete(key);
          return this.syncOne(agent, environmentId);
        });
        this.again.set(key, next);
      }
      return next;
    }
    const run = this.read(agent, environmentId)
      .then(() => {
        this.failures.delete(key);
        this.backfill(agent, environmentId);
      })
      .catch((error: unknown) => this.failed(key, `could not read ${agent.name}'s usage in Environment ${environmentId}:`, error))
      .finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }

  private failed(key: string, what: string, error: unknown): void {
    const message = (error as Error).message;
    if (this.failures.get(key) !== message) console.error(what, message);
    this.failures.set(key, message);
  }

  private async read(agent: Agent, environmentId: string): Promise<void> {
    const call = this.options.environment(environmentId);
    if (!call) return;
    const { db } = this.options;
    const state = await db.selectFrom('usage_syncs').select('synced_through').where('agent', '=', agent.name).where('environment_id', '=', environmentId).executeTakeFirst();
    const conversations = await agent.usage.conversations(call, state === undefined ? undefined : state.synced_through - SYNC_OVERLAP_MS);
    const owners = await this.ownersOf(agent.name, environmentId, conversations);
    const counted = await this.countedOf(agent.name, environmentId, conversations.map((c) => c.id));
    const syncedThrough = Math.max(state?.synced_through ?? 0, ...conversations.map((c) => c.updatedAt));

    if (state === undefined) {
      // The first reading counts nothing now: every step so far is the past's, counted in the background.
      await db.transaction().execute(async (trx) => {
        for (const c of conversations) {
          const owner = owners.get(c.id)!;
          // All it has used so far is accounted for: the past's, counted in the background.
          const past = { seen_through: c.updatedAt, counted_through: c.updatedAt, counted_step: ALL_STEPS, backfill_through: c.updatedAt, past_total: c.total ? JSON.stringify(c.total) : null, ...columnsOf(c.total?.tokens ?? NOTHING, c.total?.cost ?? 0) };
          await trx
            .insertInto('agent_conversations')
            .values({ agent: agent.name, environment_id: environmentId, id: c.id, owner: owner.owner, session_id: owner.sessionId, model: null, ...past })
            // One filed already (a check filed before it ran) keeps its owner.
            .onConflict((oc) => oc.columns(['agent', 'environment_id', 'id']).doUpdateSet(past))
            .execute();
        }
        // What Loom recorded of its Sessions' runs so far: their past steps count beyond it, however much they run meanwhile.
        const columns = ['day', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'cost'] as const;
        await trx
          .insertInto('usage_baseline')
          .columns(['agent', 'environment_id', 'session_id', ...columns])
          .expression(
            trx
              .selectFrom('usage_buckets')
              .innerJoin('sessions', 'sessions.id', 'usage_buckets.session_id')
              .where('sessions.agent', '=', agent.name)
              .select((eb) => [eb.val(agent.name).as('agent'), eb.val(environmentId).as('environment_id'), 'usage_buckets.session_id', ...columns.map((c) => `usage_buckets.${c}` as const)]),
          )
          .onConflict((oc) => oc.doNothing())
          .execute();
        await saveSynced(trx, agent.name, environmentId, syncedThrough);
      });
      this.covered.add(keyOf(agent.name, environmentId));
      if (conversations.length) this.pastPending.add(keyOf(agent.name, environmentId));
      return;
    }

    for (const conversation of conversations) {
      const before = counted.get(conversation.id);
      // Unchanged since its steps were last read.
      if (before && conversation.updatedAt <= before.seen_through && sameOwner(before, owners.get(conversation.id)!)) continue;
      await this.countSteps(agent, environmentId, call, conversation, owners.get(conversation.id)!, before).catch((error: unknown) =>
        this.failed(keyOf(agent.name, environmentId), `could not read the steps of ${agent.name}'s conversation ${conversation.id}:`, error),
      );
    }
    await db.transaction().execute((trx) => saveSynced(trx, agent.name, environmentId, syncedThrough));
    this.covered.add(keyOf(agent.name, environmentId));
  }

  /** Counts the conversation's steps completed since it was last counted, each on its day and under its model. */
  private async countSteps(agent: Agent, environmentId: string, call: BridgeCall, conversation: AgentConversation, owner: Owner, before: AgentConversationsTable | undefined): Promise<void> {
    let through = before ? { at: before.counted_through, id: before.counted_step } : { at: 0, id: '' };
    let steps: UsageStep[];
    try {
      steps = (await agent.usage.steps(call, conversation.id, through.at || undefined)).filter((s) => after(s, through)).sort(byTime);
    } catch (error) {
      // Steps it can't list (one too big for the bridge to pass on) are counted from its total, at once, as of its last change.
      if (!conversation.total) throw error;
      this.failed(keyOf(agent.name, environmentId), `could not read the steps of ${agent.name}'s conversation ${conversation.id}, counted from its total:`, error);
      steps = [];
      through = { at: conversation.updatedAt, id: ALL_STEPS };
    }
    const last = steps.at(-1);
    let outside: Tally = new Map();
    const model = last?.model ?? before?.model ?? null;
    // What it used outside its steps (OpenCode's title) is its total beyond all accounted for, filed under its latest model.
    let accounted = { tokens: plus(before ? tokensOfRow(before) : NOTHING, sumOf(steps)), cost: (before?.cost ?? 0) + steps.reduce((sum, s) => sum + s.cost, 0) };
    if (conversation.total) {
      const extra = beyond(conversation.total, accounted);
      outside = tallyOf([{ id: '', at: conversation.updatedAt, ...(model ? { model } : {}), tokens: extra.tokens, cost: extra.cost }]);
      accounted = { tokens: plus(accounted.tokens, extra.tokens), cost: accounted.cost + extra.cost };
    }
    const counts = { model, ...columnsOf(accounted.tokens, accounted.cost) };
    const added = await this.options.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('agent_conversations')
        .values({
          agent: agent.name,
          environment_id: environmentId,
          id: conversation.id,
          owner: owner.owner,
          session_id: owner.sessionId,
          seen_through: conversation.updatedAt,
          counted_through: last?.at ?? through.at,
          counted_step: last?.id ?? through.id,
          backfill_through: before?.backfill_through ?? null,
          past_total: before?.past_total ?? null,
          ...counts,
        })
        .onConflict((oc) =>
          oc.columns(['agent', 'environment_id', 'id']).doUpdateSet({ owner: owner.owner, session_id: owner.sessionId, seen_through: conversation.updatedAt, counted_through: last?.at ?? through.at, counted_step: last?.id ?? through.id, ...counts }),
        )
        .execute();
      const tally = merged(tallyOf(await firstCounted(trx, agent.name, environmentId, steps)), outside);
      return this.record(trx, agent.name, owner, tally);
    });
    if (added && owner.sessionId !== null) this.options.onSessionUsage(owner.sessionId, added.tokens, added.cost);
  }

  /** Records a tally for its owner; resolves with what it added to a Session's own usage, if anything. */
  private async record(trx: Transaction<Schema>, agent: string, owner: Owner, tally: Tally): Promise<{ tokens: TokenCounts; cost: number } | undefined> {
    if (!tally.size) return undefined;
    if (owner.owner === 'outside') {
      for (const entry of tally.values()) await recordOutside(trx, agent, entry.day, entry.model, entry.tokens, entry.cost);
      return undefined;
    }
    const session = owner.sessionId === null ? undefined : this.options.session(owner.sessionId);
    // A Session Loom no longer has uses nothing more: what's left of it was used before it was deleted.
    if (!session) return undefined;
    let tokens = NOTHING;
    let cost = 0;
    for (const entry of tally.values()) {
      const turn = { sessionId: owner.sessionId!, projectId: session.projectId, projectName: session.projectName, model: entry.model, modelName: session.modelName(entry.model), endedAt: noonOf(entry.day), tokens: entry.tokens, cost: entry.cost };
      await recordTurn(trx, turn, owner.owner === 'highlights' ? 'highlight_usage' : 'usage_buckets');
      tokens = plus(tokens, entry.tokens);
      cost += entry.cost;
    }
    return owner.owner === 'session' ? { tokens, cost } : undefined;
  }

  /** Counts, in the background, the steps from before Loom first read the agent's records in the Environment. */
  private backfill(agent: Agent, environmentId: string): void {
    const key = keyOf(agent.name, environmentId);
    if (this.stopped || this.backfills.has(key) || !this.pastPending.has(key)) return;
    const run = this.countPast(agent, environmentId)
      .catch((error: unknown) => this.failed(key, `could not count ${agent.name}'s past usage in Environment ${environmentId}:`, error))
      .finally(() => this.backfills.delete(key));
    this.backfills.set(key, run);
  }

  /**
   * Counts each conversation's past steps, those of one owner together: use
   * outside Loom as it is, except in Loom's own folders; a Session's, only
   * what its runs didn't report (its Subagents, the runs its agent started
   * on its own), as what it used by day and model beyond what Loom recorded
   * then; Session highlights' checks' not at all, as their runs reported it all.
   */
  private async countPast(agent: Agent, environmentId: string): Promise<void> {
    const key = keyOf(agent.name, environmentId);
    const { db } = this.options;
    const rows = await db.selectFrom('agent_conversations').selectAll().where('agent', '=', agent.name).where('environment_id', '=', environmentId).where('backfill_through', 'is not', null).execute();
    const groups = new Map<string, AgentConversationsTable[]>();
    for (const row of rows) {
      const group = row.owner === 'session' ? `session:${row.session_id}` : `${row.owner}:${row.id}`;
      groups.set(group, [...(groups.get(group) ?? []), row]);
    }
    const directories = new Map<string, string | undefined>();
    let listed = false;
    for (const group of groups.values()) {
      if (this.stopped) return;
      const call = this.options.environment(environmentId);
      if (!call) return;
      const owner: Owner = { owner: group[0]!.owner, sessionId: group[0]!.session_id };
      let tally: Tally = new Map();
      const pastSteps: UsageStep[] = [];
      if (owner.owner !== 'highlights') {
        if (owner.owner === 'outside' && !listed) {
          for (const c of await agent.usage.conversations(call)) directories.set(c.id, c.directory);
          listed = true;
        }
        for (const row of group) {
          const directory = directories.get(row.id);
          if (owner.owner === 'outside' && directory !== undefined && this.options.loomFolder(environmentId, directory)) continue;
          let steps: UsageStep[] = [];
          try {
            steps = (await agent.usage.steps(call, row.id)).filter((s) => !after(s, { at: row.backfill_through!, id: ALL_STEPS })).sort(byTime);
          } catch (error) {
            // Steps it can't list (one too big for the bridge to pass on) are counted from its total then, as of its last change then.
            if (!row.past_total) throw error;
            this.failed(key, `could not read the past steps of ${agent.name}'s conversation ${row.id}, counted from its total:`, error);
          }
          pastSteps.push(...steps);
          // What it used outside its steps then, filed with its first step.
          if (row.past_total) {
            const total = JSON.parse(row.past_total) as { tokens: TokenCounts; cost: number };
            const extra = beyond(total, { tokens: sumOf(steps), cost: steps.reduce((sum, s) => sum + s.cost, 0) });
            const first = steps[0];
            tally = merged(tally, tallyOf([{ id: '', at: first?.at ?? row.backfill_through!, ...(first?.model ? { model: first.model } : {}), tokens: extra.tokens, cost: extra.cost }]));
          }
        }
      }
      const added = await db.transaction().execute(async (trx) => {
        tally = merged(tallyOf(await firstCounted(trx, agent.name, environmentId, pastSteps)), tally);
        if (owner.owner === 'session' && owner.sessionId !== null) tally = await beyondRecorded(trx, agent.name, environmentId, owner.sessionId, tally);
        const added = owner.owner === 'highlights' ? undefined : await this.record(trx, agent.name, owner, tally);
        const ids = group.map((r) => r.id);
        for (const batch of batches(ids)) await trx.updateTable('agent_conversations').set({ backfill_through: null, past_total: null }).where('agent', '=', agent.name).where('environment_id', '=', environmentId).where('id', 'in', batch).execute();
        return added;
      });
      if (added && owner.sessionId !== null) this.options.onSessionUsage(owner.sessionId, added.tokens, added.cost);
    }
    this.pastPending.delete(key);
  }

  /** How far Loom has counted each of these conversations, by id. */
  private async countedOf(agent: string, environmentId: string, ids: string[]): Promise<Map<string, AgentConversationsTable>> {
    const found = new Map<string, AgentConversationsTable>();
    for (const batch of batches(ids)) {
      const rows = await this.options.db.selectFrom('agent_conversations').selectAll().where('agent', '=', agent).where('environment_id', '=', environmentId).where('id', 'in', batch).execute();
      for (const row of rows) found.set(row.id, row);
    }
    return found;
  }

  /**
   * Whose each conversation is: as filed already, a Session's or Session
   * highlights'; else a Session's own conversation; else one of a Session's
   * Subagents; else whose the conversation that started it is, followed up
   * the chain; else outside Loom. One filed as outside Loom is looked for
   * again, as Loom may file one before it learns that it is a Session's.
   */
  private async ownersOf(agent: string, environmentId: string, conversations: AgentConversation[]): Promise<Map<string, Owner>> {
    const parents = new Map<string, string | undefined>(conversations.map((c) => [c.id, c.parentId]));
    const known = new Map<string, Owner>();
    let asking = [...parents.keys()];
    for (let depth = 0; asking.length && depth < MAX_DEPTH; depth++) {
      const found = await this.knownOwners(agent, environmentId, asking);
      for (const [id, owner] of found) known.set(id, owner);
      // Next, the conversations that started those still unknown, unless listed (they are asked already).
      asking = [...new Set(asking.filter((id) => !known.has(id)).flatMap((id) => (parents.get(id) && !parents.has(parents.get(id)!) ? [parents.get(id)!] : [])))];
      for (const id of asking) parents.set(id, undefined);
    }
    const ownerOf = (id: string, depth = 0): Owner => {
      const owner = known.get(id);
      if (owner) return owner;
      const parent = parents.get(id);
      return parent && depth < MAX_DEPTH ? ownerOf(parent, depth + 1) : { owner: 'outside', sessionId: null };
    };
    return new Map(conversations.map((c) => [c.id, ownerOf(c.id)]));
  }

  /** The owners Loom knows of these conversations without following any chain. */
  private async knownOwners(agent: string, environmentId: string, ids: string[]): Promise<Map<string, Owner>> {
    const { db } = this.options;
    const known = new Map<string, Owner>();
    for (const batch of batches(ids)) {
      const [filed, sessions, subagents] = await Promise.all([
        db.selectFrom('agent_conversations').select(['id', 'owner', 'session_id']).where('agent', '=', agent).where('environment_id', '=', environmentId).where('id', 'in', batch).execute(),
        db.selectFrom('sessions').select(['id', 'agent_session_id']).where('agent', '=', agent).where('agent_session_id', 'in', batch).execute(),
        db.selectFrom('subagents').innerJoin('sessions', 'sessions.id', 'subagents.session_id').select(['subagents.id', 'subagents.session_id']).where('sessions.agent', '=', agent).where('subagents.id', 'in', batch).execute(),
      ]);
      for (const row of subagents) known.set(row.id, { owner: 'session', sessionId: row.session_id });
      for (const row of sessions) known.set(row.agent_session_id!, { owner: 'session', sessionId: row.id });
      for (const row of filed) if (row.owner !== 'outside') known.set(row.id, { owner: row.owner, sessionId: row.session_id });
    }
    return known;
  }
}

function keyOf(agent: string, environmentId: string): string {
  return `${agent}\0${environmentId}`;
}

function batches<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_BATCH) out.push(items.slice(i, i + ID_BATCH));
  return out;
}

function sameOwner(row: AgentConversationsTable, owner: Owner): boolean {
  return row.owner === owner.owner && row.session_id === owner.sessionId;
}

/** Whether a step comes after the point `through`: completed later, or then with a greater id. */
function after(step: UsageStep, through: { at: number; id: string }): boolean {
  return step.at > through.at || (step.at === through.at && step.id > through.id);
}

function byTime(a: UsageStep, b: UsageStep): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Steps added up by the day they completed and their model. */
function tallyOf(steps: UsageStep[]): Tally {
  const tally: Tally = new Map();
  for (const step of steps) {
    const day = dayOf(step.at);
    const model = step.model ?? 'default';
    const key = `${day}\0${model}`;
    const entry = tally.get(key) ?? { day, model, tokens: NOTHING, cost: 0 };
    tally.set(key, { ...entry, tokens: plus(entry.tokens, step.tokens), cost: entry.cost + step.cost });
  }
  for (const [key, entry] of tally) if (totalTokens(entry.tokens) === 0 && entry.cost === 0) tally.delete(key);
  return tally;
}

function merged(a: Tally, b: Tally): Tally {
  const out: Tally = new Map(a);
  for (const [key, entry] of b) {
    const was = out.get(key);
    out.set(key, was ? { ...was, tokens: plus(was.tokens, entry.tokens), cost: was.cost + entry.cost } : entry);
  }
  return out;
}

/** What a Session's past steps used, by day and model, beyond what Loom had recorded of its runs when it first read the records. */
async function beyondRecorded(trx: Transaction<Schema>, agent: string, environmentId: string, sessionId: number, tally: Tally): Promise<Tally> {
  const rows = await trx.selectFrom('usage_baseline').selectAll().where('agent', '=', agent).where('environment_id', '=', environmentId).where('session_id', '=', sessionId).execute();
  const out: Tally = new Map();
  for (const [key, entry] of tally) {
    const row = rows.find((r) => r.day === entry.day && r.model === entry.model);
    if (!row) {
      out.set(key, entry);
      continue;
    }
    const recorded = { input: row.input_tokens, output: row.output_tokens, reasoning: row.reasoning_tokens, cacheRead: row.cache_read_tokens, cacheWrite: row.cache_write_tokens };
    const tokens = { input: Math.max(0, entry.tokens.input - recorded.input), output: Math.max(0, entry.tokens.output - recorded.output), reasoning: Math.max(0, entry.tokens.reasoning - recorded.reasoning), cacheRead: Math.max(0, entry.tokens.cacheRead - recorded.cacheRead), cacheWrite: Math.max(0, entry.tokens.cacheWrite - recorded.cacheWrite) };
    const cost = Math.max(0, entry.cost - row.cost);
    if (totalTokens(tokens) > 0 || cost > 0) out.set(key, { ...entry, tokens, cost });
  }
  return out;
}

/**
 * The steps not counted yet, which it notes as counted: a forked
 * conversation's copy of a step its parent took (same completion, model and
 * usage) is the same step.
 */
async function firstCounted(trx: Transaction<Schema>, agent: string, environmentId: string, steps: UsageStep[]): Promise<UsageStep[]> {
  const fresh: UsageStep[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const t = step.tokens;
    const print = `${step.at}:${step.model ?? ''}:${t.input}:${t.output}:${t.reasoning}:${t.cacheRead}:${t.cacheWrite}`;
    if (seen.has(print)) continue;
    seen.add(print);
    const { numInsertedOrUpdatedRows } = await trx.insertInto('usage_steps').values({ agent, environment_id: environmentId, print }).onConflict((oc) => oc.doNothing()).executeTakeFirst();
    if ((numInsertedOrUpdatedRows ?? 0n) > 0n) fresh.push(step);
  }
  return fresh;
}

function sumOf(steps: UsageStep[]): TokenCounts {
  return steps.reduce((sum, s) => plus(sum, s.tokens), NOTHING);
}

/** What `total` has beyond `accounted`, kind by kind. */
function beyond(total: { tokens: TokenCounts; cost: number }, accounted: { tokens: TokenCounts; cost: number }): { tokens: TokenCounts; cost: number } {
  const t = total.tokens;
  const a = accounted.tokens;
  return {
    tokens: { input: Math.max(0, t.input - a.input), output: Math.max(0, t.output - a.output), reasoning: Math.max(0, t.reasoning - a.reasoning), cacheRead: Math.max(0, t.cacheRead - a.cacheRead), cacheWrite: Math.max(0, t.cacheWrite - a.cacheWrite) },
    cost: Math.max(0, total.cost - accounted.cost),
  };
}

function tokensOfRow(row: AgentConversationsTable): TokenCounts {
  return { input: row.input_tokens, output: row.output_tokens, reasoning: row.reasoning_tokens, cacheRead: row.cache_read_tokens, cacheWrite: row.cache_write_tokens };
}

function columnsOf(tokens: TokenCounts, cost: number) {
  return { input_tokens: tokens.input, output_tokens: tokens.output, reasoning_tokens: tokens.reasoning, cache_read_tokens: tokens.cacheRead, cache_write_tokens: tokens.cacheWrite, cost };
}

function plus(a: TokenCounts, b: TokenCounts): TokenCounts {
  return { input: a.input + b.input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** Midday of a `YYYY-MM-DD` day, local time: a time recordTurn files under that day. */
function noonOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 12).getTime();
}

async function saveSynced(trx: Transaction<Schema>, agent: string, environmentId: string, syncedThrough: number): Promise<void> {
  await trx
    .insertInto('usage_syncs')
    .values({ agent, environment_id: environmentId, synced_through: syncedThrough })
    .onConflict((oc) => oc.columns(['agent', 'environment_id']).doUpdateSet({ synced_through: syncedThrough }))
    .execute();
}

async function recordOutside(trx: Transaction<Schema>, agent: string, day: string, model: string, tokens: TokenCounts, cost: number): Promise<void> {
  await trx
    .insertInto('outside_usage')
    .values({ agent, day, model, input_tokens: tokens.input, output_tokens: tokens.output, reasoning_tokens: tokens.reasoning, cache_read_tokens: tokens.cacheRead, cache_write_tokens: tokens.cacheWrite, cost })
    .onConflict((oc) =>
      oc.columns(['agent', 'day', 'model']).doUpdateSet((eb) => {
        const column = (name: 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'reasoning_tokens' | 'cost') => eb(`outside_usage.${name}`, '+', eb.ref(`excluded.${name}`));
        return { input_tokens: column('input_tokens'), output_tokens: column('output_tokens'), cache_read_tokens: column('cache_read_tokens'), cache_write_tokens: column('cache_write_tokens'), reasoning_tokens: column('reasoning_tokens'), cost: column('cost') };
      }),
    )
    .execute();
}
