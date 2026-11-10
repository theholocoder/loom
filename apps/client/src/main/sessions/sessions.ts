// The Session service: every Session, its status, and its conversation with
// its agent. Adapters report facts (a run started, text arrived, the run
// settled or failed); this service derives each Session's status from them.
import type { Transaction } from 'kysely';
import { FORGE_CLI, MAX_AUTO_PROMPTS, MAX_LISTED_FILES, type Answer, type BabysitStatus, type EndedMergeRequestState, type MergeRequestState, type ApprovalCategory, type ApprovalDecision, type ApprovalPolicy, type ArchiveResult, type Attachment, type Branches, type Commands, type ExistingWorkingCopy, type DiffComment, type DiffFile, type DiffStat, type DiffSummary, type FileDiff, type ForgeLink, type Issue, type ModelChoice, type ModelPick, type Project, type QueuedMessage, type Session, type SessionStatus, type SessionUsage, type TokenCounts, totalTokens, type TranscriptItem, type WaitingReason, type WorkingCopyKind } from '../../shared/api';
import { issueBranch, suggestBranch } from '../../shared/branches';
import { ResumeRefused, type AgentAdapter, type AgentEnvironment, type AgentEvent, type AgentSession, type ApprovalAction, type PromptFile } from '../agents/adapter';
import type { Clock, TimerHandle } from '../clock';
import { exec, type ExecResult } from '../environments/exec';
import { GIT_TIMEOUT_MS } from '../projects/forge';
import type { FeedbackDelivery } from './babysit';
import { diffCommentBlocks } from './diff-comment-prompt';
import { feedbackPrompt } from './feedback-prompt';
import { findMergeRequest, isPageOf, mergeRequestForge, mergeRequestNamed, viewMergeRequest, type FoundMergeRequest } from '../projects/merge-requests';
import type { LoomDatabase } from '../storage/database';
import type { EventsTable, Schema, SessionsTable } from '../storage/schema';
import { Topic } from '../topic';
import { WorkingCopyDiff } from './diff';
import { createWorktree, findWorktree, listBranches, listFiles, pathExists, removeWorktree, unsavedWork, type GitEnvironment } from './working-copies';
import { capToolOutput } from './tool-output';
import { checkAnswer } from '../../shared/answers';
import { classifyApproval, mayPush, type ApprovalContext, type ApprovalVerdict } from './approvals';
import { checkAttachments, type Attachments } from './attachments';
import { recordSpan, recordTurn } from '../usage/usage';

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
  /** Whether a Session started now has auto-prompt on. */
  autoPromptDefault: () => boolean;
  /** The approval settings, as they are now. */
  approvals: () => ApprovalPolicy;
  /** How long a Working Session's agent may say nothing before the Session is stuck, as the setting is now. */
  stuckAfterMs: () => number;
  /** The models the agent offers in the Project's checkout (see `projects.models`); may reject when they can't be listed now. */
  models: (projectId: number) => Promise<ModelChoice[]>;
  /** Where the files attached to messages are kept. */
  attachments: Attachments;
}

/** What the Session service needs from an Environment: its agent's, and git. */
export interface SessionEnvironment extends AgentEnvironment, GitEnvironment {
  /** Resolves once the Environment is connected, waiting while it starts; rejects if it can't start. */
  ready(): Promise<void>;
  /** Starts the Environment again if it failed to start. */
  restart(): Promise<void>;
  /** Its temp directory, where agents work freely: `/tmp`, or `%TEMP%` on native Windows. */
  tempDir(): string;
  /** The bridge binary's path there, which runs Loom's MCP server; undefined if the bridge didn't say. */
  bridgeExecutable(): string | undefined;
}

/** What a Session whose agent ended with its Environment's bridge shows. */
export const ENVIRONMENT_RESTARTED = 'Environment restarted';

const MAX_TITLE_LENGTH = 80;

/** How often streaming agent text is checkpointed to the database. */
export const CHECKPOINT_MS = 1000;

/** What Continue sends the agent of a run Loom quit or crashed during. */
export const CONTINUE_PROMPT = 'Loom stopped while you were working. Continue where you left off.';

/** How long a Session waits with nothing in flight before its agent's process is stopped; its next prompt resumes it. */
export const IDLE_STOP_MS = 10 * 60_000;

/** What to do once a run the user interrupted has ended: send the queued message `sendNow`, or else stop. */
type Interruption = { sendNow?: number };
/**
 * The agent events that always set the Session's status themselves: a stuck
 * run they come in isn't Working again first. A trust or Approval request
 * isn't one: Loom may answer it itself, the agent going on.
 */
