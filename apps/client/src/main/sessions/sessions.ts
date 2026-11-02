// The Session service: every Session, its status, and its conversation with
// its agent. Adapters report facts (a run started, text arrived, the run
// settled or failed); this service derives each Session's status from them.
import type { Project, Session, SessionStatus, TranscriptItem, WaitingReason } from '../../shared/api';
import type { AgentAdapter, AgentEnvironment, AgentEvent, AgentSession } from '../agents/adapter';
import type { Clock } from '../clock';
import type { LoomDatabase } from '../storage/database';
import type { SessionsTable } from '../storage/schema';
import { Topic } from '../topic';

export interface SessionsOptions {
  db: LoomDatabase;
  clock: Clock;
  adapter: AgentAdapter;
  project: (id: number) => Project | undefined;
  /** The Environment with this id, if Loom knows it. */
  environment: (id: string) => AgentEnvironment | undefined;
  onChange: (sessions: Session[]) => void;
}

const MAX_TITLE_LENGTH = 80;

type StatusChange = { status: SessionStatus; waitingReason?: WaitingReason; error?: string };

export class Sessions {
  private sessions = new Map<number, Session>();
  /** Conversations, kept while the Client runs. */
  private transcripts = new Map<number, Topic<TranscriptItem[]>>();
  /** The agent conversation of each Session whose agent process is running. */
  private live = new Map<number, AgentSession>();
  private nextItemId = 1;
  /** Writes of status changes, one after another so they land in order. */
  private saving: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  private constructor(private readonly options: SessionsOptions) {}

  /**
   * The Session service, with the Sessions in the database. A Session that
   * was Working when the Client last stopped has lost its run: it is Waiting
   * as interrupted.
   */
  static async load(options: SessionsOptions): Promise<Sessions> {
    const sessions = new Sessions(options);
    const rows = await options.db.selectFrom('sessions').selectAll().execute();
    for (const row of rows) sessions.sessions.set(row.id, fromRow(row));
    for (const session of sessions.list()) {
      if (session.status === 'working') sessions.setStatus(session.id, { status: 'waiting', waitingReason: 'interrupted' });
    }
    await sessions.saving;
    return sessions;
  }

