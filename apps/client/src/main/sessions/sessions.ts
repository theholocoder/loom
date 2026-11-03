// The Session service: every Session, its status, and its conversation with
// its agent. Adapters report facts (a run started, text arrived, the run
// settled or failed); this service derives each Session's status from them.
import type { Transaction } from 'kysely';
import { FORGE_CLI, type ArchiveResult, type ForgeLink, type Issue, type Project, type Session, type SessionStatus, type TranscriptItem, type WaitingReason, type WorkingCopyKind } from '../../shared/api';
import { issueBranch, suggestBranch } from '../../shared/branches';
import type { AgentAdapter, AgentEnvironment, AgentEvent, AgentSession } from '../agents/adapter';
import type { Clock, TimerHandle } from '../clock';
import { exec, type ExecResult } from '../environments/exec';
import { GIT_TIMEOUT_MS } from '../projects/forge';
import type { LoomDatabase } from '../storage/database';
import type { EventsTable, Schema, SessionsTable } from '../storage/schema';
import { Topic } from '../topic';
import { createWorktree, removeWorktree, unsavedWork, worktreeExists, type GitEnvironment } from './working-copies';

export interface SessionsOptions {
  db: LoomDatabase;
  clock: Clock;
  adapter: AgentAdapter;
  project: (id: number) => Project | undefined;
  /** The Environment with this id, if Loom knows it. */
  environment: (id: string) => SessionEnvironment | undefined;
  /** The worktree root setting. */
  worktreeRoot: () => string;
  onChange: (sessions: Session[]) => void;
}

/** What the Session service needs from an Environment: its agent's, and git. */
export interface SessionEnvironment extends AgentEnvironment, GitEnvironment {}

const MAX_TITLE_LENGTH = 80;

/** How often streaming agent text is checkpointed to the database. */
export const CHECKPOINT_MS = 1000;

type StatusChange = { status: SessionStatus; waitingReason?: WaitingReason; error?: string };
type Write = (trx: Transaction<Schema>) => Promise<unknown>;
/** A transcript item before it has its place in the transcript. */
type NewItem = TranscriptItem extends infer I ? (I extends TranscriptItem ? Omit<I, 'id'> : never) : never;

export class Sessions {
  private sessions = new Map<number, Session>();
  /** Conversations read from the database or started since, by Session. */
  private transcripts = new Map<number, Topic<TranscriptItem[]>>();
  /** Conversations being read from the database. */
  private loading = new Map<number, Promise<Topic<TranscriptItem[]>>>();
  /** The pending checkpoint of each Session's streaming agent text. */
  private checkpoints = new Map<number, TimerHandle>();
  /** The agent conversation of each Session whose agent process is running. */
  private live = new Map<number, AgentSession>();
  /** Writes made in this tick, committed together in one transaction. */
  private pending: Write[] = [];
  /** Transactions, one after another so they land in order. */
  private saving: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  /** Worktrees being made, by Project, one after another so names can't race. */
  private creatingWorktree = new Map<number, Promise<unknown>>();

  private constructor(private readonly options: SessionsOptions) {}

  /**
   * The Session service, with the Sessions in the database. A Session that
   * was Working when the Client last stopped has lost its run: it is Waiting
   * as interrupted, and its agent's last text as far as it was saved.
   */
  static async load(options: SessionsOptions): Promise<Sessions> {
    const sessions = new Sessions(options);
    const rows = await options.db.selectFrom('sessions').selectAll().execute();
    for (const row of rows) sessions.sessions.set(row.id, fromRow(row));
    for (const session of sessions.list()) {
      if (session.status !== 'working') continue;
      await sessions.loadTranscript(session.id);
      sessions.endAgentText(session.id);
      sessions.setStatus(session.id, { status: 'waiting', waitingReason: 'interrupted' });
    }
    await sessions.flush();
    return sessions;
  }

