// The Highlights service (ADR 0010): after each turn of a Session, while
// Session highlights is on, a model of the user's picking reads the turns
// since the last check and notes what the user should know, or resolves what
// a turn settled. It runs as a second agent conversation in the Session's
// Environment, with every tool refused, started for the check and closed
// after it. Checks never hold up the Session; one that fails leaves its turns
// for the next. The checks' usage counts on the dashboard, but isn't the
// Session's own.
import { DEFAULT_APPROVALS, type Highlight, type HighlightCounts, type HighlightsSettings, type Session, type SessionHighlights, type TokenCounts, type TranscriptItem } from '../../shared/api';
import type { AgentAdapter, AgentEnvironment, AgentEvent, AgentSession } from '../agents/adapter';
import type { Clock, TimerHandle } from '../clock';
import type { BridgeCall } from '../environments/exec';
import type { LoomDatabase } from '../storage/database';
import type { HighlightsTable } from '../storage/schema';
import { Topic } from '../topic';
import { recordTurn } from '../usage/usage';
import { checkPrompt, readAnswer, turnsOf } from './highlight-check';

/** How long a check's model may take to answer before the check fails. */
export const CHECK_TIMEOUT_MS = 5 * 60_000;

/** How long writing the checks' folder into the Environment may take. */
const WRITE_TIMEOUT_MS = 30_000;

/** Where a check's agent runs: the Session's Environment. */
export interface HighlightsEnvironment extends AgentEnvironment {
  ready(): Promise<void>;
  /** Its temp directory, where the checks' own folder is made: away from the working copy and its instructions. */
  tempDir(): string;
  /** Its bridge, which makes that folder. */
  request: BridgeCall;
}

export interface HighlightsOptions {
  db: LoomDatabase;
  clock: Clock;
  adapter: AgentAdapter;
  /** The Session highlights setting, as it is now. */
  settings: () => HighlightsSettings;
  session: (id: number) => Session | undefined;
  /** Every Session Loom has. */
  sessions: () => Session[];
  environment: (session: Session) => HighlightsEnvironment | undefined;
  transcript: (id: number) => Promise<TranscriptItem[]>;
  /** The Project's name, for the usage the checks record. */
  projectName: (projectId: number) => string;
  /** The Session's Highlights, counted; undefined while its Panel means nothing. */
  onCounts: (id: number, counts: HighlightCounts | undefined) => void;
}

/** What the service holds of one Session. */
interface State {
  highlights: Highlight[];
  /** The last transcript item checked, or left unchecked while Session highlights was off; undefined before its first turn ended. */
  checkedThrough?: number;
  seenThrough: number;
  error?: string;
  /** The item the latest turn to end ran through, while a check is to cover it. */
  dueThrough?: number;
  checking: boolean;
}

export class Highlights {
  private readonly states = new Map<number, State>();
  private readonly topics = new Map<number, Topic<SessionHighlights>>();
  /** Checks running, so that shutting down can wait for their agents to close. */
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  private constructor(private readonly options: HighlightsOptions) {}

  /** Reads every Session's Highlights, and how far its turns were checked. */
  static async load(options: HighlightsOptions): Promise<Highlights> {
    const service = new Highlights(options);
    const [rows, checks] = await Promise.all([
      options.db.selectFrom('highlights').selectAll().orderBy('id').execute(),
      options.db.selectFrom('highlight_checks').selectAll().execute(),
    ]);
    for (const check of checks) {
      service.states.set(check.session_id, {
        highlights: [],
        checkedThrough: check.checked_through,
        seenThrough: check.seen_through,
        ...(check.error ? { error: check.error } : {}),
        checking: false,
      });
    }
    for (const row of rows) service.state(row.session_id).highlights.push(highlightOf(row));
    service.countAll();
    return service;
  }

  /** The Session's Highlights now, then as they change. */
  subscribe(id: number, listener: (value: SessionHighlights) => void): () => void {
    this.sessionOf(id);
    let topic = this.topics.get(id);
    if (!topic) this.topics.set(id, (topic = new Topic(this.view(id))));
    return topic.subscribe(listener);
  }

