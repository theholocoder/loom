// The Session service: every Session, its status, and its conversation with
// its agent. Adapters report facts (a run started, text arrived, the run
// settled or failed); this service derives each Session's status from them.
import type { Transaction } from 'kysely';
import { FORGE_CLI, type Answer, type ArchiveResult, type Commands, type ExistingBranch, type DiffFile, type DiffStat, type DiffSummary, type FileDiff, type ForgeLink, type Issue, type Project, type Session, type SessionStatus, type TranscriptItem, type WaitingReason, type WorkingCopyKind } from '../../shared/api';
import { issueBranch, suggestBranch } from '../../shared/branches';
import type { AgentAdapter, AgentEnvironment, AgentEvent, AgentSession } from '../agents/adapter';
import type { Clock, TimerHandle } from '../clock';
import { exec, type ExecResult } from '../environments/exec';
import { GIT_TIMEOUT_MS } from '../projects/forge';
import type { LoomDatabase } from '../storage/database';
import type { EventsTable, Schema, SessionsTable } from '../storage/schema';
import { Topic } from '../topic';
import { WorkingCopyDiff } from './diff';
import { createWorktree, removeWorktree, unsavedWork, worktreeExists, type GitEnvironment } from './working-copies';
import { capToolOutput } from './tool-output';
import { checkAnswer } from '../../shared/answers';

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
  /** How many untracked files a diff counts lines for; defaults to the diff service's limit. */
  maxUntrackedCounted?: number;
  /** Whether each Project's local files are trusted, as the user last said; undefined until asked. */
  projectTrust: {
    get(projectId: number): boolean | undefined;
    /** Takes effect for `get` at once; resolves once saved. */
    set(projectId: number, trusted: boolean): Promise<void>;
  };
}

/** What the Session service needs from an Environment: its agent's, and git. */
export interface SessionEnvironment extends AgentEnvironment, GitEnvironment {
  /** Resolves once the Environment is connected, waiting while it starts; rejects if it can't start. */
  ready(): Promise<void>;
  /** Starts the Environment again if it failed to start. */
  restart(): Promise<void>;
}

