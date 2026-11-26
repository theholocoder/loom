// A Session's Subagents (CONTEXT.md): what the Session service keeps of each
// one, and its transcript, built from the agent's reports as the Session's own
// is, but readonly: a Subagent asks nothing of the user in it. Both are kept in
// the database with the Session, and go with it.
import type { Transaction } from 'kysely';
import type { PlanEntry, Subagent, TranscriptItem } from '../../shared/api';
import type { SubagentEvent, SubagentReport } from '../agents/adapter';
import type { Clock, TimerHandle } from '../clock';
import type { LoomDatabase } from '../storage/database';
import type { Schema, SubagentEventsTable, SubagentsTable } from '../storage/schema';
import { Topic } from '../topic';
import { capToolDiffs, capToolOutput } from './tool-output';

type Write = (trx: Transaction<Schema>) => Promise<unknown>;
type NewItem = TranscriptItem extends infer I ? (I extends TranscriptItem ? Omit<I, 'id'> : never) : never;

export interface SubagentsOptions {
  db: LoomDatabase;
  clock: Clock;
  /** Queues a write, committed with the Session service's own. */
  write: (write: Write) => void;
  /** How often streaming text is written. */
  checkpointMs: number;
}

/** One Subagent's transcript while Loom holds it: read from the database, or new. */
interface Held {
  topic: Topic<TranscriptItem[]>;
  /** Its plan card's place, once it has one. */
  plan?: number;
  checkpoint?: TimerHandle;
}

export class Subagents {
  /** Every Session's Subagents, read at start, in the order they started. */
  private readonly lists = new Map<number, Topic<Subagent[]>>();
  /** Transcripts held, by `key`. */
  private readonly held = new Map<string, Held>();
  /** Transcripts being read, with what the agent reported meanwhile, applied once read. */
  private readonly reading = new Map<string, { read: Promise<Held>; later: Array<(held: Held) => void> }>();

  constructor(private readonly options: SubagentsOptions) {}

  /**
   * Reads every Session's Subagents. One left running when the Client last
   * stopped went with its agent's process: it is interrupted, ending now.
   */
  async load(): Promise<void> {
    const now = this.options.clock.now();
    await this.options.db.updateTable('subagents').set({ status: 'interrupted', ended_at: now }).where('status', '=', 'running').execute();
    const rows = await this.options.db.selectFrom('subagents').selectAll().orderBy('started_at').execute();
    for (const row of rows) this.listTopic(row.session_id).set([...this.listOf(row.session_id), fromRow(row)]);
  }

  listOf(sessionId: number): Subagent[] {
    return this.lists.get(sessionId)?.value ?? [];
  }

  /** How many of the Session's Subagents are running. */
  running(sessionId: number): number {
    return this.listOf(sessionId).filter((s) => s.status === 'running').length;
  }

  find(sessionId: number, subagentId: string): Subagent | undefined {
    return this.listOf(sessionId).find((s) => s.id === subagentId);
  }

  subscribeList(sessionId: number, listener: (list: Subagent[]) => void): () => void {
    return this.listTopic(sessionId).subscribe(listener);
  }