  /**
   * A turn of the Session ended, its transcript running through `through`:
   * checked, while Session highlights is on, with the turns before it a
   * failed check left; otherwise passed over, so that turning it on later
   * starts from the next turn.
   */
  turnEnded(id: number, through: number): void {
    if (this.stopped) return;
    const session = this.options.session(id);
    if (!session || session.status === 'archived') return;
    const state = this.state(id);
    if (!this.options.settings().on) {
      // Passed over, even with a check still running: turning it on again starts from the next turn.
      delete state.dueThrough;
      state.checkedThrough = Math.max(state.checkedThrough ?? -1, through);
      if (!state.checking) void this.saveCheck(id);
      return;
    }
    state.dueThrough = through;
    if (!state.checking) this.track(this.check(id));
  }

  /** The setting changed: what each Session's Panel means changes with it. */
  settingsChanged(): void {
    this.countAll();
  }

  /** The Sessions Loom has now: a deleted one's Highlights are gone with it. */
  sessionsChanged(sessions: Session[]): void {
    const ids = new Set(sessions.map((s) => s.id));
    for (const id of [...this.states.keys()]) {
      if (ids.has(id)) continue;
      this.states.delete(id);
      this.topics.delete(id);
    }
  }

  /** Resolves a Highlight by hand, or reopens it. */
  async resolve({ id, highlightId, resolved }: { id: number; highlightId: number; resolved: boolean }): Promise<void> {
    this.sessionOf(id);
    const state = this.state(id);
    const at = state.highlights.findIndex((h) => h.id === highlightId);
    if (at < 0) throw new Error(`Session ${id} has no Highlight ${highlightId}.`);
    const resolution = resolved ? { by: 'user' as const, at: this.options.clock.now() } : undefined;
    await this.options.db
      .updateTable('highlights')
      .set({ resolved_by: resolution?.by ?? null, resolved_reason: null, resolved_item_id: null, resolved_at: resolution?.at ?? null })
      .where('id', '=', highlightId)
      .execute();
    const { resolved: _was, ...open } = state.highlights[at]!;
    state.highlights = state.highlights.map((h, i) => (i === at ? (resolution ? { ...open, resolved: resolution } : open) : h));
    this.publish(id);
  }

  /** The user has looked at the Session's Highlights: those so far are seen. */
  async see({ id }: { id: number }): Promise<void> {
    this.sessionOf(id);
    const state = this.state(id);
    const last = state.highlights.at(-1)?.id ?? 0;
    if (last <= state.seenThrough) return;
    state.seenThrough = last;
    await this.saveCheck(id);
    this.publish(id);
  }

  /** Stops checking: the checks going on are left to end, their agents closed. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.running]);
  }

  /** Checks the Session's turns since the last check, again while more turns end meanwhile. */
  private async check(id: number): Promise<void> {
    const state = this.state(id);
    state.checking = true;
    this.publish(id);
    try {
      while (!this.stopped && state.dueThrough !== undefined && state.dueThrough > (state.checkedThrough ?? -1)) {
        const through = state.dueThrough;
        const session = this.options.session(id);
        if (!session || session.status === 'archived' || !this.options.settings().on) break;
        try {
          await this.checkThrough(session, through);
          // Never back: turns passed over meanwhile (the setting turned off) stay passed over.
          state.checkedThrough = Math.max(state.checkedThrough ?? -1, through);
          delete state.error;
        } catch (error) {
          state.error = (error as Error).message;
          // Its turns wait for the next turn's check.
          break;
        } finally {
          if (this.states.has(id)) await this.saveCheck(id);
          this.publish(id);
        }
      }
    } finally {
      state.checking = false;
      if (this.states.has(id)) this.publish(id);
    }
  }