/** What a Session whose agent ended with its Environment's bridge shows. */
export const ENVIRONMENT_RESTARTED = 'Environment restarted';

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
  /** The last diff summary worked out per Session and `uncommittedOnly`, which `diffFile` looks its file up in. */
  private readonly diffSummaries = new Map<string, DiffSummary>();
  /**
   * Archives running, by Session: an agent that opens meanwhile waits for the
   * outcome, and is closed if the Session was archived; its closing isn't a failure.
   */
  private readonly archiving = new Map<number, Promise<unknown>>();
  /** Sessions whose agent ended with its Environment's bridge: their next prompt starts it again. */
  private restarted = new Set<number>();
  /** What each Session's agent asked and waits on: the agent's request id, by transcript item id. */
  private readonly asks = new Map<number, Map<number, string>>();
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
      // A Session waiting on a question was mid-run too: the agent's question went with its process.
      if (session.status !== 'working' && !(session.status === 'waiting' && session.waitingReason === 'question')) continue;
      await sessions.loadTranscript(session.id);
      sessions.endRun(session.id);
      sessions.setStatus(session.id, { status: 'waiting', waitingReason: 'interrupted' });
    }
    await sessions.flush();
    return sessions;
  }

  /** Newest first. */
  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  }

  async create(params: Commands['sessions.create']['params']): Promise<Session> {
    const { projectId, workingCopy, issue } = params;
    const project = this.options.project(projectId);
    if (!project) throw new Error(`unknown Project ${projectId}`);
    if (workingCopy !== 'checkout' && workingCopy !== 'worktree') throw new Error(`unsupported working copy "${workingCopy as string}"`);
    if (issue) checkIssue(issue);
    if (params.existingBranch) {
      if (workingCopy !== 'worktree') throw new Error('Only a worktree Session checks out an existing branch');
      if (params.branch !== undefined || params.base !== undefined) throw new Error("A Session on an existing branch doesn't name or base a new one");
      checkExistingBranch(params.existingBranch);
    }
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
          branch: params.existingBranch
            ? { existing: params.existingBranch }
            : {
                new: params.branch?.trim() || (issue ? issueBranch(project.branchPrefix, issue) : suggestBranch(project.branchPrefix, text)),
                ...(params.base?.trim() ? { base: params.base.trim() } : {}),
              },
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
    if (this.inRun(id)) throw new Error("The agent is waiting for an answer to what it asked; answer or dismiss it first.");
    if (session.status === 'archived') throw new Error('This Session is archived.');
    if (session.worktreeMissing) throw new Error("This Session's worktree is missing; it can only be archived.");
    this.assertCanPrompt(id);
    this.addItem(id, { kind: 'user', text });
    this.setStatus(id, { status: 'working' });
    void this.run(id, text);
  }

  /**
   * Sends a Session Waiting on an error its last prompt again, if that went
   * unanswered, starting its Environment again first if that failed to start.
   */
  async retry({ id }: { id: number }): Promise<void> {
    this.get(id);
    const items = (await this.loadTranscript(id)).value;
    const session = this.get(id);
    const [prompt, error] = items.slice(-2);
    if (session.status !== 'waiting' || session.waitingReason !== 'error' || prompt?.kind !== 'user' || error?.kind !== 'error') {
      throw new Error('There is nothing to retry: send a new prompt instead.');
    }
    if (session.worktreeMissing) throw new Error("This Session's worktree is missing; it can only be archived.");
    this.assertCanPrompt(id);
    const environment = this.environmentOf(session);
    this.setStatus(id, { status: 'working' });
    // Starting again sets the Environment starting at once, so the run waits for it.
    environment.restart().catch(() => {});
    void this.run(id, prompt.text);
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
   * Answers the agent's question in transcript item `itemId`, or dismisses it
   * when `answer` is null. The Session is Working again once the agent waits
   * on nothing else.
   */
  async answer({ id, itemId, answer }: { id: number; itemId: number; answer: Answer | null }): Promise<void> {
    this.get(id);
    const items = (await this.loadTranscript(id)).value;
    const item = items[itemId];
    if (item?.kind !== 'question') throw new Error('There is no such question in this Session.');
    const requestId = this.asks.get(id)?.get(itemId);
    if (item.state !== 'asked' || requestId === undefined) throw new Error('The agent is no longer asking this question.');
    const values = answer === null ? null : checkAnswer(item.fields, answer);
    this.settleAsk(id, itemId, answer === null ? { ...item, state: 'dismissed' } : { ...item, state: 'answered', answer: values! });
    this.live.get(id)?.answer(requestId, { kind: 'question', answer: values });
  }

  /**
   * Answers the agent's trust request in transcript item `itemId`. The
   * Project keeps the answer, which also answers the requests other Sessions
   * of the Project are waiting on.
   */
  async trust({ id, itemId, trusted }: { id: number; itemId: number; trusted: boolean }): Promise<void> {
    this.get(id);
    const item = (await this.loadTranscript(id)).value[itemId];
    if (item?.kind !== 'trust') throw new Error('There is no such trust request in this Session.');
    if (item.state !== 'asked' || !this.asks.get(id)?.has(itemId)) throw new Error('The agent is no longer asking this.');
    const { projectId } = this.get(id);
    // Recorded before anything else can answer, so the Project keeps the answer its cards show.
    const saved = this.options.projectTrust.set(projectId, trusted);
    for (const [other, asked] of [...this.asks.entries()]) {
      if (this.get(other).projectId !== projectId) continue;
      for (const [seq, requestId] of [...asked.entries()]) {
        const card = this.transcript(other).value[seq];
        if (card?.kind !== 'trust') continue;
        this.settleAsk(other, seq, { ...card, state: trusted ? 'trusted' : 'untrusted' });
        this.live.get(other)?.answer(requestId, { kind: 'trust', trusted });
      }
    }
    await saved;
  }

  /** Records the user's response to an ask; with nothing else asked, the Session is Working again. */
  private settleAsk(id: number, itemId: number, settled: TranscriptItem): void {
    const asked = this.asks.get(id);
    asked?.delete(itemId);
    if (asked?.size === 0) this.asks.delete(id);
    this.replaceItem(id, settled);
    if (!this.asks.has(id)) this.setStatus(id, { status: 'working' });
  }

  /** Whether the Session's agent is mid-run: working, or waiting on the user's answer to something it asked. */
  private inRun(id: number): boolean {
    return this.get(id).status === 'working' || this.asks.has(id);
  }

  /** Throws if the Session's agent has stopped for good: Loom can't resume agents yet. */
  private assertCanPrompt(id: number): void {
    if (!this.live.has(id) && this.get(id).agentSessionId && !this.restarted.has(id)) {
      throw new Error("This Session's agent has stopped, and Loom can't resume it yet.");
    }
  }

  /**
   * Archives the Session and stops its agent. A checkout Session's checkout is
   * left as it is. A worktree Session's worktree is removed and its branch
   * kept; unsaved work there holds the archive back unless `discard`. The
   * Session counts as archived only once its worktree is gone, so a removal
   * that fails can be tried again.
   */
  async archive({ id, discard = false }: { id: number; discard?: boolean }): Promise<ArchiveResult> {
    // An agent still starting up for this Session waits for this, and is closed if the Session is archived.
    const archiving = this.archiveSession(id, discard);
    this.archiving.set(id, archiving);
    try {
      return await archiving;
    } finally {
      if (this.archiving.get(id) === archiving) this.archiving.delete(id);
    }
  }

  private async worktreeLeftOver(session: Session): Promise<boolean> {
    if (session.workingCopy.kind !== 'worktree') return false;
    try {
      return await worktreeExists(this.environmentOf(session), session.workingCopy.path);
    } catch {
      return false; // Environment gone or offline: nothing left to do
    }
  }

  private async archiveSession(id: number, discard: boolean): Promise<ArchiveResult> {
    // Ending the agent's text needs the transcript, so it is read first.
    this.get(id);
    await this.loadTranscript(id);
    const session = this.get(id);
    const worktree = session.workingCopy.kind === 'worktree' ? session.workingCopy.path : undefined;
    // An archived Session is only retried while its worktree is still on disk; never fail on one.
    if (session.status === 'archived' && !(await this.worktreeLeftOver(session))) return { archived: true };
    const environment = worktree === undefined ? undefined : this.environmentOf(session);
    if (!environment || worktree === undefined) {
      this.markArchived(id);
      await this.stopAgent(id);
      return { archived: true };
    }
    // The check runs with the agent alive, so Cancel on the warning leaves the Session as it was.
    if (!discard && (await worktreeExists(environment, worktree))) {
      const work = await unsavedWork(environment, worktree);
      if (work) return { archived: false, unsavedWork: work };
    }
    // Confirmed: stop the agent, then look again in case it wrote in its last moment.
    // A run waiting on the user's answer ends here too, so it fails like a Working one.
    const evenIfWaiting = this.inRun(id);
    await this.stopAgent(id);
    if (!discard && (await worktreeExists(environment, worktree))) {
      const work = await unsavedWork(environment, worktree);
      if (work) {
        this.fail(id, 'Loom stopped the agent to archive this Session, but it left unsaved work, so the Session was not archived.', { evenIfWaiting });
        return { archived: false, unsavedWork: work };
      }
    }
    const checkout = this.options.project(session.projectId)!.checkout.path;
    try {
      await removeWorktree(environment, { checkout, path: worktree, force: discard });
    } catch (error) {
      const message = `The worktree at ${worktree} is still there, so the Session isn't archived. ${(error as Error).message}`;
      this.fail(id, `Loom stopped the agent to archive this Session. ${message}`, { evenIfWaiting });
      throw new Error(message);
    }
    this.markArchived(id);
    return { archived: true };
  }

  private markArchived(id: number): void {
    // Also guards a concurrent archive of the same Session: it was archived while this one waited.
    if (this.get(id).status === 'archived') return;
    this.endRun(id);
    this.setStatus(id, { status: 'archived' });
    this.update(id, { worktreeMissing: undefined, diffStat: undefined });
    for (const key of [`${id}:true`, `${id}:false`]) this.diffSummaries.delete(key);
  }

  /** Closes the Session's agent, if it has one. */
  private async stopAgent(id: number): Promise<void> {
    this.endRun(id);
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
    if (this.get(id).status !== 'archived') void this.lookUpBranch(id).then(() => this.lookUpDiffStat(id));
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
   * The bridge of the Environment `environmentId` died, and with it the
   * agents running there: their Sessions go Waiting (error), and their next
   * prompt starts the agent again.
   */
  environmentRestarted(environmentId: string): void {
    if (this.shuttingDown) return;
    for (const id of [...this.live.keys()]) {
      if (this.options.project(this.get(id).projectId)?.checkout.environmentId !== environmentId) continue;
      this.live.delete(id);
      this.restarted.add(id);
      this.fail(id, ENVIRONMENT_RESTARTED, { evenIfWaiting: true });
    }
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
    const environment = this.environmentOf(session);
    await environment.ready();
    let opened: AgentSession | undefined;
    const agent = await this.options.adapter.open({
      environment,
      workingCopy: session.workingCopy.path,
      // An agent the Session has moved on from, as after a restart, no longer counts.
      onEvent: (event) => {
        if (opened && this.live.get(id) !== opened) return;
        this.onAgentEvent(id, event);
      },
    });
    opened = agent;
    // An archive held back by unsaved work leaves the Session as it was, so its agent carries on.
    while (this.archiving.has(id)) await this.archiving.get(id)!.catch(() => {});
    if (this.get(id).status === 'archived') {
      await agent.close();
      throw new Error('This Session is archived.');
    }
    this.live.set(id, agent);
    this.restarted.delete(id);
    this.update(id, { agentSessionId: agent.id });
    this.save(id, { agent_session_id: agent.id });
    return agent;
  }

  private onAgentEvent(id: number, event: AgentEvent): void {
    // The agent closing is Archive's own doing; Archive reports it if the Session stays.
    if (event.type === 'closed' && this.archiving.has(id)) return void this.live.delete(id);
    // An archived Session's agent is on its way out; nothing it says counts.
    if (this.shuttingDown || this.get(id).status === 'archived') return;
    switch (event.type) {
      case 'run-started':
        return;
      case 'text-delta':
        return this.appendText(id, 'agent', event.text);
      case 'thinking-delta':
        return this.appendText(id, 'thinking', event.text);
      case 'tool-started':
      case 'tool-updated':
        // A run's cards are settled when it ends; what comes after can't reopen them.
        if (!this.inRun(id)) return;
        return this.recordTool(id, event);
      case 'question-asked':
        if (!this.inRun(id)) return;
        return this.ask(id, event.requestId, { kind: 'question', message: event.message, fields: event.fields, state: 'asked' });
      case 'trust-asked': {
        if (!this.inRun(id)) return;
        const trusted = this.options.projectTrust.get(this.get(id).projectId);
        // Asked once per Project: its answer stands for every Session after.
        if (trusted !== undefined) return void this.live.get(id)?.answer(event.requestId, { kind: 'trust', trusted });
        return this.ask(id, event.requestId, { kind: 'trust', message: event.message, state: 'asked' });
      }
      case 'run-settled':
        this.endRun(id);
        this.setStatus(id, { status: 'waiting', waitingReason: 'finished' });
        return void this.lookUpBranch(id).then(() => this.lookUpDiffStat(id));
      case 'run-failed':
        this.fail(id, event.error);
        return void this.lookUpBranch(id).then(() => this.lookUpDiffStat(id));
      case 'closed':
        this.live.delete(id);
        return this.fail(id, event.error ?? `${this.options.adapter.name} stopped`);
    }
  }

  /** Shows what the agent asked as a card, and waits on the user: Waiting (question). */
  private ask(id: number, requestId: string, card: NewItem): void {
    this.endStreaming(id);
    this.addItem(id, card);
    const seq = this.transcript(id).value.length - 1;
    let asked = this.asks.get(id);
    if (!asked) this.asks.set(id, (asked = new Map()));
    asked.set(seq, requestId);
    this.setStatus(id, { status: 'waiting', waitingReason: 'question' });
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

  /** Works out the Session's diff, and the Session header's changes control with it. */
  async diff(id: number, uncommittedOnly = false): Promise<DiffSummary> {
    const diff = await this.diffOf(id);
    if (!diff) return { available: false, reason: 'No diff available' };
    const summary = await diff.summary(uncommittedOnly);
    this.diffSummaries.set(`${id}:${uncommittedOnly}`, summary);
    if (!uncommittedOnly && this.get(id).status !== 'archived') this.recordDiffStat(id, WorkingCopyDiff.stat(filesOf(summary)));
    return summary;
  }

  /** One file of the Session's diff; the renderer names the path, what git is asked about it is worked out here. */
  async diffFile(id: number, path: string, uncommittedOnly = false): Promise<FileDiff> {
    const diff = await this.diffOf(id);
    if (!diff) throw new Error('No diff available');
    const key = `${id}:${uncommittedOnly}`;
    const known = this.diffSummaries.get(key);
    let file = known && filesOf(known).find((f) => f.path === path);
    if (!file) {
      const summary = await diff.summary(uncommittedOnly);
      this.diffSummaries.set(key, summary);
      file = filesOf(summary).find((f) => f.path === path);
    }
    if (!file) throw new Error(`${path} isn't in this diff`);
    return diff.file(file, uncommittedOnly);
  }

  /**
   * The Session's working copy to diff; for an archived worktree Session, its
   * branch in the Project's checkout while it still exists. None for an
   * archived checkout Session or a missing worktree.
   */
  private async diffOf(id: number): Promise<WorkingCopyDiff | undefined> {
    const session = this.get(id);
    const environment = this.environmentOf(session);
    if (session.status !== 'archived') return session.worktreeMissing ? undefined : new WorkingCopyDiff(environment, { repo: session.workingCopy.path }, this.options.maxUntrackedCounted);
    if (session.workingCopy.kind !== 'worktree' || !session.branch) return undefined;
    const checkout = this.options.project(session.projectId)?.checkout.path;
    if (!checkout) return undefined;
    const found = await exec(environment.request, 'git', ['-C', checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${session.branch}`], GIT_TIMEOUT_MS);
    return found.exitCode === 0 ? new WorkingCopyDiff(environment, { repo: checkout, branch: session.branch }, this.options.maxUntrackedCounted) : undefined;
  }

  /** Records the Session header's changes control; keeps the last one known if git can't say. */
  private async lookUpDiffStat(id: number): Promise<void> {
    try {
      const session = this.get(id);
      if (session.status === 'archived' || session.worktreeMissing) return;
      const diff = new WorkingCopyDiff(this.environmentOf(session), { repo: session.workingCopy.path }, this.options.maxUntrackedCounted);
      const summary = await diff.summary();
      this.diffSummaries.set(`${id}:false`, summary);
      this.recordDiffStat(id, WorkingCopyDiff.stat(filesOf(summary)));
    } catch {
      return;
    }
  }

  private recordDiffStat(id: number, diffStat: DiffStat): void {
    if (this.shuttingDown || this.get(id).status === 'archived') return;
    const known = this.get(id).diffStat;
    if (known && known.files === diffStat.files && known.added === diffStat.added && known.removed === diffStat.removed) return;
    this.update(id, { diffStat });
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

  /** Puts a Working Session (or, `evenIfWaiting`, a Waiting one) in Waiting (error), showing why in its conversation. */
  private fail(id: number, error: string, { evenIfWaiting = false } = {}): void {
    const { status } = this.get(id);
    if (!this.inRun(id) && !(evenIfWaiting && status === 'waiting')) return;
    this.endRun(id);
    this.addItem(id, { kind: 'error', message: error });
    this.setStatus(id, { status: 'waiting', waitingReason: 'error', error });
  }

  /**
   * Streaming text (the agent's reply or its thinking) stays in memory,
   * written about once a second, so a crash loses at most that much of it.
   * Text of another kind, or after a tool call, is a new item.
   */
  private appendText(id: number, kind: 'agent' | 'thinking', text: string): void {
    const items = this.transcript(id).value;
    const last = items.at(-1);
    if (last?.kind === kind && last.streaming) {
      this.transcript(id).set([...items.slice(0, -1), { ...last, text: last.text + text }]);
      if (!this.checkpoints.has(id)) this.checkpoints.set(id, this.options.clock.setTimeout(() => this.checkpoint(id), CHECKPOINT_MS));
    } else {
      this.endStreaming(id);
      this.addItem(id, { kind, text, streaming: true });
    }
  }

  /** Writes the Session's streaming text as it is now. */
  private checkpoint(id: number): void {
    this.cancelCheckpoint(id);
    const last = this.transcript(id).value.at(-1);
    if (isStreamingText(last)) this.writeItem(id, last);
  }

  private cancelCheckpoint(id: number): void {
    const handle = this.checkpoints.get(id);
    if (handle === undefined) return;
    this.options.clock.clearTimeout(handle);
    this.checkpoints.delete(id);
  }

  /** Finishes the Session's streaming text, if any, and writes it. */
  private endStreaming(id: number): void {
    const items = this.transcript(id).value;
    const last = items.at(-1);
    if (!isStreamingText(last)) return;
    this.cancelCheckpoint(id);
    const ended = { ...last, streaming: false };
    this.transcript(id).set([...items.slice(0, -1), ended]);
    this.writeItem(id, ended);
  }

  /**
   * Finishes what the Session's run left going: its streaming text, its
   * tool calls still running, which can't finish any more and so failed, and
   * what it asked, which can't be answered any more.
   */
  private endRun(id: number): void {
    this.endStreaming(id);
    this.asks.delete(id);
    const items = this.transcript(id).value;
    if (!items.some(leftGoing)) return;
    const ended = items.map((i) => (!leftGoing(i) ? i : i.kind === 'tool' ? { ...i, status: 'failed' as const } : { ...i, state: 'expired' as const }));
    this.transcript(id).set(ended);
    for (const [seq, item] of ended.entries()) if (item !== items[seq]) this.writeItem(id, item);
  }

  /**
   * Adds a tool call's card, or updates the one with its id wherever it is in
   * the transcript, writing it at once. Its input and output are capped.
   */
  private recordTool(id: number, { type: _type, ...call }: Extract<AgentEvent, { type: 'tool-started' | 'tool-updated' }>): void {
    const input = call.input === undefined ? undefined : capToolOutput(call.input);
    const output = call.output === undefined ? undefined : capToolOutput(call.output);
    const changes = withoutUndefined({ ...call, input: input?.text, output: output?.text });
    const items = this.transcript(id).value;
    const at = items.findLastIndex((i) => i.kind === 'tool' && i.toolCallId === call.toolCallId);
    const card = items[at];
    // A card stays marked once cut: what's kept of it is still partial.
    const truncated = (card?.kind === 'tool' && card.truncated) || input?.truncated || output?.truncated;
    if (card?.kind !== 'tool') {
      this.endStreaming(id);
      return this.addItem(id, { kind: 'tool', title: 'Tool call', status: 'running', ...changes, ...(truncated ? { truncated } : {}) });
    }
    this.replaceItem(id, { ...card, ...changes, ...(truncated ? { truncated } : {}) });
  }

  /** Puts `item` in place of the transcript item with its id, and writes it. */
  private replaceItem(id: number, item: TranscriptItem): void {
    this.transcript(id).set(this.transcript(id).value.map((i) => (i.id === item.id ? item : i)));
    this.writeItem(id, item);
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

/** Rejects an existing branch that isn't a plain branch name. */
function checkExistingBranch(branch: ExistingBranch): void {
  if (typeof branch.name !== 'string' || !branch.name || branch.name.startsWith('-') || typeof branch.remote !== 'boolean') {
    throw new Error('An existing branch needs a name, and whether it is on origin.');
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

/** What a run leaves going until it ends: a tool call still running, or a question or trust request still asked. */
function leftGoing(item: TranscriptItem): boolean {
  return (item.kind === 'tool' && item.status === 'running') || ((item.kind === 'question' || item.kind === 'trust') && item.state === 'asked');
}

/** Text the agent is still adding to: its reply or its thinking. */
function isStreamingText(item: TranscriptItem | undefined): item is Extract<TranscriptItem, { kind: 'agent' | 'thinking' }> {
  return (item?.kind === 'agent' || item?.kind === 'thinking') && item.streaming;
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

function filesOf(summary: DiffSummary): DiffFile[] {
  return summary.available ? summary.files : [];
}