const SETTLING_EVENTS = new Set<AgentEvent['type']>(['run-settled', 'run-failed', 'closed', 'question-asked']);
type StatusChange = { status: SessionStatus; waitingReason?: WaitingReason; error?: string };
const NO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const NO_USAGE: SessionUsage = { tokens: 0, reportedCost: 0, workingMs: 0 };
/** The stretch of time a Session is in, for the dashboard: since when. */
type OpenSpan = { kind: 'run' | 'wait'; since: number; carried?: number };
type Write = (trx: Transaction<Schema>) => Promise<unknown>;
/** What the user sends the agent: text, and the files attached to it, stored already. */
type Message = { text: string; attachments?: Attachment[] };
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
  /** The pending idle stop of each Waiting Session's agent (IDLE_STOP_MS). */
  private readonly idleStops = new Map<number, TimerHandle>();
  /** The stuck watchdog of each Working Session: it fires once the agent has said nothing for `stuckAfterMs`. */
  private readonly stuckWatches = new Map<number, TimerHandle>();
  /** Idle agents still closing, by Session: the next one opened for the Session waits for the process to exit, so two never share its conversation. */
  private readonly closing = new Map<number, Promise<void>>();
  /** The last diff summary worked out per Session and `uncommittedOnly`, which `diffFile` looks its file up in. */
  private readonly diffSummaries = new Map<string, DiffSummary>();
  /**
   * Archives running, by Session: an agent that opens meanwhile waits for the
   * outcome, and is closed if the Session was archived; its closing isn't a failure.
   */
  private readonly archiving = new Map<number, Promise<unknown>>();
  /** What each Session's agent asked and waits on: the agent's request id, by transcript item id. */
  private readonly asks = new Map<number, Map<number, string>>();
  /**
   * The approval categories the user approved for the rest of each Session
   * ("for this Session"), while the Client runs.
   */
  private readonly grants = new Map<number, Set<ApprovalCategory>>();
  /** The tool calls approved in each Session's current run: more asks for the same call go through. */
  private readonly approvedCalls = new Map<number, Set<string>>();
  /** What the user said on denying Approval requests, sent to the agent as the next prompt once its run ends. */
  private readonly denyMessages = new Map<number, string>();
  /** Model and Effort changes in flight, by Session: a prompt given meanwhile waits for them. */
  private readonly switching = new Map<number, Promise<void>>();
  /** The id the next queued message gets: ids are given here, so a message is queued at once. */
  private nextQueuedId = 1;
  /**
   * The runs the user interrupted, by Session, until they end: with Stop, or
   * to send the queued message `sendNow`.
   */
  private readonly interrupting = new Map<number, Interruption>();
  /** Writes made in this tick, committed together in one transaction. */
  private pending: Write[] = [];
  /** Transactions, one after another so they land in order. */
  private saving: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  /** Worktrees being made, by Project, one after another so names can't race. */
  private creatingWorktree = new Map<number, Promise<unknown>>();
  /** Existing worktrees a starting Session has taken, until its record exists. */
  private claimed = new Set<string>();
  /**
   * How each Session's Merge request was linked: on which branch, and whether
   * by hand (the user or the agent's tool) rather than found on the branch.
   */
  private readonly mergeRequestLinks = new Map<number, MergeRequestLinkage>();
  /** Each Session's latest Merge request lookup: an earlier one still going is stale. */
  private readonly mergeRequestLookups = new Map<number, number>();
  /** What is being looked up after each Session's last turn, until it is done. */
  private readonly afterTurns = new Map<number, Promise<unknown>>();
  /** The calls of Loom's `link_merge_request` tool in each Session's run, until they complete. */
  private readonly linkCalls = new Map<number, Set<string>>();
  /** The cost each Session's agent last reported for its conversation, which its next turn's cost is counted from. */
  private readonly reportedCosts = new Map<number, number>();
  /** The auto-prompts each Session has been sent since the user's last message; none if absent. */
  private readonly autoPromptsInARow = new Map<number, number>();
  /** The model each Session's run goes with, as Loom set it. */
  private readonly runModels = new Map<number, string>();
  /** The run or wait each Session is in, while the Client runs (see spanOf). */
  private readonly spans = new Map<number, OpenSpan>();

  private constructor(private readonly options: SessionsOptions) {}

  /**
   * The Session service, with the Sessions in the database. A Session that
   * was Working when the Client last stopped has lost its run: it is Waiting
   * as interrupted, its agent's last text as far as it was saved, and
   * nothing resumes it until the user says so (Continue, or a reply).
   */
  static async load(options: SessionsOptions): Promise<Sessions> {
    const sessions = new Sessions(options);
    const rows = await options.db.selectFrom('sessions').selectAll().execute();
    for (const row of rows) {
      sessions.sessions.set(row.id, sessions.withCapabilities(fromRow(row)));
      if (row.merge_request_branch !== null) sessions.mergeRequestLinks.set(row.id, { branch: row.merge_request_branch, byHand: row.merge_request_by_hand === 1 });
      if (row.reported_cost !== null) sessions.reportedCosts.set(row.id, row.reported_cost);
      if (row.auto_prompts_in_a_row > 0) sessions.autoPromptsInARow.set(row.id, row.auto_prompts_in_a_row);
    }
    await sessions.loadUsage();
    const queued = await options.db.selectFrom('queued_messages').selectAll().orderBy('id').execute();
    for (const { id, session_id, text, attachments } of queued) {
      const session = sessions.sessions.get(session_id);
      const message: QueuedMessage = attachments ? { id, text, attachments: JSON.parse(attachments) as Attachment[] } : { id, text };
      if (session) sessions.sessions.set(session_id, { ...session, queue: [...(session.queue ?? []), message] });
      sessions.nextQueuedId = Math.max(sessions.nextQueuedId, id + 1);
    }
    // A wait for the user goes on from now, as the same wait, without the time Loom was closed: a
    // Session left finished is waiting again; one left on a question or Approval request ends its wait
    // as it's interrupted just below.
    const now = options.clock.now();
    const carried = new Map(rows.map((row) => [row.id, row.wait_carried_ms]));
    for (const session of sessions.list()) {
      if (spanOf(session.status, session.waitingReason) === 'wait') sessions.spans.set(session.id, { kind: 'wait', since: now, carried: carried.get(session.id) || undefined });
    }
    for (const session of sessions.list()) {
      // A Session waiting on a question or an Approval request, or stuck, was mid-run too: what the agent asked went with its process.
      if (session.status !== 'working' && !(session.status === 'waiting' && (session.waitingReason === 'question' || session.waitingReason === 'approval' || session.waitingReason === 'stuck'))) continue;
      await sessions.loadTranscript(session.id);
      sessions.endRun(session.id);
      sessions.addItem(session.id, { kind: 'interruption', by: 'quit' });
      sessions.setStatus(session.id, { status: 'waiting', waitingReason: 'interrupted' });
    }
    await sessions.flush();
    return sessions;
  }

  /** Each Session's usage so far, from its usage buckets and its runs. */
  private async loadUsage(): Promise<void> {
    const { db } = this.options;
    const [buckets, runs] = await Promise.all([
      db
        .selectFrom('usage_buckets')
        // totalTokens, in SQL.
        .select((eb) => [
          'session_id',
          eb.fn.sum<number>(eb(eb(eb(eb('input_tokens', '+', eb.ref('output_tokens')), '+', eb.ref('cache_read_tokens')), '+', eb.ref('cache_write_tokens')), '+', eb.ref('reasoning_tokens'))).as('tokens'),
          eb.fn.sum<number>('cost').as('cost'),
        ])
        .groupBy('session_id')
        .execute(),
      db
        .selectFrom('session_spans')
        .select((eb) => ['session_id', eb.fn.sum<number>(eb('ended_at', '-', eb.ref('started_at'))).as('ms')])
        .where('kind', '=', 'run')
        .groupBy('session_id')
        .execute(),
    ]);
    const usage = new Map<number, SessionUsage>();
    const usageFor = (id: number) => usage.get(id) ?? usage.set(id, { ...NO_USAGE }).get(id)!;
    for (const b of buckets) Object.assign(usageFor(b.session_id), { tokens: Number(b.tokens), reportedCost: Number(b.cost) });
    for (const r of runs) usageFor(r.session_id).workingMs = Number(r.ms);
    for (const [id, session] of this.sessions) this.sessions.set(id, { ...session, usage: usage.get(id) ?? { ...NO_USAGE } });
  }

  /**
   * What a worktree Session on the Project can start from, once `origin` is
   * fetched, leaving out the worktrees Sessions that aren't archived work in.
   */
  async branches(projectId: number): Promise<Branches> {
    const project = this.options.project(projectId);
    if (!project) throw new Error(`unknown Project ${projectId}`);
    const environment = this.environmentOf({ projectId });
    await environment.ready();
    const branches = await listBranches(environment, project.checkout.path);
    return { ...branches, worktrees: branches.worktrees.filter((worktree) => !this.claimed.has(worktree.path) && !this.sessionIn(worktree.path)) };
  }

  /** The Session that isn't archived working in the worktree at `path`, if any. */
  private sessionIn(path: string): Session | undefined {
    return [...this.sessions.values()].find((session) => session.status !== 'archived' && session.workingCopy.kind === 'worktree' && session.workingCopy.path === path);
  }

  /** The files in the Session's working copy, for @-mentions. */
  files(id: number): Promise<string[]> {
    const session = this.get(id);
    if (session.status === 'archived') throw new Error('This Session is archived.');
    if (session.worktreeMissing) throw new Error("This Session's worktree is missing; it can only be archived.");
    return this.listFilesIn(session.projectId, session.workingCopy.path);
  }

  /**
   * The files in the Project's checkout, or at `ref` there (a branch, as git
   * names it), for @-mentions before a Session exists.
   */
  projectFiles(projectId: number, ref?: string): Promise<string[]> {
    const project = this.options.project(projectId);
    if (!project) throw new Error(`unknown Project ${projectId}`);
    if (ref !== undefined && (typeof ref !== 'string' || !ref || ref.startsWith('-'))) throw new Error('A ref needs a name.');
    return this.listFilesIn(projectId, project.checkout.path, ref);
  }

  private async listFilesIn(projectId: number, path: string, ref?: string): Promise<string[]> {
    const environment = this.environmentOf({ projectId });
    await environment.ready();
    return listFiles(environment, path, MAX_LISTED_FILES, ref);
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
    checkPick(params);
    const { existing } = params;
    if (existing !== undefined) {
      checkExisting(existing);
      if (workingCopy !== 'worktree') throw new Error('Only a worktree Session works on an existing branch or worktree.');
      if (params.branch !== undefined || params.base !== undefined) throw new Error("A Session on an existing branch or worktree doesn't name or base a new one.");
    }
    const newAttachments = checkAttachments(params.attachments);
    const text = promptText(issue ? [issuePrompt(issue), params.prompt.trim()].filter(Boolean).join('\n\n') : params.prompt, { attached: newAttachments.length > 0 });
    let path = project.checkout.path;
    let branch: string | null = null;
    if (existing && 'worktree' in existing) {
      const found = await this.oneAtATime(projectId, async () => {
        const worktree = await findWorktree(this.environmentOf({ projectId }), project.checkout.path, existing.worktree, project.name);
        if (this.claimed.has(worktree.path)) throw new Error(`Another Session is starting in ${worktree.path}.`);
        const user = this.sessionIn(worktree.path);
        if (user) throw new Error(`The Session "${user.title}" works in ${worktree.path}; archive it first, or reply to it there.`);
        // Claimed until this Session's record exists, so a second start can't take it meanwhile.
        this.claimed.add(worktree.path);
        return worktree;
      });
      path = found.path;
      branch = found.branch ?? null;
    } else if (workingCopy === 'worktree') {
      const environment = this.environmentOf({ projectId });
      ({ path, branch } = await this.oneAtATime(projectId, () =>
        createWorktree(environment, {
          checkout: project.checkout.path,
          projectName: project.name,
          branchPrefix: project.branchPrefix,
          branch: existing
            ? { existing: existing.branch }
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
      title: titleOf(text || newAttachments[0]!.name),
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
      merge_request_branch: null,
      merge_request_by_hand: 0,
      model: params.model ?? null,
      // An Effort level is the model's: without a model picked, it is the agent's default model's.
      effort: params.effort ?? null,
      context_used: null,
      context_size: null,
      created_at: now,
      updated_at: now,
      reported_cost: 0,
      wait_carried_ms: 0,
      archived_at: null,
      stuck_count: 0,
      merge_request_state: null,
      auto_prompt: this.options.autoPromptDefault() ? 1 : 0,
      auto_prompts_in_a_row: 0,
      babysit_off: 0,
    };
    let id: number;
    try {
      ({ id } = await this.options.db.insertInto('sessions').values(values).returning('id').executeTakeFirstOrThrow());
      this.sessions.set(id, { ...this.withCapabilities(fromRow({ id, ...values })), usage: { ...NO_USAGE, workingSince: now } });
      this.spans.set(id, { kind: 'run', since: now });
      this.reportedCosts.set(id, 0);
    } finally {
      this.claimed.delete(path);
    }
    let attachments: Attachment[] | undefined;
    try {
      if (newAttachments.length) attachments = await this.options.attachments.store(id, newAttachments);
    } catch (error) {
      // A Session without its first message would be nothing to come back to: undone, with the worktree made for it.
      this.sessions.delete(id);
      await this.options.db
        .deleteFrom('sessions')
        .where('id', '=', id)
        .execute()
        .catch((e: unknown) => console.error(`could not undo Session ${id}:`, e));
      await this.options.attachments.remove(id).catch(() => {});
      if (workingCopy === 'worktree' && !(existing && 'worktree' in existing)) await this.undoWorktree(projectId, path, existing ? undefined : branch);
      throw new Error(`Loom could not keep the attachments: ${(error as Error).message}`);
    }
    const message = messageOf({ text, attachments });
    this.transcripts.set(id, new Topic<TranscriptItem[]>([]));
    this.addItem(id, { kind: 'user', ...message });
    this.publish();
    void this.lookUpBranch(id);
    void this.run(id, message);
    return this.sessions.get(id)!;
  }

  /** Removes a worktree made for a Session that couldn't start, and the branch made with it, if any. */
  private async undoWorktree(projectId: number, path: string, newBranch: string | null | undefined): Promise<void> {
    const environment = this.environmentOf({ projectId });
    const checkout = this.options.project(projectId)!.checkout.path;
    try {
      await removeWorktree(environment, { checkout, path, force: true });
      if (newBranch) await exec(environment.request, 'git', ['-C', checkout, 'branch', '-D', newBranch], GIT_TIMEOUT_MS);
    } catch (error) {
      console.error(`could not remove the worktree at ${path}:`, error);
    }
  }

  async send({ id, prompt, attachments: attached, comments }: Commands['sessions.send']['params']): Promise<void> {
    const newAttachments = checkAttachments(attached);
    const text = promptText(prompt, { attached: newAttachments.length > 0, comments });
    this.get(id);
    await this.loadTranscript(id);
    // A change of model or Effort made just before goes first: the marker, then this prompt on it.
    await this.switched(id);
    // A prompt that can't go is turned down before its attachments are kept.
    if (this.get(id).status !== 'working' && !this.isStuck(id)) this.assertCanReply(id);
    const attachments = newAttachments.length ? await this.options.attachments.store(id, newAttachments) : undefined;
    const message = messageOf({ text, attachments });
    this.resetAutoPrompts(id);
    if (this.get(id).status === 'working') return void this.enqueue(id, message);
    // A stuck run gives way to the message, as with Send now; one sent meanwhile waits its turn behind it.
    if (this.isStuck(id)) {
      const queued = this.enqueue(id, message);
      if (this.interrupting.get(id)?.sendNow !== undefined) return;
      return this.interrupt(id, { sendNow: queued.id });
    }
    this.reply(id, message);
  }

  /** Sends `message` to a Waiting Session as the user's reply: it becomes Working. Its transcript must be read. */
  private reply(id: number, message: Message): void {
    this.assertCanReply(id);
    this.addItem(id, { kind: 'user', ...message });
    this.setStatus(id, { status: 'working' });
    void this.run(id, message);
  }

  /** Drops a message from the Session's queue. */
  removeQueued({ id, queuedId }: { id: number; queuedId: number }): void {
    if (!this.dequeue(id, queuedId)) throw new Error('There is no such queued message.');
  }

  /**
   * Interrupts the Session's run without sending its queue: once the run
   * ends, the Session is Waiting (stopped), its queue kept.
   */
  async stop({ id }: { id: number }): Promise<void> {
    this.get(id);
    await this.loadTranscript(id);
    if (!this.inRun(id)) throw new Error('The agent is not working on this Session.');
    this.interrupt(id, {});
  }

  /**
   * Asks the Session's agent to end its run; what happens once it has is
   * `interruption`. An agent still starting is never prompted.
   */
  private interrupt(id: number, interruption: Interruption): void {
    this.interrupting.set(id, interruption);
    // Asked again each time: the user stopping twice may be an agent that didn't hear it.
    this.live.get(id)?.cancel();
  }

  /** Ends the run the user interrupted: sends the message they asked for, or else waits as stopped. */
  private interrupted(id: number): void {
    const { sendNow } = this.interrupting.get(id)!;
    this.denyMessages.delete(id);
    this.endRun(id);
    const message = sendNow === undefined ? undefined : this.dequeue(id, sendNow);
    this.addItem(id, { kind: 'interruption', by: message ? 'send-now' : 'stop' });
    this.afterTurn(id);
    if (message) return this.sendNext(id, messageOf(message));
    this.setStatus(id, { status: 'waiting', waitingReason: 'stopped' });
  }

  /**
   * Sends the queued message `queuedId` now: a run going is interrupted
   * first, and the message sent once it has ended; a Waiting Session is sent
   * it as its reply. The rest of the queue stays.
   */
  async sendNow({ id, queuedId }: { id: number; queuedId: number }): Promise<void> {
    this.get(id);
    await this.loadTranscript(id);
    await this.switched(id);
    const message = this.queued(id, queuedId);
    if (this.inRun(id)) return this.interrupt(id, { sendNow: message.id });
    this.reply(id, messageOf(message));
    this.dequeue(id, message.id);
  }

  /** The queued message `queuedId`, which must be there. */
  private queued(id: number, queuedId: number): QueuedMessage {
    const message = this.get(id).queue?.find((m) => m.id === queuedId);
    if (!message) throw new Error('There is no such queued message.');
    return message;
  }

  /** Gives the queued message `queuedId` to the agent in the run going, for an agent that can be steered. */
  async steer({ id, queuedId }: { id: number; queuedId: number }): Promise<void> {
    this.get(id);
    await this.loadTranscript(id);
    const message = this.queued(id, queuedId);
    const agent = this.live.get(id);
    /** The agent's steer, throwing unless it can take the message now. */
    const steerable = () => {
      if (!this.options.adapter.canSteer || !agent?.steer) throw new Error(`${this.options.adapter.name} can't take a message mid-run: use Send now.`);
      if (this.get(id).status !== 'working' || this.interrupting.has(id) || this.live.get(id) !== agent) throw new Error('The agent is not working on this Session: use Send now.');
      return agent.steer.bind(agent);
    };
    // Checked before writing the files, which may take a while, and again after.
    steerable();
    const files = await this.deliver(id, message.attachments);
    // The run may have ended, or the message gone, while the files were written.
    const steer = steerable();
    this.queued(id, queuedId); // throws if it's gone
    this.dequeue(id, message.id);
    this.endStreaming(id);
    this.addItem(id, { kind: 'user', ...messageOf(message) });
    steer({ text: message.text, files });
  }

  /**
   * Changes the model or Effort the Session's prompts run with, from the
   * next one, between runs only, with a marker in its timeline. A running
   * agent is switched at once, so it can turn down what it doesn't offer
   * before anything changes, and so offers the new model's Effort levels;
   * with none running, the change is checked against the checkout's models.
   * Changes go one at a time, and a prompt given meanwhile waits for them.
   */
  async setModel({ id, model, effort }: { id: number } & ModelPick): Promise<void> {
    this.get(id);
    checkPick({ model, effort });
    // Claimed at once, after the change before it, so changes go in the order they were made.
    const before = this.switching.get(id);
    const change = (async () => {
      await before?.catch(() => {});
      await this.loadTranscript(id);
      await this.switchModel(id, { model, effort });
    })();
    this.switching.set(id, change);
    try {
      await change;
    } finally {
      if (this.switching.get(id) === change) {
        this.switching.delete(id);
        // Talking to the agent counts as use: its 10 minutes start again.
        this.watchIdle(id);
      }
    }
  }

  /** Resolves once the Session's model and Effort changes in flight are done, however they end. */
  private async switched(id: number): Promise<void> {
    while (this.switching.has(id)) await this.switching.get(id)!.catch(() => {});
  }

  private async switchModel(id: number, { model, effort }: ModelPick): Promise<void> {
    if (this.inRun(id)) throw new Error('The model and Effort change only between runs: wait for the agent to finish, or stop it.');
    // A change that could never apply is refused, as the prompt it would apply to is.
    this.assertCanPrompt(id);
    const session = this.get(id);
    const was = { model: session.agentConfig?.model, effort: session.agentConfig?.effort };
    const running = { model: session.model ?? was.model, effort: session.effort ?? was.effort };
    const newModel = model !== undefined && model !== running.model;
    // A new model starts on its own default Effort, unless one is picked with it.
    const newEffort = effort !== undefined && (newModel || effort !== running.effort);
    if (!newModel && !newEffort) return;
    const next: ModelPick = { model: newModel ? model : session.model, effort: newEffort ? effort : newModel ? undefined : session.effort };
    const agent = this.live.get(id);
    if (agent) {
      try {
        await agent.configure(next);
      } catch (error) {
        // Switched to the model but not to its Effort: back to what it ran with, so it shows what the Session runs.
        // Should that fail too, the next prompt still sets what the Session runs, if a model was picked before.
        await agent.configure(was).catch(() => {});
        throw error;
      }
    } else {
      // An Effort level alone is checked against the model the Session runs on.
      await this.checkOffered(session.projectId, { model: next.model ?? running.model, effort: next.effort });
    }
    if (this.get(id).status === 'archived') return;
    this.update(id, { model: next.model, effort: next.effort });
    this.save(id, { model: next.model ?? null, effort: next.effort ?? null });
    this.addItem(id, withoutUndefined({ kind: 'model' as const, model: newModel ? model : undefined, effort: newEffort ? effort : undefined }));
  }

  /**
   * Rejects a model, or a model's Effort level, the agent doesn't offer in
   * the Project's checkout. What can't be known (the models can't be listed,
   * or the agent's own default model) is left for the agent to turn down.
   */
  private async checkOffered(projectId: number, { model, effort }: ModelPick): Promise<void> {
    if (model === undefined) return;
    const offered = await this.options.models(projectId).catch(() => undefined);
    if (!offered) return;
    const found = offered.find((m) => m.id === model);
    const name = this.options.adapter.name;
    if (!found) throw new Error(`${name} doesn't offer ${model} in this Project.`);
    if (effort !== undefined && !(found.efforts ?? []).includes(effort)) throw new Error(`${name} offers no Effort ${effort} for ${model}.`);
  }

  /** Puts a message at the end of the Session's queue. */
  private enqueue(id: number, { text, attachments }: Message): QueuedMessage {
    const message: QueuedMessage = withoutUndefined({ id: this.nextQueuedId++, text, attachments });
    this.update(id, { queue: [...(this.get(id).queue ?? []), message] });
    const row = { id: message.id, session_id: id, text, attachments: attachments ? JSON.stringify(attachments) : null, created_at: this.options.clock.now() };
    this.write((trx) => trx.insertInto('queued_messages').values(row).execute());
    return message;
  }

  /** Takes the message `queuedId` (or else the first) out of the Session's queue; undefined if there is none. */
  private dequeue(id: number, queuedId?: number): QueuedMessage | undefined {
    const queue = this.get(id).queue ?? [];
    const message = queuedId === undefined ? queue[0] : queue.find((m) => m.id === queuedId);
    if (!message) return undefined;
    const rest = queue.filter((m) => m !== message);
    this.update(id, { queue: rest.length ? rest : undefined });
    this.write((trx) => trx.deleteFrom('queued_messages').where('id', '=', message.id).execute());
    return message;
  }

  /** The Session, with what its agent can do. */
  private withCapabilities(session: Session): Session {
    return this.options.adapter.canSteer ? { ...session, canSteer: true } : session;
  }

  /**
   * Sends a Session Waiting on an error its last prompt again, if that went
   * unanswered, starting its Environment again first if that failed to start.
   */
  async retry({ id }: { id: number }): Promise<void> {
    this.get(id);
    const items = (await this.loadTranscript(id)).value;
    await this.switched(id);
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
    void this.run(id, messageOf(prompt));
  }

  /** Has the agent go on with the run Loom quit during: sends it CONTINUE_PROMPT, resuming its conversation. */
  async continue({ id }: { id: number }): Promise<void> {
    this.get(id);
    await this.loadTranscript(id);
    await this.switched(id);
    const session = this.get(id);
    if (session.status !== 'waiting' || session.waitingReason !== 'interrupted') throw new Error('There is nothing to continue: send a new prompt instead.');
    this.reply(id, { text: CONTINUE_PROMPT });
  }

  /** Sends the agent the Merge request prompt shortcut. */
  async requestMergeRequest({ id }: { id: number }): Promise<void> {
    const { kind } = mergeRequestForge(this.options.project(this.get(id).projectId)?.forge);
    const branch = await this.currentBranch(id);
    if (!branch) throw new Error("This Session's working copy isn't on a branch.");
    if (branch === (await this.defaultBranch(id))) {
      throw new Error(`This Session is on ${branch}, the default branch. A Merge request needs a branch of its own.`);
    }
    await this.send({ id, prompt: mergeRequestPrompt(FORGE_CLI[kind]) });
  }

  /**
   * Links the Merge request `mergeRequest` names (its number, `#12`, `!12`, or
   * its URL) to the Session, once the Forge says it is open.
   */
  async linkMergeRequest({ id, mergeRequest }: { id: number; mergeRequest: string }): Promise<void> {
    const session = this.get(id);
    if (session.status === 'archived') throw new Error('This Session is archived.');
    const forge = this.options.project(session.projectId)?.forge;
    // Checked before anything runs: a Forge that's off says so first.
    mergeRequestForge(forge);
    const named = mergeRequestNamed(mergeRequest);
    if (!named) throw new Error('Name a Merge request by its number, such as 12, or by its URL.');
    const branch = await this.currentBranch(id);
    if (branch && branch === (await this.defaultBranch(id))) throw new Error(`This Session is on ${branch}, the default branch, which has no Merge request.`);
    const found = await viewMergeRequest(this.environmentOf(session).request, forge, session.workingCopy.path, named.number);
    if (named.url && !isPageOf(named.url, found.url)) throw new Error(`${named.url} isn't a Merge request of this Project's repository.`);
    if (found.state !== 'open') throw new Error(`That Merge request is ${found.state}: only an open one can be linked.`);
    await this.loadTranscript(id);
    if (this.get(id).status === 'archived') return;
    this.setMergeRequest(id, found, { branch: branch ?? found.branch, byHand: true });
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

  /**
   * Decides the Approval request in transcript item `itemId`: approves it
   * once, or approves it and its category for the rest of the Session, whose
   * later requests Loom then answers itself; or denies it, `message` going
   * to the agent once its run ends.
   */
  async approve({ id, itemId, decision, message }: { id: number; itemId: number; decision: ApprovalDecision; message?: string }): Promise<void> {
    this.get(id);
    const item = (await this.loadTranscript(id)).value[itemId];
    if (item?.kind !== 'approval') throw new Error('There is no such Approval request in this Session.');
    const requestId = this.asks.get(id)?.get(itemId);
    if (item.state !== 'asked' || requestId === undefined) throw new Error('The agent is no longer asking for this approval.');
    if (decision !== 'once' && decision !== 'session' && decision !== 'deny') throw new Error(`"${String(decision)}" is not a decision on an Approval request.`);
    if (decision === 'session' && item.defaultBranch) throw new Error(`A push to ${item.defaultBranch}, the default branch, always asks: approve it once, or deny it.`);
    if (decision === 'session' && !item.category) throw new Error("Loom can't tell what kind of action this is, so it can only be approved once.");
    if (message !== undefined && typeof message !== 'string') throw new Error('A message to the agent must be text.');
    const agent = this.live.get(id);
    if (decision === 'deny') {
      const said = message?.trim();
      if (said) {
        this.denyMessages.set(id, [this.denyMessages.get(id), said].filter(Boolean).join('\n\n'));
        this.resetAutoPrompts(id);
      }
      this.settleAsk(id, itemId, { ...item, state: 'denied', ...(said ? { message: said } : {}) });
      agent?.answer(requestId, { kind: 'approval', approved: false });
      return;
    }
    this.approveCall(id, item.toolCallId);
    this.settleAsk(id, itemId, { ...item, state: decision === 'session' ? 'approved-session' : 'approved' });
    agent?.answer(requestId, { kind: 'approval', approved: true });
    if (decision !== 'session') return;
    const category = item.category!;
    const grants = this.grants.get(id) ?? new Set();
    grants.add(category);
    this.grants.set(id, grants);
  }

  /** Records that the user approved tool call `toolCallId`'s card: more asks for it go ahead. */
  private approveCall(id: number, toolCallId: string | undefined): void {
    if (toolCallId === undefined) return;
    let calls = this.approvedCalls.get(id);
    if (!calls) this.approvedCalls.set(id, (calls = new Set()));
    calls.add(toolCallId);
  }

  /**
   * The agent asks approval for `action`. Loom answers it itself, once, when
   * its policy allows it: the category is set to Allow or approved for the
   * Session, or it is part of a tool call already approved. Otherwise it is
   * an Approval request card: Waiting (approval), with no timeout.
   */
  private async askApproval(id: number, requestId: string, action: ApprovalAction): Promise<void> {
    const agent = this.live.get(id);
    const session = this.get(id);
    const environment = this.environmentOf(session);
    const context: ApprovalContext = {
      workingCopy: session.workingCopy.path,
      tempDir: environment.tempDir(),
      home: environment.home(),
      mergeRequest: session.mergeRequest?.number,
    };
    if (mayPush(action)) {
      context.currentBranch = await this.currentBranch(id).catch(() => undefined);
      context.defaultBranch = await this.defaultBranch(id).catch(() => undefined);
      // The run may have ended while git answered.
      if (this.live.get(id) !== agent || !this.inRun(id)) return;
    }
    const goAhead = () => agent?.answer(requestId, { kind: 'approval', approved: true });
    // The user approved this call's card, which showed all of it.
    if (action.toolCallId !== undefined && this.approvedCalls.get(id)?.has(action.toolCallId)) return goAhead();
    const policy = this.options.approvals();
    const goes = (v: ApprovalVerdict) => v.allowed || (!!v.category && !v.defaultBranch && (policy[v.category] === 'allow' || !!this.grants.get(id)?.has(v.category)));
    const verdicts = classifyApproval(action, context);
    // Most asking first: the card is about the first part that can't go ahead.
    const blocking = verdicts.find((v) => !goes(v));
    if (!blocking) return goAhead();
    const { category, defaultBranch } = blocking.allowed ? {} : blocking;
    const detail = action.command ?? (action.paths.join('\n') || action.title);
    this.ask(
      id,
      requestId,
      withoutUndefined({ kind: 'approval' as const, toolCallId: action.toolCallId, title: action.title, tool: action.tool, detail, category, defaultBranch, state: 'asked' as const }),
      'approval',
    );
  }

  /** Denies the Session's Approval requests still asked, as archiving it does. */
  private denyApprovals(id: number): void {
    const asked = this.asks.get(id);
    if (!asked) return;
    const agent = this.live.get(id);
    for (const [seq, requestId] of [...asked.entries()]) {
      const card = this.transcript(id).value[seq];
      if (card?.kind !== 'approval') continue;
      asked.delete(seq);
      this.replaceItem(id, { ...card, state: 'denied' });
      agent?.answer(requestId, { kind: 'approval', approved: false });
    }
    if (asked.size === 0) this.asks.delete(id);
  }

  /** Records the user's response to an ask; with nothing else asked, the Session is Working again. */
  private settleAsk(id: number, itemId: number, settled: TranscriptItem): void {
    const asked = this.asks.get(id);
    asked?.delete(itemId);
    if (asked?.size === 0) this.asks.delete(id);
    this.replaceItem(id, settled);
    if (!this.asks.has(id)) this.setStatus(id, { status: 'working' });
  }

  /** Whether the Session's agent is mid-run: working, stuck, or waiting on the user's answer to something it asked. */
  private inRun(id: number): boolean {
    return this.get(id).status === 'working' || this.asks.has(id) || this.isStuck(id);
  }

  /** Whether the Session is Waiting as stuck: its run is still going, as far as Loom knows, but its agent has said nothing for a while. */
  private isStuck(id: number): boolean {
    const { status, waitingReason } = this.get(id);
    return status === 'waiting' && waitingReason === 'stuck';
  }

  /** Throws unless the Session can take a reply: its agent waits on no answer, and can be prompted. */
  private assertCanReply(id: number): void {
    if (this.inRun(id)) throw new Error("The agent is waiting for an answer to what it asked; answer or dismiss it first.");
    this.assertCanPrompt(id);
  }

  /** Throws if the Session can take no prompt: it is archived, or its worktree is gone. */
  private assertCanPrompt(id: number): void {
    const session = this.get(id);
    if (session.status === 'archived') throw new Error('This Session is archived.');
    if (session.worktreeMissing) throw new Error("This Session's worktree is missing; it can only be archived.");
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
      return await pathExists(this.environmentOf(session), session.workingCopy.path);
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
      // Archiving counts as Deny: the agent hears it before it stops.
      this.denyApprovals(id);
      this.markArchived(id);
      await this.stopAgent(id);
      return { archived: true };
    }
    // The check runs with the agent alive, so Cancel on the warning leaves the Session as it was.
    if (!discard && (await pathExists(environment, worktree))) {
      const work = await unsavedWork(environment, worktree);
      if (work) return { archived: false, unsavedWork: work };
    }
    // Confirmed: stop the agent, then look again in case it wrote in its last moment.
    // A run waiting on the user's answer ends here too, so it fails like a Working one.
    const evenIfWaiting = this.inRun(id);
    this.denyApprovals(id);
    await this.stopAgent(id);
    if (!discard && (await pathExists(environment, worktree))) {
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
    this.denyMessages.delete(id);
    if (this.get(id).queue) {
      this.update(id, { queue: undefined });
      this.write((trx) => trx.deleteFrom('queued_messages').where('session_id', '=', id).execute());
    }
    this.setStatus(id, { status: 'archived' });
    this.update(id, { worktreeMissing: undefined, diffStat: undefined });
    void this.lookUpMergeRequestState(id);
    for (const key of [`${id}:true`, `${id}:false`]) this.diffSummaries.delete(key);
  }

  /** Says what Babysit last saw of the Session's Merge request. */
  setBabysit(id: number, status: BabysitStatus | undefined): void {
    this.update(id, { babysit: status });
  }

  /** Records the Merge request's state, as Babysit found it. */
  setMergeRequestState(id: number, state: MergeRequestState): void {
    this.save(id, { merge_request_state: state });
    this.update(id, { mergeRequestState: state });
  }

  /**
   * Archives the Session, its Merge request merged or closed as Babysit
   * found it, with a card saying so; one closed without merging is left
   * unread, for the user to notice. A worktree with uncommitted changes or
   * unpushed commits holds the archive back: the Session goes Waiting
   * (`unsaved-work`) instead. A checkout Session's checkout is never looked
   * at, as for any archive. False if it must wait: the agent is mid-run, or
   * asking the user.
   */
  async endMergeRequest(id: number, state: EndedMergeRequestState): Promise<boolean> {
    await this.loadTranscript(id);
    if (this.shuttingDown) return false;
    if (this.inRun(id)) return false;
    // The turn just ended may have opened another Merge request on the branch, which takes over.
    const ended = this.get(id).mergeRequest;
    await this.afterTurns.get(id)?.catch(() => {});
    const { status, mergeRequest } = this.get(id);
    // Unlinked meanwhile, on the default branch, it still ended for this Session.
    if (this.shuttingDown || status === 'archived' || !ended || (mergeRequest && mergeRequest.url !== ended.url)) return true;
    if (this.inRun(id)) return false;
    const card = { kind: 'merge-request-ended' as const, number: ended.number, url: ended.url, state };
    let result: ArchiveResult;
    try {
      result = await this.archive({ id });
    } catch (error) {
      // The worktree couldn't be removed: the Session stays, saying why.
      const message = (error as Error).message;
      this.addItem(id, { ...card, archived: false });
      this.addItem(id, { kind: 'error', message });
      this.setStatus(id, { status: 'waiting', waitingReason: 'error', error: message });
      return true;
    }
    if (!result.archived) {
      this.addItem(id, { ...card, archived: false, unsavedWork: result.unsavedWork });
      this.setStatus(id, { status: 'waiting', waitingReason: 'unsaved-work' });
      return true;
    }
    this.addItem(id, { ...card, archived: true });
    if (state === 'closed') this.setUnread({ id, unread: true });
    return true;
  }

  /**
   * Adds what Babysit has for the Session to its transcript: quiet info cards,
   * and feedback. With auto-prompt on, the feedback goes to the agent as one
   * message, queued behind a run going, unless the Session can't be given it
   * unattended (see canAutoPrompt). Otherwise a feedback card makes the
   * Session Waiting (feedback). A Session waiting on an error or an
   * interrupted run stays so, for its Retry or Continue, with the card to
   * see. False, with nothing added, if it must wait: the agent is mid-run, or
   * asking the user.
   */
  async deliverFeedback(id: number, { info, feedback }: FeedbackDelivery): Promise<boolean> {
    await this.loadTranscript(id);
    // A change of model or Effort made just before goes first, as for any prompt.
    await this.switched(id);
    if (this.shuttingDown) return false;
    const session = this.get(id);
    if (session.status === 'archived') return true;
    const paused = !!session.autoPrompt && this.autoPromptsSoFar(id) >= MAX_AUTO_PROMPTS;
    const autoPrompt = !!feedback && !paused && canAutoPrompt(session);
    if (this.inRun(id) && !(autoPrompt && session.status === 'working')) return false;
    // A card landing mid-reply: what the agent says next starts below it.
    this.endStreaming(id);
    for (const entry of info) this.addItem(id, { kind: 'feedback-info', ...entry });
    if (!feedback) return true;
    if (autoPrompt) {
      this.addItem(id, { kind: 'feedback', ...feedback, state: 'sent' });
      this.setAutoPrompts(id, this.autoPromptsSoFar(id) + 1);
      const message = { text: feedbackPrompt(feedback, this.forgeCli(id)) };
      if (session.status === 'working') this.enqueue(id, message);
      else this.reply(id, message);
      return true;
    }
    this.addItem(id, { kind: 'feedback', ...feedback, state: 'new', ...(paused ? { paused } : {}) });
    if (session.waitingReason === 'error' || session.waitingReason === 'interrupted') {
      this.update(id, { unread: true });
      this.save(id, { unread: 1 });
    } else {
      this.setStatus(id, { status: 'waiting', waitingReason: 'feedback' });
    }
    return true;
  }

  /** Sends the agent the feedback on a card, and marks it sent. */
  async sendFeedback({ id, itemId }: { id: number; itemId: number }): Promise<void> {
    const card = (await this.loadTranscript(id)).value.find((item) => item.id === itemId);
    if (card?.kind !== 'feedback') throw new Error('There is no such feedback.');
    if (card.state === 'sent') throw new Error('This feedback has already been sent to the agent.');
    // Marked first: a second click must not send it twice.
    this.replaceItem(id, { ...card, state: 'sent' });
    try {
      await this.send({ id, prompt: feedbackPrompt(card, this.forgeCli(id)) });
    } catch (error) {
      this.replaceItem(id, card);
      throw error;
    }
  }

  /** Starts or stops Babysit watching the Session's Merge request. */
  setBabysitting({ id, on }: Commands['sessions.setBabysitting']['params']): void {
    if (typeof on !== 'boolean') throw new Error('Whether the Merge request is watched must be true or false.');
    if (this.get(id).status === 'archived') throw new Error('This Session is archived.');
    this.update(id, { babysitOff: on ? undefined : true });
    this.save(id, { babysit_off: on ? 0 : 1 });
  }

  /** Turns auto-prompt on or off for the Session, from the next feedback on. */
  setAutoPrompt({ id, on }: Commands['sessions.setAutoPrompt']['params']): void {
    if (typeof on !== 'boolean') throw new Error('Whether auto-prompt is on must be true or false.');
    this.assertCanPrompt(id);
    this.update(id, { autoPrompt: on || undefined });
    this.save(id, { auto_prompt: on ? 1 : 0 });
  }

  private autoPromptsSoFar(id: number): number {
    return this.autoPromptsInARow.get(id) ?? 0;
  }

  private setAutoPrompts(id: number, count: number): void {
    this.autoPromptsInARow.set(id, count);
    this.save(id, { auto_prompts_in_a_row: count });
  }

  /** A message from the user: auto-prompt may go again. */
  private resetAutoPrompts(id: number): void {
    if (this.autoPromptsSoFar(id) > 0) this.setAutoPrompts(id, 0);
  }

  /** The CLI to the Session's Forge, if its Project has one. */
  private forgeCli(id: number): string | undefined {
    const kind = this.options.project(this.get(id).projectId)?.forge.kind;
    return kind && FORGE_CLI[kind];
  }

  /**
   * Records what became of the archived Session's Merge request, merged,
   * closed or still open, as its Forge says, for the dashboard; keeps what
   * was known if the Forge can't say.
   */
  private async lookUpMergeRequestState(id: number): Promise<void> {
    const session = this.get(id);
    const project = this.options.project(session.projectId);
    if (!session.mergeRequest || project?.forge.state !== 'available') return;
    try {
      // In the Project's checkout: the worktree is gone.
      const found = await viewMergeRequest(this.environmentOf(session).request, project.forge, project.checkout.path, session.mergeRequest.number);
      if (this.shuttingDown || found.url !== session.mergeRequest.url) return;
      this.save(id, { merge_request_state: found.state });
      this.update(id, { mergeRequestState: found.state });
    } catch {
      return;
    }
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
   * prompt resumes the agent's conversation.
   */
  environmentRestarted(environmentId: string): void {
    if (this.shuttingDown) return;
    for (const id of [...this.live.keys()]) {
      if (this.options.project(this.get(id).projectId)?.checkout.environmentId !== environmentId) continue;
      this.live.delete(id);
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
    for (const handle of this.idleStops.values()) this.options.clock.clearTimeout(handle);
    this.idleStops.clear();
    for (const handle of this.stuckWatches.values()) this.options.clock.clearTimeout(handle);
    this.stuckWatches.clear();
    for (const id of [...this.checkpoints.keys()]) this.checkpoint(id);
    // Time while Loom is closed counts for nothing: a wait goes on once it starts again, a run is over.
    const now = this.options.clock.now();
    for (const [id, span] of [...this.spans]) {
      if (span.kind === 'run') this.trackSpan(id, undefined, now);
      else this.save(id, { wait_carried_ms: (span.carried ?? 0) + now - span.since });
    }
    this.spans.clear();
    await this.flush();
  }

  private async run(id: number, { text, attachments }: Message): Promise<void> {
    let agent = this.live.get(id);
    if (!agent) {
      try {
        agent = await this.open(id);
      } catch (error) {
        if (!(error instanceof ResumeRefused)) return this.fail(id, (error as Error).message);
        // That conversation is gone for good: the next prompt starts a new one rather than fail the same way.
        this.update(id, { agentSessionId: undefined });
        this.save(id, { agent_session_id: null });
        return this.fail(id, `${error.message}. The next prompt starts a new conversation.`);
      }
    }
    // The model and Effort picked apply from this prompt; an agent already on them isn't asked.
    await this.switched(id);
    const { model, effort } = this.get(id);
    try {
      await agent.configure({ model, effort });
    } catch (error) {
      this.fail(id, (error as Error).message);
      return;
    }
    // Usage is filed under the model the run goes with: the one picked, or else the agent's own.
    this.runModels.set(id, this.modelOf(id));
    let files: PromptFile[];
    try {
      files = await this.deliver(id, attachments);
    } catch (error) {
      this.fail(id, (error as Error).message);
      return;
    }
    // Interrupted while the agent started: the prompt never goes.
    if (this.interrupting.has(id)) return this.interrupted(id);
    agent.prompt({ text, files });
  }

  /** Writes the attachments into the Session's Environment, for its agent to read. */
  private async deliver(id: number, attachments: Attachment[] | undefined): Promise<PromptFile[]> {
    if (!attachments?.length) return [];
    const environment = this.environmentOf(this.get(id));
    try {
      return await this.options.attachments.deliver(id, attachments, { request: environment.request, tempDir: environment.tempDir() });
    } catch (error) {
      throw new Error(`Loom could not give ${this.options.adapter.name} the attachments: ${(error as Error).message}`);
    }
  }

  /**
   * Starts the Session's agent in its working copy, resuming the agent's
   * conversation if it has one, and records the agent's id for it.
   */
  private async open(id: number): Promise<AgentSession> {
    const session = this.get(id);
    const environment = this.environmentOf(session);
    await environment.ready();
    await this.closing.get(id);
    let opened: AgentSession | undefined;
    const executable = environment.bridgeExecutable();
    const agent = await this.options.adapter.open({
      environment,
      workingCopy: session.workingCopy.path,
      tempDir: environment.tempDir(),
      approvals: this.options.approvals(),
      ...(executable ? { loomTools: { command: executable, args: ['mcp'] } } : {}),
      ...(session.agentSessionId ? { resume: session.agentSessionId } : {}),
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
    // A new conversation's reported cost starts again from nothing.
    if (agent.id !== this.get(id).agentSessionId) {
      this.reportedCosts.set(id, 0);
      this.save(id, { reported_cost: 0 });
    }
    this.update(id, { agentSessionId: agent.id });
    this.save(id, { agent_session_id: agent.id });
    return agent;
  }

  private onAgentEvent(id: number, event: AgentEvent): void {
    // Usage counts however the run ended: cancelled, or by Archive.
    if (event.type === 'usage' && event.cost !== undefined) this.recordCost(id, event.cost);
    if (event.type === 'turn-usage') return this.recordUsage(id, event.tokens, 0);
    // The agent closing is Archive's own doing; Archive reports it if the Session stays.
    if (event.type === 'closed' && this.archiving.has(id)) return void this.live.delete(id);
    // An archived Session's agent is on its way out; nothing it says counts.
    if (this.shuttingDown || this.get(id).status === 'archived') return;
    // The agent said something: its stuck watchdog starts again, and a stuck run is going again.
    this.watchStuck(id);
    if (this.isStuck(id) && !SETTLING_EVENTS.has(event.type)) this.setStatus(id, { status: 'working' });
    // What an interrupted run asks is withdrawn as soon as it's asked.
    if (this.interrupting.has(id) && (event.type === 'question-asked' || event.type === 'trust-asked' || event.type === 'approval-asked')) return this.live.get(id)?.cancel();
    switch (event.type) {
      case 'run-started':
        return;
      case 'config':
        return this.update(id, { agentConfig: event.config });
      case 'commands':
        return this.update(id, { agentCommands: event.commands });
      case 'usage': {
        const context = { used: event.used, size: event.size };
        this.update(id, { context });
        return this.save(id, { context_used: context.used, context_size: context.size });
      }
      case 'text-delta':
        return this.appendText(id, 'agent', event.text);
      case 'thinking-delta':
        return this.appendText(id, 'thinking', event.text);
      case 'tool-started':
      case 'tool-updated':
        // A run's cards are settled when it ends; what comes after can't reopen them.
        if (!this.inRun(id)) return;
        this.recordTool(id, event);
        return this.noticeLinkCall(id, event);
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
      case 'approval-asked':
        if (!this.inRun(id)) return;
        return void this.askApproval(id, event.requestId, event.action).catch((error: unknown) => console.error(`could not ask Session ${id}'s approval:`, error));
      case 'run-settled': {
        if (this.interrupting.has(id)) return this.interrupted(id);
        const followUp = this.denyMessages.get(id);
        this.denyMessages.delete(id);
        this.endRun(id);
        this.afterTurn(id);
        // What the user said on denying goes to the agent as the next prompt.
        if (followUp) return this.sendNext(id, { text: followUp });
        // Then the queue, one message per run.
        const next = this.dequeue(id);
        if (next) return this.sendNext(id, messageOf(next));
        return this.setStatus(id, { status: 'waiting', waitingReason: 'finished' });
      }
      case 'run-failed':
        // An agent may fail the run it was asked to end; that's still the user's interruption.
        if (this.interrupting.has(id)) return this.interrupted(id);
        this.fail(id, event.error);
        return this.afterTurn(id);
      case 'closed':
        this.live.delete(id);
        return this.fail(id, event.error ?? `${this.options.adapter.name} stopped`);
    }
  }

  /**
   * Adds what the agent's reported cost went up by, now, to the Session's
   * usage: a cost reported cumulatively is counted as it changes, whichever
   * turn it came with and however that turn ended.
   */
  private recordCost(id: number, reported: number): void {
    const before = this.reportedCosts.get(id);
    if (reported === before) return;
    this.reportedCosts.set(id, reported);
    this.save(id, { reported_cost: reported });
    // Unknown before (a conversation from before Loom kept it): counted from here. One that went down was corrected: nothing to add.
    if (before !== undefined && reported > before) this.recordUsage(id, NO_TOKENS, reported - before);
  }

  /** Adds tokens and cost to the Session's bucket for today and the model its run went with. */
  private recordUsage(id: number, tokens: TokenCounts, cost: number): void {
    const session = this.get(id);
    const turn = {
      sessionId: id,
      projectId: session.projectId,
      projectName: this.options.project(session.projectId)?.name ?? `Project ${session.projectId}`,
      model: this.runModels.get(id) ?? this.modelOf(id),
      endedAt: this.options.clock.now(),
      tokens,
      cost,
    };
    this.write((trx) => recordTurn(trx, turn));
    const usage = this.usageOf(id);
    this.update(id, { usage: { ...usage, tokens: usage.tokens + totalTokens(tokens), reportedCost: usage.reportedCost + cost } });
  }

  private usageOf(id: number): SessionUsage {
    return this.get(id).usage ?? NO_USAGE;
  }

  /** The model the Session runs with: the one picked, or else the agent's own. */
  private modelOf(id: number): string {
    const session = this.get(id);
    return session.model ?? session.agentConfig?.model ?? 'default';
  }

  /** Once a turn has ended, however it did: reads the branch again, then the diff and the Merge request on it. */
  private afterTurn(id: number): void {
    const looking = this.lookUpBranch(id).then(() => Promise.all([this.lookUpDiffStat(id), this.lookUpMergeRequest(id)]));
    this.afterTurns.set(id, looking);
    void looking.finally(() => {
      if (this.afterTurns.get(id) === looking) this.afterTurns.delete(id);
    });
  }

  /** Sends `message` as the next run, the Session staying Working. */
  private sendNext(id: number, message: Message): void {
    this.addItem(id, { kind: 'user', ...message });
    this.setStatus(id, { status: 'working' });
    void this.run(id, message);
  }

  /** Shows what the agent asked as a card, and waits on the user: Waiting (question, or approval). */
  private ask(id: number, requestId: string, card: NewItem, reason: Extract<WaitingReason, 'question' | 'approval'> = 'question'): void {
    this.endStreaming(id);
    this.addItem(id, card);
    const seq = this.transcript(id).value.length - 1;
    let asked = this.asks.get(id);
    if (!asked) this.asks.set(id, (asked = new Map()));
    asked.set(seq, requestId);
    this.setStatus(id, { status: 'waiting', waitingReason: reason });
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

  /** Works out the Session's diff, and Session info's diff stat with it. */
  async diff(id: number, uncommittedOnly = false): Promise<DiffSummary> {
    const diff = await this.diffOf(id);
    if (!diff) return { available: false, reason: 'No diff available' };
    const summary = await diff.summary(uncommittedOnly);
    this.diffSummaries.set(`${id}:${uncommittedOnly}`, summary);
    if (!uncommittedOnly && this.get(id).status !== 'archived') this.recordDiffStat(id, WorkingCopyDiff.stat(filesOf(summary)));
    return summary;
  }

  /** The `origin/…` branches the Session's diff can be against, as the local refs have them. */
  async diffBases(id: number): Promise<string[]> {
    return (await this.liveDiffOf(id)).bases();
  }

  /** Records the start base the Session's diff is against, for its current branch. */
  async setDiffBase(id: number, base: string): Promise<void> {
    if (typeof base !== 'string') throw new Error('A diff base needs a name.');
    await (await this.liveDiffOf(id)).setBase(base);
    void this.lookUpDiffStat(id);
  }

  /** The diff of a Session that isn't archived, whose base can still change. */
  private async liveDiffOf(id: number): Promise<WorkingCopyDiff> {
    if (this.get(id).status === 'archived') throw new Error("An archived Session's diff base can't change.");
    const diff = await this.diffOf(id);
    if (!diff) throw new Error('No diff available');
    return diff;
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

  /** Records Session info's diff stat; keeps the last one known if git can't say. */
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

  /**
   * Links the open Merge request of the Session's current branch, after each
   * turn: it follows the branch, and there is none on the default branch. A
   * link stays while its branch does: one linked by hand (by the user or the
   * agent's tool) whatever is found there, one found there until another open
   * one is (one just merged or closed is Babysit's). Keeps the link as it is
   * if git or the Forge can't say, and on a detached HEAD. Only the latest
   * lookup counts.
   */
  private async lookUpMergeRequest(id: number): Promise<void> {
    const lookup = (this.mergeRequestLookups.get(id) ?? 0) + 1;
    this.mergeRequestLookups.set(id, lookup);
    const session = this.get(id);
    const forge = this.options.project(session.projectId)?.forge;
    if (session.status === 'archived' || session.worktreeMissing || forge?.state !== 'available') return;
    let branch: string | undefined;
    let onDefault = false;
    let found: FoundMergeRequest | undefined;
    try {
      branch = await this.currentBranch(id);
      if (!branch) return;
      onDefault = branch === (await this.defaultBranch(id));
      if (!onDefault) found = await findMergeRequest(this.environmentOf(session).request, forge, session.workingCopy.path, branch);
    } catch {
      return;
    }
    await this.loadTranscript(id);
    if (this.shuttingDown || this.get(id).status === 'archived' || this.mergeRequestLookups.get(id) !== lookup) return;
    const linked = this.get(id).mergeRequest && this.mergeRequestLinks.get(id);
    if (onDefault) return this.setMergeRequest(id, undefined);
    if (linked?.branch === branch && (linked.byHand || !found)) return;
    this.setMergeRequest(id, found, found && { branch, byHand: false });
  }

  /** Links `mergeRequest` to the Session as `linkage` says, with a card when it is a new one; or unlinks it. */
  private setMergeRequest(id: number, mergeRequest: ForgeLink | undefined, linkage?: MergeRequestLinkage): void {
    const known = this.get(id).mergeRequest;
    const link = mergeRequest && linkage && { number: mergeRequest.number, url: mergeRequest.url };
    const same = known?.number === link?.number && known?.url === link?.url;
    const was = this.mergeRequestLinks.get(id);
    if (same && was?.branch === linkage?.branch && was?.byHand === linkage?.byHand) return;
    if (link) this.mergeRequestLinks.set(id, linkage!);
    else this.mergeRequestLinks.delete(id);
    this.save(id, {
      merge_request_number: link?.number ?? null,
      merge_request_url: link?.url ?? null,
      merge_request_branch: link ? linkage!.branch : null,
      merge_request_by_hand: link && linkage!.byHand ? 1 : 0,
      // Only an open one is ever linked; Archive looks again.
      merge_request_state: link ? 'open' : null,
      // A new Merge request is watched, whatever became of the last one's.
      ...(same ? {} : { babysit_off: 0 }),
    });
    if (same) return;
    this.update(id, { mergeRequest: link, mergeRequestState: link ? 'open' : undefined, babysitOff: undefined });
    if (link) {
      this.endStreaming(id);
      this.addItem(id, { kind: 'merge-request', ...link });
    }
  }

  /**
   * Links the Merge request the agent named with Loom's `link_merge_request`
   * tool, once the call has completed: Loom's MCP server only answers it.
   */
  private noticeLinkCall(id: number, { toolCallId, title, status }: Extract<AgentEvent, { type: 'tool-started' | 'tool-updated' }>): void {
    let calls = this.linkCalls.get(id);
    if (title !== undefined && LINK_TOOL.test(title.trim())) {
      if (!calls) this.linkCalls.set(id, (calls = new Set()));
      calls.add(toolCallId);
    }
    if (!calls?.has(toolCallId) || (status !== 'completed' && status !== 'failed')) return;
    calls.delete(toolCallId);
    if (calls.size === 0) this.linkCalls.delete(id);
    if (status === 'failed') return;
    const card = this.transcript(id).value.findLast((i) => i.kind === 'tool' && i.toolCallId === toolCallId);
    const named = card?.kind === 'tool' ? linkToolInput(card.input) : undefined;
    if (!named) return;
    // The agent was only told Loom checks it; the user sees why it wasn't linked.
    this.linkMergeRequest({ id, mergeRequest: named }).catch((error: unknown) => {
      if (this.shuttingDown || this.get(id).status === 'archived') return;
      this.endStreaming(id);
      this.addItem(id, { kind: 'merge-request-refused', mergeRequest: named, reason: (error as Error).message });
    });
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
    const exists = await pathExists(this.environmentOf(session), session.workingCopy.path);
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
    this.denyMessages.delete(id);
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
    this.interrupting.delete(id);
    this.endStreaming(id);
    this.asks.delete(id);
    this.approvedCalls.delete(id);
    this.linkCalls.delete(id);
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
    const was = this.get(id);
    this.trackSpan(id, spanOf(status, waitingReason), updatedAt);
    if (status === 'waiting' && waitingReason === 'stuck' && !(was.status === 'waiting' && was.waitingReason === 'stuck')) {
      this.write((trx) => trx.updateTable('sessions').set((eb) => ({ stuck_count: eb('stuck_count', '+', 1) })).where('id', '=', id).execute());
    }
    if (status === 'archived' && was.status !== 'archived') this.save(id, { archived_at: updatedAt });
    this.update(id, { status, waitingReason, error, unread, updatedAt });
    this.save(id, { status, waiting_reason: waitingReason ?? null, error: error ?? null, unread: unread ? 1 : 0, updated_at: updatedAt });
    this.watchIdle(id);
    this.watchStuck(id);
  }

  /**
   * Sets a Working Session to go Waiting (stuck) once its agent has said
   * nothing for `stuckAfterMs`, from now: called on each status change and
   * each agent event, which also cancels the watch set before. A Session
   * Waiting, on a question or Approval request among others, is never watched.
   */
  private watchStuck(id: number): void {
    const handle = this.stuckWatches.get(id);
    if (handle !== undefined) this.options.clock.clearTimeout(handle);
    this.stuckWatches.delete(id);
    if (this.shuttingDown || this.get(id).status !== 'working') return;
    this.stuckWatches.set(
      id,
      this.options.clock.setTimeout(() => {
        this.stuckWatches.delete(id);
        if (!this.shuttingDown && this.get(id).status === 'working' && !this.asks.has(id)) this.setStatus(id, { status: 'waiting', waitingReason: 'stuck' });
      }, this.options.stuckAfterMs()),
    );
  }

  /** Ends the run or wait the Session was in, unless it goes on in `kind`, recording it, and starts the next. */
  private trackSpan(id: number, kind: OpenSpan['kind'] | undefined, now: number): void {
    const open = this.spans.get(id);
    if (open && open.kind === kind) return;
    if (open) {
      // A wait carried over from before Loom last closed counts its earlier time too, as if it had all been in a row.
      const started = open.since - (open.carried ?? 0);
      this.write((trx) => recordSpan(trx, { session_id: id, kind: open.kind, started_at: started, ended_at: now }));
      if (open.carried) this.save(id, { wait_carried_ms: 0 });
    }
    if (kind) this.spans.set(id, { kind, since: now });
    else this.spans.delete(id);
    this.trackWorkingTime(id, open, kind, now);
  }

  /**
   * Keeps the Session's Working time as its span changes from `open` to
   * `kind`: its runs so far, and when the one going on started. Published
   * with the status change that caused it.
   */
  private trackWorkingTime(id: number, open: OpenSpan | undefined, kind: OpenSpan['kind'] | undefined, now: number): void {
    const session = this.sessions.get(id);
    // An undone Session is gone already.
    if (!session || (open?.kind !== 'run' && kind !== 'run')) return;
    const usage = this.usageOf(id);
    const workingMs = usage.workingMs + (open?.kind === 'run' ? Math.max(0, now - open.since) : 0);
    this.sessions.set(id, { ...session, usage: withoutUndefined({ ...usage, workingMs, workingSince: kind === 'run' ? now : undefined }) });
  }

  /**
   * Sets the Session's agent to stop once it has been Waiting IDLE_STOP_MS
   * with nothing in flight (no run, question or Approval request), from now:
   * called on each status change, which also cancels the stop set before.
   */
  private watchIdle(id: number): void {
    const handle = this.idleStops.get(id);
    if (handle !== undefined) this.options.clock.clearTimeout(handle);
    this.idleStops.delete(id);
    if (this.shuttingDown || this.get(id).status !== 'waiting' || this.inRun(id) || !this.live.has(id)) return;
    this.idleStops.set(id, this.options.clock.setTimeout(() => this.stopIdle(id), IDLE_STOP_MS));
  }

  /** Stops the idle Session's agent, unless something is in flight after all. */
  private stopIdle(id: number): void {
    this.idleStops.delete(id);
    if (this.shuttingDown || this.get(id).status !== 'waiting' || this.inRun(id)) return;
    // A model change talks to the agent: the wait starts again once it is done (see setModel).
    if (this.switching.has(id)) return;
    const agent = this.live.get(id);
    if (!agent) return;
    // Out of `live` first, so its closing is no failure.
    this.live.delete(id);
    const closed = agent
      .close()
      .catch((error: unknown) => console.error(`could not stop Session ${id}'s idle agent:`, error))
      .finally(() => {
        if (this.closing.get(id) === closed) this.closing.delete(id);
      });
    this.closing.set(id, closed);
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
  async flush(): Promise<void> {
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

/**
 * The stretch of time a status is, for the dashboard: a `run` while Working;
 * a `wait` for the user while Waiting on a question or Approval request, or
 * finished and unanswered; none otherwise.
 */
function spanOf(status: SessionStatus, waitingReason: WaitingReason | undefined): OpenSpan['kind'] | undefined {
  if (status === 'working') return 'run';
  if (status === 'waiting' && (waitingReason === 'question' || waitingReason === 'approval' || waitingReason === 'finished')) return 'wait';
  return undefined;
}

/** The prompt's text, trimmed; it may be empty only with files attached. */
function promptText(prompt: string, { attached = false, comments }: { attached?: boolean; comments?: DiffComment[] } = {}): string {
  if (typeof prompt !== 'string') throw new Error('A prompt must be text.');
  const text = [prompt.trim(), ...diffCommentBlocks(comments)].filter(Boolean).join('\n\n');
  if (!text && !attached) throw new Error('A prompt needs some text.');
  return text;
}

/** What is sent of a queued message or a user's transcript item: its text and attachments. */
function messageOf({ text, attachments }: Message): Message {
  return withoutUndefined({ text, attachments });
}

/** Rejects an issue Loom couldn't link to, or open in the browser. */
function checkIssue(issue: Issue): void {
  if (!Number.isInteger(issue.number) || issue.number <= 0 || !/^https?:\/\//i.test(issue.url ?? '')) {
    throw new Error('An issue needs a number and an http(s) link.');
  }
}

/** Rejects a model that isn't named `provider/model`, and an Effort level with no name. */
function checkPick({ model, effort }: { [K in keyof ModelPick]?: unknown }): void {
  if (model !== undefined && (typeof model !== 'string' || !model.includes('/'))) throw new Error('A model is named provider/model.');
  if (effort !== undefined && (typeof effort !== 'string' || !effort)) throw new Error('An Effort level needs a name.');
}

/** Rejects an existing working copy that isn't a plain branch name, or a worktree's path. */
function checkExisting(existing: ExistingWorkingCopy): void {
  if (typeof existing !== 'object' || existing === null) throw new Error('An existing working copy needs a branch or a worktree.');
  if ('worktree' in existing) {
    if (typeof existing.worktree !== 'string' || !existing.worktree) throw new Error('An existing worktree needs its path.');
    return;
  }
  const { branch } = existing;
  if (typeof branch?.name !== 'string' || !branch.name || branch.name.startsWith('-') || typeof branch.remote !== 'boolean') {
    throw new Error('An existing branch needs a name, and whether it is on origin.');
  }
}

/** The start of a first prompt from an issue: its number and title, URL, then body. */
function issuePrompt(issue: Issue): string {
  const heading = `#${issue.number} ${(issue.title ?? '').trim()}`.trimEnd();
  return [`${heading}\n${issue.url}`, (issue.body ?? '').trim()].filter(Boolean).join('\n\n');
}

/** How a Session's Merge request was linked: on which branch, and whether by hand rather than found there. */
interface MergeRequestLinkage {
  branch: string;
  byHand: boolean;
}

/** Loom's `link_merge_request` tool, as agents name it: prefixed with its server's name, `loom_` for OpenCode, `mcp__loom__` for some others. */
const LINK_TOOL = /^(?:mcp__)?loom(?:__|[_.:-])link_merge_request$/i;

/** What the agent gave Loom's `link_merge_request` tool, as `linkMergeRequest` takes it: the number, or else the URL. */
function linkToolInput(input: string | undefined): string | undefined {
  try {
    const { number, url } = JSON.parse(input ?? '') as { number?: unknown; url?: unknown };
    if ((typeof number === 'number' || typeof number === 'string') && String(number).trim()) return String(number).trim();
    return typeof url === 'string' && url.trim() ? url.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The prompt shortcut asking the agent to open or update its branch's Merge request. */
function mergeRequestPrompt(cli: string): string {
  return `Open a Merge request for this branch with ${cli}, or update it if one is already open: push the branch, then write its title and description from our conversation.`;
}

/** Whether the Session's agent may be sent feedback unattended: not after the user stopped it, nor over a Retry or Continue the user has to give. */
function canAutoPrompt({ autoPrompt, worktreeMissing, waitingReason }: Session): boolean {
  return !!autoPrompt && !worktreeMissing && waitingReason !== 'stopped' && waitingReason !== 'error' && waitingReason !== 'interrupted';
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
    mergeRequestState: row.merge_request_number === null ? undefined : (row.merge_request_state ?? undefined),
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    context: row.context_used === null || row.context_size === null ? undefined : { used: row.context_used, size: row.context_size },
    status: row.status,
    waitingReason: row.waiting_reason ?? undefined,
    error: row.error ?? undefined,
    unread: row.unread !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    autoPrompt: row.auto_prompt !== 0 || undefined,
    babysitOff: row.babysit_off !== 0 || undefined,
  });
}

/** What a run leaves going until it ends: a tool call still running, or a question, trust or Approval request still asked. */
function leftGoing(item: TranscriptItem): item is Extract<TranscriptItem, { kind: 'tool' | 'question' | 'trust' | 'approval' }> {
  return (item.kind === 'tool' && item.status === 'running') || ((item.kind === 'question' || item.kind === 'trust' || item.kind === 'approval') && item.state === 'asked');
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