  /** One check: the model reads the turns after the last one checked, through `through`, and its answer is recorded. */
  private async checkThrough(session: Session, through: number): Promise<void> {
    const state = this.state(session.id);
    const items = (await this.options.transcript(session.id)).filter((item) => item.id <= through);
    // Nothing checked yet: the first turn checked is the one that just ended, even for a Session older than the setting.
    // Kept from the first check on, so that one that fails leaves this turn for the next.
    const after = (state.checkedThrough ??= (items.findLast((item) => item.kind === 'user')?.id ?? 0) - 1);
    const turns = turnsOf(items, after);
    if (!turns.length) return;
    const open = state.highlights.filter((h) => !h.resolved);
    const { model, effort } = this.options.settings();
    const reply = await this.ask(session, checkPrompt(open, turns), { model, effort });
    let answer;
    try {
      answer = readAnswer(reply, { open: new Set(open.map((h) => h.id)), turns: turns.map((t) => t.itemId) });
    } catch (error) {
      throw new Error(`Session highlights' model didn't answer as asked: ${(error as Error).message}`);
    }
    if (!this.states.has(session.id)) return;
    const now = this.options.clock.now();
    await this.options.db.transaction().execute(async (trx) => {
      for (const { kind, text, turn } of answer.add) {
        const row = { session_id: session.id, kind, text, item_id: turn, created_at: now, resolved_by: null, resolved_reason: null, resolved_item_id: null, resolved_at: null };
        const { id } = await trx.insertInto('highlights').values(row).returning('id').executeTakeFirstOrThrow();
        state.highlights.push(highlightOf({ ...row, id }));
      }
      for (const { id, reason, turn } of answer.resolve) {
        const at = state.highlights.findIndex((h) => h.id === id);
        // The user may have resolved it meanwhile: theirs stands.
        if (at < 0 || state.highlights[at]!.resolved) continue;
        await trx.updateTable('highlights').set({ resolved_by: 'model', resolved_reason: reason || null, resolved_item_id: turn, resolved_at: now }).where('id', '=', id).execute();
        state.highlights[at] = { ...state.highlights[at]!, resolved: { by: 'model', ...(reason ? { reason } : {}), itemId: turn, at } };
      }
    });
  }

  /**
   * Asks the model `prompt` in a new conversation of its own in the
   * Session's Environment, every tool refused, and resolves with its answer.
   * What it uses is recorded as Session highlights' usage, however the check ends.
   */
  private async ask(session: Session, prompt: string, pick: { model?: string; effort?: string }): Promise<string> {
    const environment = this.options.environment(session);
    if (!environment) throw new Error(`Loom has no Environment for Session ${session.id}.`);
    await environment.ready();
    let reply = '';
    let settle: (outcome: { error?: string }) => void = () => {};
    const done = new Promise<{ error?: string }>((resolve) => (settle = resolve));
    let tokens: TokenCounts | undefined;
    let cost = 0;
    let agent: AgentSession | undefined;
    const onEvent = (event: AgentEvent) => {
      switch (event.type) {
        case 'text-delta':
          reply += event.text;
          return;
        case 'turn-usage':
          tokens = event.tokens;
          return;
        case 'usage':
          // A new conversation's cost so far is this check's.
          if (event.cost !== undefined) cost = event.cost;
          return;
        // The check's agent may only answer: whatever it asks is turned down.
        case 'approval-asked':
          return agent?.answer(event.requestId, { kind: 'approval', approved: false });
        case 'question-asked':
          return agent?.answer(event.requestId, { kind: 'question', answer: null });
        case 'trust-asked':
          return agent?.answer(event.requestId, { kind: 'trust', trusted: false });
        case 'run-settled':
          return settle({});
        case 'run-failed':
          return settle({ error: event.error });
        case 'closed':
          return settle({ error: event.error ?? `${this.options.adapter.name} stopped` });
      }
    };
    const tempDir = environment.tempDir();
    // A folder of the checks' own, made by writing a file in it: the temp directory itself may not be there yet (native Windows).
    const folder = `${tempDir}/loom-highlights`;
    const readme = "Session highlights' checks run here, with every tool refused.\n";
    await environment.request('files.write', WRITE_TIMEOUT_MS, { path: `${folder}/README.md`, data: Buffer.from(readme, 'utf8').toString('base64') });
    // `toolsOff` stands in for any approval policy; the adapter still takes one.
    agent = await this.options.adapter.open({ environment, workingCopy: folder, tempDir, approvals: DEFAULT_APPROVALS, toolsOff: true, onEvent });
    let timer: TimerHandle | undefined;
    try {
      await agent.configure(pick);
      timer = this.options.clock.setTimeout(() => {
        agent!.cancel();
        settle({ error: `It didn't answer within ${CHECK_TIMEOUT_MS / 60_000} minutes.` });
      }, CHECK_TIMEOUT_MS);
      agent.prompt({ text: prompt, files: [] });
      const outcome = await done;
      if (outcome.error) throw new Error(outcome.error);
      return reply;
    } finally {
      if (timer !== undefined) this.options.clock.clearTimeout(timer);
      await agent.close().catch(() => {});
      if (tokens || cost > 0) await this.recordUsage(session, pick.model ?? 'default', tokens, cost);
    }
  }