  /** Calls `listener` with the Subagent's transcript, read from the database, then as it changes: empty until the agent reports it. */
  subscribeTranscript(sessionId: number, subagentId: string, listener: (items: TranscriptItem[]) => void): () => void {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    this.withTranscript(sessionId, subagentId, (held) => {
      if (!cancelled) unsubscribe = held.topic.subscribe(listener);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }

  /**
   * Records what the agent reported of a Subagent: a new one, or what
   * changed of it. One that ends has its streaming text finished and its
   * tool calls still running failed. Returns whether anything changed.
   */
  report(sessionId: number, report: SubagentReport): boolean {
    const now = this.options.clock.now();
    const list = this.listOf(sessionId);
    const was = list.find((s) => s.id === report.subagentId);
    const restarted = was !== undefined && was.status !== 'running' && report.status === 'running';
    const ended = report.status !== 'running';
    const subagent: Subagent = withoutUndefined({
      id: report.subagentId,
      parentId: report.parentId ?? was?.parentId,
      depth: report.depth,
      toolCallId: report.toolCallId ?? was?.toolCallId,
      agent: report.agent ?? was?.agent,
      description: report.description ?? was?.description ?? 'Subagent',
      model: report.model ?? was?.model,
      status: report.status,
      error: report.error,
      startedAt: was && !restarted ? was.startedAt : now,
      endedAt: !ended ? undefined : was?.status === report.status ? was.endedAt : now,
    });
    if (was && same(was, subagent)) return false;
    // A new one has no transcript yet to read.
    if (!was && !this.held.has(key(sessionId, subagent.id)) && !this.reading.has(key(sessionId, subagent.id))) this.held.set(key(sessionId, subagent.id), { topic: new Topic<TranscriptItem[]>([]) });
    this.listTopic(sessionId).set(was ? list.map((s) => (s === was ? subagent : s)) : [...list, subagent]);
    const row = toRow(sessionId, subagent);
    this.options.write((trx) =>
      trx
        .insertInto('subagents')
        .values(row)
        .onConflict((oc) => oc.columns(['session_id', 'id']).doUpdateSet({ ...row }))
        .execute(),
    );
    if (ended) this.withTranscript(sessionId, subagent.id, (held) => this.endTranscript(sessionId, subagent.id, held));
    return true;
  }

  /** Records what a Subagent did in its transcript. */
  event(sessionId: number, subagentId: string, event: SubagentEvent): void {
    if (!this.find(sessionId, subagentId)) return;
    this.withTranscript(sessionId, subagentId, (held) => {
      switch (event.type) {
        case 'text-delta':
          return this.appendText(sessionId, subagentId, held, 'agent', event.text);
        case 'thinking-delta':
          return this.appendText(sessionId, subagentId, held, 'thinking', event.text);
        case 'plan':
          return this.recordPlan(sessionId, subagentId, held, event.entries);
        case 'tool-started':
        case 'tool-updated':
          return this.recordTool(sessionId, subagentId, held, event);
      }
    });
  }

  /** Ends every running Subagent of the Session, as its agent's process ended: interrupted. Returns whether any was. */
  endAll(sessionId: number): boolean {
    let any = false;
    for (const subagent of this.listOf(sessionId)) {
      if (subagent.status !== 'running') continue;
      any = this.report(sessionId, { ...reportOf(subagent), status: 'interrupted' }) || any;
    }
    return any;
  }

  /** Writes every streaming text as it is now, as the Client stops. */
  checkpointAll(): void {
    for (const [key, held] of this.held) {
      const [sessionId, subagentId] = parseKey(key);
      this.checkpoint(sessionId, subagentId, held);
    }
  }

  /** Forgets a deleted Session's Subagents; their rows go with the Session's. */
  forget(sessionId: number): void {
    this.lists.delete(sessionId);
    for (const key of [...this.reading.keys()]) if (parseKey(key)[0] === sessionId) this.reading.delete(key);
    for (const [key, held] of [...this.held]) {
      if (parseKey(key)[0] !== sessionId) continue;
      if (held.checkpoint !== undefined) this.options.clock.clearTimeout(held.checkpoint);
      this.held.delete(key);
    }
  }

  private listTopic(sessionId: number): Topic<Subagent[]> {
    let topic = this.lists.get(sessionId);
    if (!topic) this.lists.set(sessionId, (topic = new Topic<Subagent[]>([])));
    return topic;
  }

  /** Runs `then` with the Subagent's transcript: at once when held, else once read, in the order asked. */
  private withTranscript(sessionId: number, subagentId: string, then: (held: Held) => void): void {
    const id = key(sessionId, subagentId);
    const held = this.held.get(id);
    if (held) return then(held);
    const reading = this.reading.get(id);
    if (reading) return void reading.later.push(then);
    const later = [then];
    const read = this.options.db
      .selectFrom('subagent_events')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('subagent_id', '=', subagentId)
      .orderBy('seq')
      .execute()
      .then((rows) => {
        const items = rows.map(itemOf);
        const plan = items.findLastIndex((i) => i.kind === 'plan');
        const loaded: Held = { topic: new Topic(items), ...(plan >= 0 ? { plan } : {}) };
        this.held.set(id, loaded);
        this.reading.delete(id);
        for (const next of later) next(loaded);
        return loaded;
      });
    read.catch((error: unknown) => {
      this.reading.delete(id);
      console.error(`could not read a Subagent's transcript of Session ${sessionId}:`, error);
    });
    this.reading.set(id, { read, later });
  }

  private appendText(sessionId: number, subagentId: string, held: Held, kind: 'agent' | 'thinking', text: string): void {
    const items = held.topic.value;
    const last = items.at(-1);
    if (last?.kind === kind && last.streaming) {
      held.topic.set([...items.slice(0, -1), { ...last, text: last.text + text }]);
      if (held.checkpoint === undefined) held.checkpoint = this.options.clock.setTimeout(() => this.checkpoint(sessionId, subagentId, held), this.options.checkpointMs);
      return;
    }
    this.endStreaming(sessionId, subagentId, held);
    this.addItem(sessionId, subagentId, held, { kind, text, streaming: true });
  }

  private recordPlan(sessionId: number, subagentId: string, held: Held, entries: PlanEntry[]): void {
    if (held.plan !== undefined) return this.replaceItem(sessionId, subagentId, held, { kind: 'plan', id: held.plan, entries });
    if (entries.length === 0) return;
    this.endStreaming(sessionId, subagentId, held);
    held.plan = held.topic.value.length;
    this.addItem(sessionId, subagentId, held, { kind: 'plan', entries });
  }

  private recordTool(sessionId: number, subagentId: string, held: Held, { type: _type, scriptCalls: _scriptCalls, ...call }: Extract<SubagentEvent, { type: 'tool-started' | 'tool-updated' }>): void {
    const input = call.input === undefined ? undefined : capToolOutput(call.input);
    const output = call.output === undefined ? undefined : capToolOutput(call.output);
    const diffs = call.diffs === undefined ? undefined : capToolDiffs(call.diffs);
    const changes = withoutUndefined({ ...call, input: input?.text, output: output?.text, diffs: diffs?.diffs });
    const items = held.topic.value;
    const card = items.findLast((i) => i.kind === 'tool' && i.toolCallId === call.toolCallId);
    const truncated = (card?.kind === 'tool' && card.truncated) || input?.truncated || output?.truncated || diffs?.truncated;
    if (card?.kind !== 'tool') {
      this.endStreaming(sessionId, subagentId, held);
      return this.addItem(sessionId, subagentId, held, { kind: 'tool', title: 'Tool call', status: 'running', ...changes, ...(truncated ? { truncated } : {}) });
    }
    this.replaceItem(sessionId, subagentId, held, { ...card, ...changes, ...(truncated ? { truncated } : {}) });
  }

  /** Finishes what the Subagent left going as it ended: its streaming text, and its tool calls still running, which failed. */
  private endTranscript(sessionId: number, subagentId: string, held: Held): void {
    this.endStreaming(sessionId, subagentId, held);
    for (const item of held.topic.value) if (item.kind === 'tool' && item.status === 'running') this.replaceItem(sessionId, subagentId, held, { ...item, status: 'failed' });
  }

  private checkpoint(sessionId: number, subagentId: string, held: Held): void {
    if (held.checkpoint !== undefined) this.options.clock.clearTimeout(held.checkpoint);
    held.checkpoint = undefined;
    const last = held.topic.value.at(-1);
    if ((last?.kind === 'agent' || last?.kind === 'thinking') && last.streaming) this.writeItem(sessionId, subagentId, last);
  }

  private endStreaming(sessionId: number, subagentId: string, held: Held): void {
    const items = held.topic.value;
    const last = items.at(-1);
    if (!((last?.kind === 'agent' || last?.kind === 'thinking') && last.streaming)) return;
    if (held.checkpoint !== undefined) this.options.clock.clearTimeout(held.checkpoint);
    held.checkpoint = undefined;
    const ended = { ...last, streaming: false };
    held.topic.set([...items.slice(0, -1), ended]);
    this.writeItem(sessionId, subagentId, ended);
  }

  private addItem(sessionId: number, subagentId: string, held: Held, item: NewItem): void {
    const items = held.topic.value;
    const added = { ...item, id: items.length } as TranscriptItem;
    held.topic.set([...items, added]);
    this.writeItem(sessionId, subagentId, added);
  }

  private replaceItem(sessionId: number, subagentId: string, held: Held, item: TranscriptItem): void {
    held.topic.set(held.topic.value.map((i) => (i.id === item.id ? item : i)));
    this.writeItem(sessionId, subagentId, item);
  }

  private writeItem(sessionId: number, subagentId: string, { id: seq, kind, ...data }: TranscriptItem): void {
    if (!this.lists.has(sessionId)) return;
    const row: SubagentEventsTable = { session_id: sessionId, subagent_id: subagentId, seq, kind, data: JSON.stringify(data) };
    this.options.write((trx) =>
      trx
        .insertInto('subagent_events')
        .values(row)
        .onConflict((oc) => oc.columns(['session_id', 'subagent_id', 'seq']).doUpdateSet({ kind: row.kind, data: row.data }))
        .execute(),
    );
  }
}

const key = (sessionId: number, subagentId: string) => `${sessionId}:${subagentId}`;
function parseKey(held: string): [number, string] {
  const at = held.indexOf(':');
  return [Number(held.slice(0, at)), held.slice(at + 1)];
}

function reportOf({ id, parentId, depth, status, description, toolCallId, agent, model, error }: Subagent): SubagentReport {
  return withoutUndefined({ subagentId: id, parentId, depth, status, description, toolCallId, agent, model, error });
}

function fromRow(row: SubagentsTable): Subagent {
  return withoutUndefined({
    id: row.id,
    parentId: row.parent_id ?? undefined,
    depth: row.depth,
    toolCallId: row.tool_call_id ?? undefined,
    agent: row.agent ?? undefined,
    description: row.description,
    model: row.model ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
  });
}

function toRow(sessionId: number, s: Subagent): SubagentsTable {
  return {
    session_id: sessionId,
    id: s.id,
    parent_id: s.parentId ?? null,
    depth: s.depth,
    tool_call_id: s.toolCallId ?? null,
    agent: s.agent ?? null,
    description: s.description,
    model: s.model ?? null,
    status: s.status,
    error: s.error ?? null,
    started_at: s.startedAt,
    ended_at: s.endedAt ?? null,
  };
}

function itemOf(row: SubagentEventsTable): TranscriptItem {
  return { ...(JSON.parse(row.data) as object), kind: row.kind, id: row.seq } as TranscriptItem;
}

function same(a: Subagent, b: Subagent): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