  /** Newest first. */
  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  }

  async create({ projectId, workingCopy, prompt }: { projectId: number; workingCopy: 'checkout'; prompt: string }): Promise<Session> {
    const project = this.options.project(projectId);
    if (!project) throw new Error(`unknown Project ${projectId}`);
    if (workingCopy !== 'checkout') throw new Error(`unsupported working copy "${workingCopy as string}"`);
    const text = promptText(prompt);
    const now = this.options.clock.now();
    const values = {
      project_id: projectId,
      title: titleOf(text),
      working_copy_kind: 'checkout' as const,
      working_copy_path: project.checkout.path,
      agent: this.options.adapter.name,
      agent_session_id: null,
      status: 'working' as const,
      waiting_reason: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    const { id } = await this.options.db.insertInto('sessions').values(values).returning('id').executeTakeFirstOrThrow();
    this.sessions.set(id, fromRow({ id, ...values }));
    this.addItem(id, { kind: 'user', id: this.nextItemId++, text });
    this.publish();
    void this.run(id, text);
    return this.sessions.get(id)!;
  }

  async send({ id, prompt }: { id: number; prompt: string }): Promise<void> {
    const session = this.get(id);
    const text = promptText(prompt);
    if (session.status === 'working') throw new Error('The agent is still working on this Session.');
    if (session.status === 'archived') throw new Error('This Session is archived.');
    if (!this.live.has(id) && session.agentSessionId) {
      throw new Error("This Session's agent has stopped, and Loom can't resume it yet.");
    }
    this.addItem(id, { kind: 'user', id: this.nextItemId++, text });
    this.setStatus(id, { status: 'working' });
    void this.run(id, text);
  }

  /** Calls `listener` with the Session's conversation now and as it changes. */
  subscribeTranscript(id: number, listener: (items: TranscriptItem[]) => void): () => void {
    this.get(id);
    return this.transcript(id).subscribe(listener);
  }

  /**
   * Stops reacting to agents, whose processes end with their Environment,
   * and waits for status changes to be written.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.saving;
  }

  private async run(id: number, text: string): Promise<void> {
    let agent = this.live.get(id);
    if (!agent) {
      try {
        agent = await this.open(id);
      } catch (error) {
        this.fail(id, (error as Error).message);
        return;
      }
    }
    agent.prompt(text);
  }

  /** Starts the Session's agent in its working copy and records the agent's id for it. */
  private async open(id: number): Promise<AgentSession> {
    const session = this.get(id);
    const project = this.options.project(session.projectId);
    const environmentId = project?.checkout.environmentId;
    const environment = environmentId === undefined ? undefined : this.options.environment(environmentId);
    if (!environment) throw new Error(`unknown Environment "${environmentId}"`);
    const agent = await this.options.adapter.open({
      environment,
      workingCopy: session.workingCopy.path,
      onEvent: (event) => this.onAgentEvent(id, event),
    });
    this.live.set(id, agent);
    this.update(id, { agentSessionId: agent.id });
    this.save(id, { agent_session_id: agent.id });
    return agent;
  }

  private onAgentEvent(id: number, event: AgentEvent): void {
    if (this.shuttingDown) return;
    switch (event.type) {
      case 'run-started':
        return;
      case 'text-delta':
        return this.appendAgentText(id, event.text);
      case 'run-settled':
        this.endAgentText(id);
        return this.setStatus(id, { status: 'waiting', waitingReason: 'finished' });
      case 'run-failed':
        return this.fail(id, event.error);
      case 'closed':
        this.live.delete(id);
        return this.fail(id, event.error ?? `${this.options.adapter.name} stopped`);
    }
  }

  /** Puts a Working Session in Waiting (error), showing why in its conversation. */
  private fail(id: number, error: string): void {
    if (this.get(id).status !== 'working') return;
    this.endAgentText(id);
    this.addItem(id, { kind: 'error', id: this.nextItemId++, message: error });
    this.setStatus(id, { status: 'waiting', waitingReason: 'error', error });
  }

  private appendAgentText(id: number, text: string): void {
    const items = this.transcript(id).value;
    const last = items.at(-1);
    if (last?.kind === 'agent' && last.streaming) {
      this.transcript(id).set([...items.slice(0, -1), { ...last, text: last.text + text }]);
    } else {
      this.addItem(id, { kind: 'agent', id: this.nextItemId++, text, streaming: true });
    }
  }

  private endAgentText(id: number): void {
    const items = this.transcript(id).value;
    const last = items.at(-1);
    if (last?.kind === 'agent' && last.streaming) this.transcript(id).set([...items.slice(0, -1), { ...last, streaming: false }]);
  }

  private addItem(id: number, item: TranscriptItem): void {
    this.transcript(id).set([...this.transcript(id).value, item]);
  }

  private transcript(id: number): Topic<TranscriptItem[]> {
    let topic = this.transcripts.get(id);
    if (!topic) {
      topic = new Topic<TranscriptItem[]>([]);
      this.transcripts.set(id, topic);
    }
    return topic;
  }

  private setStatus(id: number, { status, waitingReason, error }: StatusChange): void {
    const updatedAt = this.options.clock.now();
    this.update(id, { status, waitingReason, error, updatedAt });
    this.save(id, { status, waiting_reason: waitingReason ?? null, error: error ?? null, updated_at: updatedAt });
  }

  private update(id: number, change: Partial<Session>): void {
    this.sessions.set(id, withoutUndefined({ ...this.get(id), ...change }));
    this.publish();
  }

  private save(id: number, change: Partial<Omit<SessionsTable, 'id'>>): void {
    this.saving = this.saving
      .then(async () => {
        await this.options.db.updateTable('sessions').set(change).where('id', '=', id).execute();
      })
      .catch((error: unknown) => console.error(`could not save Session ${id}:`, error));
  }

  private get(id: number): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown Session ${id}`);
    return session;
  }

  private publish(): void {
    this.options.onChange(this.list());
  }
}

function promptText(prompt: string): string {
  const text = prompt.trim();
  if (!text) throw new Error('A prompt needs some text.');
  return text;
}

/** A Session's title: the first line of its first prompt, shortened. */
function titleOf(prompt: string): string {
  const line = prompt.split('\n', 1)[0]!.trim();
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : line;
}

function fromRow(row: Omit<SessionsTable, 'id'> & { id: number }): Session {
  return withoutUndefined({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    workingCopy: { kind: row.working_copy_kind, path: row.working_copy_path },
    agent: row.agent,
    agentSessionId: row.agent_session_id ?? undefined,
    status: row.status,
    waitingReason: row.waiting_reason ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Drops absent optional fields, so a Session compares equal however it was built. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