  private async recordUsage(session: Session, model: string, tokens: TokenCounts | undefined, cost: number): Promise<void> {
    const turn = {
      sessionId: session.id,
      projectId: session.projectId,
      projectName: this.options.projectName(session.projectId),
      model,
      // The check's agent offers what the Session's does.
      modelName: session.agentConfig?.models.find((m) => m.id === model)?.name,
      endedAt: this.options.clock.now(),
      tokens: tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost,
    };
    await this.options.db
      .transaction()
      .execute((trx) => recordTurn(trx, turn, 'highlight_usage'))
      .catch((error: unknown) => console.error(`could not record Session ${session.id}'s highlights usage:`, error));
  }

  private track(check: Promise<void>): void {
    const tracked = check.catch((error: unknown) => console.error('Session highlights check failed:', error));
    this.running.add(tracked);
    void tracked.finally(() => this.running.delete(tracked));
  }

  private async saveCheck(id: number): Promise<void> {
    const state = this.state(id);
    const row = { session_id: id, checked_through: state.checkedThrough ?? -1, seen_through: state.seenThrough, error: state.error ?? null };
    await this.options.db
      .insertInto('highlight_checks')
      .values(row)
      .onConflict((c) => c.column('session_id').doUpdateSet({ checked_through: row.checked_through, seen_through: row.seen_through, error: row.error }))
      .execute()
      // A Session deleted meanwhile has no row to keep this for.
      .catch((error: unknown) => {
        if (this.options.session(id)) console.error(`could not save Session ${id}'s highlights:`, error);
      });
  }

  private state(id: number): State {
    let state = this.states.get(id);
    if (!state) this.states.set(id, (state = { highlights: [], seenThrough: 0, checking: false }));
    return state;
  }

  private view(id: number): SessionHighlights {
    const { highlights, seenThrough, checking, error } = this.state(id);
    return { highlights, seenThrough, checking, ...(error ? { error } : {}) };
  }

  private publish(id: number): void {
    this.topics.get(id)?.set(this.view(id));
    this.count(id);
  }

  private count(id: number): void {
    const state = this.states.get(id);
    const count = state?.highlights.length ?? 0;
    const unseen = state?.highlights.filter((h) => h.id > state.seenThrough).length ?? 0;
    this.options.onCounts(id, this.options.settings().on || count > 0 ? { count, unseen } : undefined);
  }

  private countAll(): void {
    for (const session of this.options.sessions()) this.count(session.id);
  }

  private sessionOf(id: number): Session {
    const session = this.options.session(id);
    if (!session) throw new Error(`unknown Session ${id}`);
    return session;
  }
}

function highlightOf(row: Omit<HighlightsTable, 'id'> & { id: number }): Highlight {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    itemId: row.item_id,
    createdAt: row.created_at,
    ...(row.resolved_at !== null && row.resolved_by !== null
      ? { resolved: { by: row.resolved_by, ...(row.resolved_reason ? { reason: row.resolved_reason } : {}), ...(row.resolved_item_id !== null ? { itemId: row.resolved_item_id } : {}), at: row.resolved_at } }
      : {}),
  };
}