  /** Newest first. */
  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  }

  async create(params: { projectId: number; workingCopy: WorkingCopyKind; branch?: string; issue?: Issue; prompt: string }): Promise<Session> {
    const { projectId, workingCopy, issue } = params;
    const project = this.options.project(projectId);
    if (!project) throw new Error(`unknown Project ${projectId}`);
    if (workingCopy !== 'checkout' && workingCopy !== 'worktree') throw new Error(`unsupported working copy "${workingCopy as string}"`);
    if (issue) checkIssue(issue);
    const text = promptText(issue ? [issuePrompt(issue), params.prompt.trim()].filter(Boolean).join('\n\n') : params.prompt);
    let path = project.checkout.path;
    let branch: string | null = null;
    if (workingCopy === 'worktree') {
      const environment = this.environmentOf({ projectId });
      ({ path, branch } = await this.oneAtATime(projectId, () =>
        createWorktree(environment, {
          checkout: project.checkout.path,
          projectName: project.name,
          branchPrefix: project.branchPrefix,
          branch: params.branch?.trim() || (issue ? issueBranch(project.branchPrefix, issue) : suggestBranch(project.branchPrefix, text)),
          root: this.options.worktreeRoot(),
        }),
      ));
    }
    const now = this.options.clock.now();
    const values = {
      project_id: projectId,
      title: titleOf(text),
      working_copy_kind: workingCopy,
      working_copy_path: path,
      agent: this.options.adapter.name,
      agent_session_id: null,
      status: 'working' as const,
      waiting_reason: null,
      error: null,
      unread: 0,
      branch,
      issue_number: issue?.number ?? null,
      issue_url: issue?.url ?? null,
      merge_request_number: null,
      merge_request_url: null,
      created_at: now,
      updated_at: now,
    };
    const { id } = await this.options.db.insertInto('sessions').values(values).returning('id').executeTakeFirstOrThrow();
    this.sessions.set(id, fromRow({ id, ...values }));
    this.transcripts.set(id, new Topic<TranscriptItem[]>([]));
    this.addItem(id, { kind: 'user', text });
    this.publish();
    void this.lookUpBranch(id);
    void this.run(id, text);
    return this.sessions.get(id)!;
  }

  async send({ id, prompt }: { id: number; prompt: string }): Promise<void> {
    const text = promptText(prompt);
    this.get(id);
    await this.loadTranscript(id);
    const session = this.get(id);
    if (session.status === 'working') throw new Error('The agent is still working on this Session.');
    if (session.status === 'archived') throw new Error('This Session is archived.');
    if (session.worktreeMissing) throw new Error("This Session's worktree is missing; it can only be archived.");
    if (!this.live.has(id) && session.agentSessionId) {
      throw new Error("This Session's agent has stopped, and Loom can't resume it yet.");
    }
    this.addItem(id, { kind: 'user', text });
    this.setStatus(id, { status: 'working' });
    void this.run(id, text);
  }

  /** Sends the agent the Merge request prompt shortcut. */
  async requestMergeRequest({ id }: { id: number }): Promise<void> {
    const forge = this.options.project(this.get(id).projectId)?.forge;
    if (forge?.state === 'unknown') throw new Error("Loom hasn't checked this Project's Forge yet.");
    if (forge?.state !== 'available' || !forge.kind) throw new Error("Merge requests need the Project's Forge, which is off.");
    const branch = await this.currentBranch(id);
    if (!branch) throw new Error("This Session's working copy isn't on a branch.");
    if (branch === (await this.defaultBranch(id))) {
      throw new Error(`This Session is on ${branch}, the default branch. A Merge request needs a branch of its own.`);
    }
    await this.send({ id, prompt: mergeRequestPrompt(FORGE_CLI[forge.kind]) });
  }

  /**
   * Archives the Session and stops its agent. A checkout Session's checkout is
   * left as it is. A worktree Session's worktree is removed and its branch
   * kept; unsaved work there holds the archive back unless `discard`. The
   * Session counts as archived only once its worktree is gone, so a removal
   * that fails can be tried again.
   */
  async archive({ id, discard = false }: { id: number; discard?: boolean }): Promise<ArchiveResult> {
    // An agent still starting up for this Session is closed as soon as it is open.
    this.archiving.add(id);
    try {
      return await this.archiveSession(id, discard);
    } finally {
      this.archiving.delete(id);
    }
  }

  private async archiveSession(id: number, discard: boolean): Promise<ArchiveResult> {
    // Ending the agent's text needs the transcript, so it is read first.
    this.get(id);
    await this.loadTranscript(id);
    const session = this.get(id);
    const worktree = session.workingCopy.kind === 'worktree' ? session.workingCopy.path : undefined;
    const environment = worktree === undefined ? undefined : this.environmentOf(session);
    if (session.status === 'archived' && !(environment && worktree !== undefined && (await worktreeExists(environment, worktree)))) {
      return { archived: true };
    }
    if (!environment || worktree === undefined) {
      this.markArchived(id);
      await this.stopAgent(id);
      return { archived: true };
    }
    // A working agent may still be writing, so it stops before the check.
    if (session.status === 'working') await this.stopAgent(id);
    if (!discard && (await worktreeExists(environment, worktree))) {
      const work = await unsavedWork(environment, worktree);
      if (work) return { archived: false, unsavedWork: work };
    }
    await this.stopAgent(id);
    const checkout = this.options.project(session.projectId)!.checkout.path;
    try {
      await removeWorktree(environment, { checkout, path: worktree, force: discard });
    } catch (error) {
      throw new Error(`The worktree at ${worktree} is still there, so the Session isn't archived. ${(error as Error).message}`);
    }
    this.markArchived(id);
    return { archived: true };
  }

  private readonly archiving = new Set<number>();

  private markArchived(id: number): void {
    // Also guards a concurrent archive of the same Session: it was archived while this one waited.
    if (this.get(id).status === 'archived') return;
    this.endAgentText(id);
    this.setStatus(id, { status: 'archived' });
    this.update(id, { worktreeMissing: undefined });
  }

  /** Closes the Session's agent, if it has one. */
  private async stopAgent(id: number): Promise<void> {
    this.endAgentText(id);
    const agent = this.live.get(id);
    this.live.delete(id);
    await agent?.close();
  }

  setUnread({ id, unread }: { id: number; unread: boolean }): void {
    this.get(id);
    this.update(id, { unread });
    this.save(id, { unread: unread ? 1 : 0 });
  }

  /**
   * Reads again which branch each Session's working copy has, for the
   * Sessions that aren't archived in the Environment `environmentId`.
   */
  async lookUpBranches(environmentId: string): Promise<void> {
    const ids = this.list()
      .filter((s) => s.status !== 'archived' && this.options.project(s.projectId)?.checkout.environmentId === environmentId)
      .map((s) => s.id);
    await Promise.all(ids.map((id) => this.lookUpBranch(id)));
  }

  /**
   * Calls `listener` with the Session's conversation, replayed from the
   * database, and then as it changes. Opening it also reads its branch again,
   * which the user may have switched.
   */
  subscribeTranscript(id: number, listener: (items: TranscriptItem[]) => void): () => void {
    if (this.get(id).status !== 'archived') void this.lookUpBranch(id);
    const loaded = this.transcripts.get(id);
    if (loaded) return loaded.subscribe(listener);
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    this.loadTranscript(id).then(
      (topic) => {
        if (!cancelled) unsubscribe = topic.subscribe(listener);
      },
      (error: unknown) => console.error(`could not read Session ${id}'s transcript:`, error),
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }

  /**
   * Stops reacting to agents, whose processes end with their Environment,
   * and waits for status changes and transcripts, streaming text included,
   * to be written.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const id of [...this.checkpoints.keys()]) this.checkpoint(id);
    await this.flush();
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
    const agent = await this.options.adapter.open({
      environment: this.environmentOf(session),
      workingCopy: session.workingCopy.path,
      onEvent: (event) => this.onAgentEvent(id, event),
    });
    if (this.get(id).status === 'archived' || this.archiving.has(id)) {
      await agent.close();
      throw new Error('This Session is archived.');
    }
    this.live.set(id, agent);
    this.update(id, { agentSessionId: agent.id });
    this.save(id, { agent_session_id: agent.id });
    return agent;
  }

  private onAgentEvent(id: number, event: AgentEvent): void {
    // An archived Session's agent is on its way out; nothing it says counts.
    if (this.shuttingDown || this.get(id).status === 'archived') return;
    switch (event.type) {
      case 'run-started':
        return;
      case 'text-delta':
        return this.appendAgentText(id, event.text);
      case 'run-settled':
        this.endAgentText(id);
        this.setStatus(id, { status: 'waiting', waitingReason: 'finished' });
        return void this.lookUpBranch(id);
      case 'run-failed':
        this.fail(id, event.error);
        return void this.lookUpBranch(id);
      case 'closed':
        this.live.delete(id);
        return this.fail(id, event.error ?? `${this.options.adapter.name} stopped`);
    }
  }

  /**
   * Records the branch the Session's working copy has checked out, which the
   * agent or the user may have changed, or its short commit id on a detached
   * HEAD. Keeps the last one known if git can't say. Flags a worktree that is
   * gone as missing.
   */
  private async lookUpBranch(id: number): Promise<void> {
    let branch: string | undefined;
    try {
      if (!(await this.lookUpWorktree(id))) return;
      branch = await this.currentBranch(id);
      if (!branch) {
        const detached = await this.git(id, 'rev-parse', '--short', 'HEAD');
        if (detached.exitCode === 0) branch = detached.stdout.trim();
      }
    } catch {
      return;
    }
    if (!branch || this.shuttingDown || branch === this.get(id).branch) return;
    this.update(id, { branch });
    this.save(id, { branch });
  }

  /** Flags or clears a worktree Session's worktree as missing; resolves with whether it exists. */
  private async lookUpWorktree(id: number): Promise<boolean> {
    const session = this.get(id);
    if (session.workingCopy.kind !== 'worktree') return true;
    const exists = await worktreeExists(this.environmentOf(session), session.workingCopy.path);
    const current = this.get(id);
    if (this.shuttingDown || current.status === 'archived') return false;
    if (exists === !current.worktreeMissing) return exists;
    this.update(id, { worktreeMissing: exists ? undefined : true });
    return exists;
  }

  /** The branch the Session's working copy has checked out; undefined on a detached HEAD. */
  private async currentBranch(id: number): Promise<string | undefined> {
    const result = await this.git(id, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  /** The default branch, as the working copy's `origin/HEAD` names it; undefined if git doesn't know it. */
  private async defaultBranch(id: number): Promise<string | undefined> {
    const result = await this.git(id, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
    return result.exitCode === 0 ? result.stdout.trim().replace(/^origin\//, '') : undefined;
  }

  /** Runs git in the Session's working copy. */
  private git(id: number, ...args: string[]): Promise<ExecResult> {
    const session = this.get(id);
    return exec(this.environmentOf(session).request, 'git', ['-C', session.workingCopy.path, ...args], GIT_TIMEOUT_MS);
  }

  /** Runs `task` once the Project's earlier ones have finished. */
  private oneAtATime<T>(projectId: number, task: () => Promise<T>): Promise<T> {
    const run = (this.creatingWorktree.get(projectId) ?? Promise.resolve()).catch(() => {}).then(task);
    this.creatingWorktree.set(projectId, run);
    return run;
  }

  /** The Environment the Session's agent and git run in: its Project's checkout's. */
  private environmentOf(session: Pick<Session, 'projectId'>): SessionEnvironment {
    const environmentId = this.options.project(session.projectId)?.checkout.environmentId;
    const environment = environmentId === undefined ? undefined : this.options.environment(environmentId);
    if (!environment) throw new Error(`unknown Environment "${environmentId}"`);
    return environment;
  }

  /** Puts a Working Session in Waiting (error), showing why in its conversation. */
  private fail(id: number, error: string): void {
    if (this.get(id).status !== 'working') return;
    this.endAgentText(id);
    this.addItem(id, { kind: 'error', message: error });
    this.setStatus(id, { status: 'waiting', waitingReason: 'error', error });
  }

  /**
   * Streaming text stays in memory, written about once a second, so a crash
   * loses at most that much of it.
   */
  private appendAgentText(id: number, text: string): void {
    const items = this.transcript(id).value;
    const last = items.at(-1);
    if (last?.kind === 'agent' && last.streaming) {
      this.transcript(id).set([...items.slice(0, -1), { ...last, text: last.text + text }]);
      if (!this.checkpoints.has(id)) this.checkpoints.set(id, this.options.clock.setTimeout(() => this.checkpoint(id), CHECKPOINT_MS));
    } else {
      this.addItem(id, { kind: 'agent', text, streaming: true });
    }
  }

  /** Writes the Session's streaming agent text as it is now. */
  private checkpoint(id: number): void {
    this.cancelCheckpoint(id);
    const last = this.transcript(id).value.at(-1);
    if (last?.kind === 'agent' && last.streaming) this.writeItem(id, last);
  }

  private cancelCheckpoint(id: number): void {
    const handle = this.checkpoints.get(id);
    if (handle === undefined) return;
    this.options.clock.clearTimeout(handle);
    this.checkpoints.delete(id);
  }

  /** Finishes the Session's streaming agent text, if any, and writes it. */
  private endAgentText(id: number): void {
    const items = this.transcript(id).value;
    const last = items.at(-1);
    if (last?.kind !== 'agent' || !last.streaming) return;
    this.cancelCheckpoint(id);
    const ended = { ...last, streaming: false };
    this.transcript(id).set([...items.slice(0, -1), ended]);
    this.writeItem(id, ended);
  }

  /** Appends an event to the Session's transcript and writes it; its id is its place there. */
  private addItem(id: number, item: NewItem): void {
    const items = this.transcript(id).value;
    const added = { ...item, id: items.length } as TranscriptItem;
    this.transcript(id).set([...items, added]);
    this.writeItem(id, added);
  }

  private writeItem(id: number, { id: seq, kind, ...data }: TranscriptItem): void {
    const row: EventsTable = { session_id: id, seq, kind, data: JSON.stringify(data) };
    this.write((trx) =>
      trx
        .insertInto('events')
        .values(row)
        .onConflict((oc) => oc.columns(['session_id', 'seq']).doUpdateSet({ kind: row.kind, data: row.data }))
        .execute(),
    );
  }

  /** The conversation of a Session whose transcript has been read. */
  private transcript(id: number): Topic<TranscriptItem[]> {
    const topic = this.transcripts.get(id);
    if (!topic) throw new Error(`Session ${id}'s transcript hasn't been read`);
    return topic;
  }

  /** Reads the Session's transcript from the database, once. */
  private loadTranscript(id: number): Promise<Topic<TranscriptItem[]>> {
    const loaded = this.transcripts.get(id);
    if (loaded) return Promise.resolve(loaded);
    let loading = this.loading.get(id);
    if (!loading) {
      loading = this.options.db
        .selectFrom('events')
        .selectAll()
        .where('session_id', '=', id)
        .orderBy('seq')
        .execute()
        .then((rows) => {
          const topic = new Topic(rows.map(itemOf));
          this.transcripts.set(id, topic);
          return topic;
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, loading);
    }
    return loading;
  }

  /** Changes the Session's status. Going Waiting brings news for the user; anything else means they've seen it. */
  private setStatus(id: number, { status, waitingReason, error }: StatusChange): void {
    const updatedAt = this.options.clock.now();
    const unread = status === 'waiting';
    this.update(id, { status, waitingReason, error, unread, updatedAt });
    this.save(id, { status, waiting_reason: waitingReason ?? null, error: error ?? null, unread: unread ? 1 : 0, updated_at: updatedAt });
  }

  private update(id: number, change: Partial<Session>): void {
    this.sessions.set(id, withoutUndefined({ ...this.get(id), ...change }));
    this.publish();
  }

  private save(id: number, change: Partial<Omit<SessionsTable, 'id'>>): void {
    this.write((trx) => trx.updateTable('sessions').set(change).where('id', '=', id).execute());
  }

  /**
   * Queues a write. Writes made in the same tick, such as a status change and
   * the events that caused it, are committed in one transaction.
   */
  private write(write: Write): void {
    this.pending.push(write);
    if (this.pending.length === 1) queueMicrotask(() => this.commit());
  }

  private commit(): void {
    const writes = this.pending;
    if (!writes.length) return;
    this.pending = [];
    this.saving = this.saving
      .then(() =>
        this.options.db.transaction().execute(async (trx) => {
          for (const write of writes) await write(trx);
        }),
      )
      .catch((error: unknown) => console.error('could not save Sessions:', error));
  }

  /** Commits the pending writes and waits for every write so far. */
  private async flush(): Promise<void> {
    this.commit();
    await this.saving;
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

/** Rejects an issue Loom couldn't link to, or open in the browser. */
function checkIssue(issue: Issue): void {
  if (!Number.isInteger(issue.number) || issue.number <= 0 || !/^https?:\/\//i.test(issue.url ?? '')) {
    throw new Error('An issue needs a number and an http(s) link.');
  }
}

/** The start of a first prompt from an issue: its number and title, URL, then body. */
function issuePrompt(issue: Issue): string {
  const heading = `#${issue.number} ${(issue.title ?? '').trim()}`.trimEnd();
  return [`${heading}\n${issue.url}`, (issue.body ?? '').trim()].filter(Boolean).join('\n\n');
}

/** The prompt shortcut asking the agent to open or update its branch's Merge request. */
function mergeRequestPrompt(cli: string): string {
  return `Open a Merge request for this branch with ${cli}, or update it if one is already open: push the branch, then write its title and description from our conversation.`;
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
    branch: row.branch ?? undefined,
    issue: linkOf(row.issue_number, row.issue_url),
    mergeRequest: linkOf(row.merge_request_number, row.merge_request_url),
    status: row.status,
    waitingReason: row.waiting_reason ?? undefined,
    error: row.error ?? undefined,
    unread: row.unread !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function itemOf(row: EventsTable): TranscriptItem {
  return { ...(JSON.parse(row.data) as object), kind: row.kind, id: row.seq } as TranscriptItem;
}

function linkOf(number: number | null, url: string | null): ForgeLink | undefined {
  return number === null || url === null ? undefined : { number, url };
}

/** Drops absent optional fields, so a Session compares equal however it was built. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
