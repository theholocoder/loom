// The typed API between the renderer and main. The renderer talks to main
// only through this: commands it invokes, and topics it subscribes to. It is
// also the seam tests drive main through (seam A) and fake for the renderer
// (seam B), so everything the UI can see or do goes through here.
import { DEFAULT_APPEARANCE, type Appearance } from './appearance';
import { DEFAULT_LAYOUT, type LayoutSettings, type PanelArea, type PanelDimension, type PanelKind, type SessionPanels } from './panels';
import { DEFAULT_INBOX, type InboxSettings } from './window';

/** What the Environment's bridge reported in its handshake. */
export interface BridgeInfo {
  protocolVersion: number;
  /** The Client version the bridge was built with. */
  version: string;
  os: string;
  arch: string;
  /** The user's home folder in the Environment, which `~` means there. */
  home: string;
  /** The bridge binary's path in the Environment, which agents run as `<executable> mcp` for Loom's tools. */
  executable?: string;
}

/**
 * - `starting`: the bridge is launching or hasn't finished its handshake.
 * - `connected`: the handshake succeeded and the bridge answers pings.
 * - `unresponsive`: the last ping went unanswered within its timeout.
 * - `disconnected`: the bridge process exited.
 * - `failed`: the bridge could not be started or its handshake failed.
 */
export type EnvironmentState = 'starting' | 'connected' | 'unresponsive' | 'disconnected' | 'failed';

/**
 * Where the bridge got the environment it runs the agent and git with:
 * - `interactive`: the user's interactive login shell (`$SHELL -ilc`);
 * - `login`: their login shell (`$SHELL -lc`), when the interactive one failed;
 * - `bridge`: the bridge's own environment, when there is no shell to ask
 *   (native Windows) or both attempts failed.
 */
export type ShellEnvironmentSource = 'interactive' | 'login' | 'bridge';

/** The agent v1 runs Sessions on. */
export const OPENCODE_NAME = 'OpenCode';

/** The oldest OpenCode Loom drives. V1 OpenCode (`opencode-ai` 1.x) is refused. */
export const OPENCODE_MIN_VERSION = '2.1.4';

/**
 * - `unknown`: not checked yet.
 * - `missing`: not on the Environment's PATH.
 * - `unsupported`: older than the minimum version, V1 OpenCode included.
 * - `signed-out`: installed, but signed in to no model provider.
 * - `ready`: installed, recent enough and signed in.
 * - `error`: the check itself failed.
 */
export type AgentState = 'unknown' | 'missing' | 'unsupported' | 'signed-out' | 'ready' | 'error';

/** Whether an Environment's agent is ready to run Sessions. */
export interface AgentStatus {
  name: string;
  state: AgentState;
  /** Whether a check is running; the other fields are from the last one. */
  checking: boolean;
  /** The version the agent reported, as `major.minor.patch`. */
  version?: string;
  /** Where the agent was found. */
  path?: string;
  /** Why the check failed, when `error`. */
  error?: string;
}

/** A model the agent can run, as its own providers offer it. */
export interface ModelChoice {
  /** `provider/model`, as the agent names it. */
  id: string;
  /** What its provider calls it. */
  name: string;
  /**
   * The Effort levels it takes, as the agent reports them, `default`
   * included; empty for a model that takes none. Absent when only the
   * current model's are known (see AgentConfig.efforts).
   */
  efforts?: string[];
}

/** A model, `provider/model`, and an Effort level to run with; what is absent stays as it is, or is the agent's own. */
export interface ModelPick {
  model?: string;
  effort?: string;
}

/** The Effort level a model runs with until another is picked, among the levels OpenCode offers for every model taking any. */
export const DEFAULT_EFFORT = 'default';

/**
 * Something the agent runs from the composer's `/`: one of its commands
 * (its own, or the user's), or one of its skills (the Project's, the user's,
 * or its own). Sent as `/name args`, which the agent runs as the command or
 * loads the skill for.
 */
export interface AgentCommand {
  /** Whether it is a command or a skill. */
  kind: 'command' | 'skill';
  /** What follows the `/`. */
  name: string;
  /** What it does, as the agent says. */
  description?: string;
  /** Where a skill comes from, when known. */
  source?: SkillSource;
}

/**
 * Where a skill comes from: the Project's own (its SKILL.md is in the
 * checkout), the user's (elsewhere on their machine), or the agent's own.
 */
export type SkillSource = 'project' | 'personal' | 'built-in';

/**
 * The models and Effort levels a Session's agent offers, and what it runs
 * with now, as its config options last said.
 */
export interface AgentConfig {
  /** The model it runs with, `provider/model`. */
  model?: string;
  models: ModelChoice[];
  /** The Effort level it runs with; absent for a model that takes none. */
  effort?: string;
  /** The current model's Effort levels, `default` included; empty for a model that takes none. */
  efforts: string[];
}

/** How full a Session's agent context is, in tokens, as the agent last reported after a run. */
export interface ContextUsage {
  used: number;
  /** The model's context window. */
  size: number;
}

export interface EnvironmentStatus {
  id: string;
  label: string;
  state: EnvironmentState;
  /** Present once the handshake has succeeded. */
  bridge?: BridgeInfo;
  /** Why the Environment is `failed` or `disconnected`. */
  error?: string;
  /** Clock time of the last answered ping or handshake. */
  lastSeenAt?: number;
  /** Present once the bridge has resolved its shell environment. */
  shellEnvironment?: ShellEnvironmentSource;
  /** Present once the Environment is connected. */
  agent?: AgentStatus;
}

/** Where a Project's checkout is on this machine. */
export interface Checkout {
  /** The Environment the checkout's work runs in. */
  environmentId: string;
  /** The checkout's top-level folder, as its Environment's git reports it. */
  path: string;
}

export type ForgeKind = 'github' | 'gitlab';

/** A Merge request's number as its Forge writes it: `!87` on GitLab, `#40` on GitHub. Issues are `#31` on both. */
export function mergeRequestRef(kind: ForgeKind | undefined, number: number): string {
  return `${kind === 'gitlab' ? '!' : '#'}${number}`;
}

/** Each Forge by its name. */
export const FORGE_NAMES: Record<ForgeKind, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** The CLI Loom reaches each Forge through, with the user's own login. */
export const FORGE_CLI: Record<ForgeKind, 'gh' | 'glab'> = { github: 'gh', gitlab: 'glab' };

/**
 * Whether a Project's Forge features are on, and why not:
 * - `unknown`: not checked yet.
 * - `available`: `origin` is on GitHub or GitLab, and its CLI is signed in to that host.
 * - `no-remote`: the checkout has no `origin`.
 * - `unsupported`: `origin` is not on GitHub or GitLab.
 * - `cli-missing`: `gh` or `glab` isn't on the Environment's PATH.
 * - `signed-out`: the CLI isn't signed in to `origin`'s host.
 * - `error`: the check itself failed.
 */
export type ForgeState = 'unknown' | 'available' | 'no-remote' | 'unsupported' | 'cli-missing' | 'signed-out' | 'error';

export interface ForgeStatus {
  state: ForgeState;
  /** Whether a check is running; the other fields are from the last one. */
  checking: boolean;
  /** The Forge `origin` is on, once known. */
  kind?: ForgeKind;
  /** `origin`'s host, e.g. `github.com`. */
  host?: string;
  /** The repository's path on the host, e.g. `theholocoder/loom`. */
  repository?: string;
  /** `origin`'s URL, when it has one. */
  remote?: string;
  /** Why the check failed, or what the CLI said when signed out. */
  error?: string;
}

export interface Project {
  id: number;
  name: string;
  /** What Loom's branch names start with: `<prefix>/<slug>`. */
  branchPrefix: string;
  checkout: Checkout;
  forge: ForgeStatus;
}

/** A Project the user removed: hidden, its Sessions archived, its history kept. */
export interface RemovedProject {
  id: number;
  name: string;
}

/** A removed Project a checkout being added could restore, with how many Sessions it would bring back. */
export interface RestorableProject {
  id: number;
  name: string;
  sessions: number;
}

/** What `projects.remove` did: removed, or held back by the unsaved work of some of its Sessions. */
export type RemoveProjectResult = { removed: true } | { removed: false; unsaved: UnsavedSession[] };

/** A Session whose worktree has unsaved work, holding back its Project's removal. */
export interface UnsavedSession {
  sessionId: number;
  title: string;
  unsavedWork: UnsavedWork;
}

/** The branch prefix a new Project gets. */
export const DEFAULT_BRANCH_PREFIX = 'loom';

/**
 * - `working`: the agent is running; the Session doesn't need the user.
 * - `waiting`: the Session needs the user; `waitingReason` says why.
 * - `archived`: closed, kept for history.
 */
export type SessionStatus = 'working' | 'waiting' | 'archived';

export type WaitingReason = 'finished' | 'stopped' | 'question' | 'approval' | 'stuck' | 'error' | 'interrupted' | 'feedback' | 'unsaved-work';

/**
 * - `worktree`: the Session's own git worktree.
 * - `checkout`: the Project's checkout itself, on whatever branch it has.
 */
export type WorkingCopyKind = 'worktree' | 'checkout';

/** Where a Merge request is on its Forge. */
export type MergeRequestState = 'open' | 'merged' | 'closed';

/** Where a Merge request is once it is no longer open. */
export type EndedMergeRequestState = Exclude<MergeRequestState, 'open'>;

/** A Merge request's CI as a whole: `pending` until all of it has finished. */
export type BabysitCi = 'pending' | 'passed' | 'failed';

/** Where one CI check is: `not-run` for one cancelled, or waiting to be started by hand. */
export type BabysitCheckState = BabysitCi | 'not-run';

export interface BabysitCheck {
  name: string;
  state: BabysitCheckState;
  /** Where its details are. */
  url?: string;
}

/** What Babysit last saw of a Session's Merge request. */
export interface BabysitStatus {
  /** Absent with no CI, or none that says either way (cancelled, say). */
  ci?: BabysitCi;
  /** Each of its checks as last seen; absent before the first poll that worked. */
  checks?: BabysitCheck[];
  /** Clock time of the last poll that worked. */
  lastPollAt?: number;
  /** Set while the last poll failed: what's shown may be out of date. */
  stale: boolean;
  /** The reviews and comments others left on it, as last seen; absent before the first poll that worked. */
  reviews?: ReviewCount;
  /** Its review threads on the code still open that others wrote in, as last seen: notes on their lines in the diffs. */
  threads?: ReviewThread[];
}

/** One comment of a review thread. */
export interface ReviewThreadComment {
  author: string;
  /** Markdown. */
  body: string;
  /** Clock time it was written, when the Forge says. */
  at?: number;
  url: string;
}

/**
 * A thread of review comments on a line of a Merge request's code, not
 * resolved, that someone other than the user wrote in: shown as a note on its
 * line in Changes and in the Merge request's diff, to reply to or resolve.
 */
export interface ReviewThread {
  /** The Forge's own id for it, which replying and resolving name: GitHub's thread, GitLab's discussion. */
  id: string;
  path: string;
  /** The line it is on, numbered as the Merge request's diff numbers its `side`; absent once the Forge no longer places it (outdated). */
  line?: number;
  /** `old` for a removed line, numbered in the old file. */
  side: 'old' | 'new';
  /** What the line read when it was commented on, when the Forge says (GitHub): a diff where it reads otherwise has moved on. */
  code?: string;
  /** Set when it came with a review asking for changes. */
  changesRequested?: boolean;
  /** Oldest first: the first one started it. */
  comments: ReviewThreadComment[];
  /** Whether the user may resolve it, as the Forge says. */
  canResolve: boolean;
}

/** How many reviews and comments others left on a Merge request, for the Glance strip. */
export interface ReviewCount {
  /** Whole reviews, approvals among them. */
  reviews: number;
  /** Comments outside a review. */
  comments: number;
  /** Set while a reviewer's latest verdict asks for changes. */
  changesRequested: boolean;
}

/** What a reviewer said of a Merge request as a whole. */
export type ReviewVerdict = 'approved' | 'changes-requested' | 'commented' | 'dismissed';

/** A review on a Merge request: its verdict, what it says, and its comments on the code. */
export interface MergeRequestReview {
  author: string;
  verdict: ReviewVerdict;
  /** Markdown; empty when the review says nothing but its verdict or its comments. */
  body: string;
  /** Clock time it was submitted, when the Forge says. */
  at?: number;
  url: string;
  comments: MergeRequestComment[];
}

/** A comment on a Merge request, on a place in its code when `path` is set. */
export interface MergeRequestComment {
  author: string;
  /** Markdown. */
  body: string;
  path?: string;
  line?: number;
  /** Clock time it was written, when the Forge says. */
  at?: number;
  url: string;
}

/**
 * A Merge request as its Panel shows it, read from the Forge when asked:
 * everyone's reviews and comments, the user's own among them.
 */
export interface MergeRequestDetails extends ForgeLink {
  title: string;
  state: MergeRequestState;
  draft: boolean;
  /** Its source branch, and the one it merges into. */
  sourceBranch: string;
  targetBranch: string;
  /** The commit its source branch is at, when the Forge says: Squash and merge merges only while it still is. */
  head?: string;
  author: string;
  /** Markdown, as its author wrote it; empty when there is none. */
  description: string;
  /** Who was asked to review it or did, its author aside: users, and on GitHub teams as `org/team`. */
  reviewers: string[];
  /** How many commits it has; `moreCommits` when the Forge listed only the first of them. */
  commits: number;
  moreCommits?: boolean;
  /** What it changes, all commits together; `moreFiles` when the Forge listed only the first files, which these count. */
  files: number;
  moreFiles?: boolean;
  added: number;
  removed: number;
  ci?: BabysitCi;
  checks: BabysitCheck[];
  /** Oldest first. */
  reviews: MergeRequestReview[];
  /** Those outside a review, oldest first. */
  comments: MergeRequestComment[];
}

/** One file of a Merge request's diff, as its Forge has it: committed, with its unified diff. */
export interface MergeRequestDiffFile extends DiffFile, FileDiff {}

/** What a Merge request changes, file by file, as its Forge has it; `moreFiles` when the Forge listed only the first of them. */
export interface MergeRequestDiff {
  files: MergeRequestDiffFile[];
  moreFiles?: boolean;
}

/** A comment on a place in the code. */
export interface FeedbackComment {
  path: string;
  line?: number;
  excerpt: string;
  url: string;
}

export interface FeedbackCheck {
  name: string;
  /** Where its log is. */
  url?: string;
}

/** `src/a.ts:10`: the place in the code a comment is about. */
export function codePlace({ path, line }: { path?: string; line?: number }): string {
  return `${path ?? ''}${line ? `:${line}` : ''}`;
}

/** One thing a Session's Merge request got that the agent may need to act on. */
export type FeedbackItem =
  /** A whole review, however many comments it has. */
  | { kind: 'review'; author: string; verdict: 'changes-requested' | 'commented'; excerpt: string; url: string; comments: FeedbackComment[] }
  /** A comment; `path` when it is on the code. */
  | { kind: 'comment'; author: string; path?: string; line?: number; excerpt: string; url: string }
  /** The CI finished, and these failed. */
  | { kind: 'ci-failed'; checks: FeedbackCheck[] }
  | { kind: 'conflicts' };

/** Progress worth seeing that needs nothing done. */
export type FeedbackInfo = { event: 'approved'; author: string; url: string } | { event: 'ci-passed'; url: string };

/** An issue or Merge request on the Project's Forge. */
export interface ForgeLink {
  /** Its number on the Forge (see mergeRequestRef). */
  number: number;
  /** Its page on the Forge. */
  url: string;
}

/** An open issue on the Project's Forge, as the issue picker lists it. */
export interface Issue extends ForgeLink {
  title: string;
  /** Its description, as the Forge stores it (Markdown). */
  body: string;
}

/**
 * What a worktree Session can start from, as `projects.branches` lists it
 * after fetching `origin`: a base for a new branch, an existing worktree to
 * work in, or an existing branch to check out in a new worktree.
 */
export interface Branches {
  /** `origin`'s default branch, as `origin` itself says, without `origin/`. */
  defaultBranch: string;
  /** `origin`'s branches, without `origin/`, by name: what a new branch can start from. */
  remote: string[];
  /**
   * The branches git can still check out in a new worktree, local ones first,
   * each by name: local branches not checked out in the checkout or any
   * worktree, and `origin`'s branches with no same-named local branch (one
   * there would be reused, so is listed instead).
   */
  existing: ExistingBranch[];
  /**
   * The worktrees a Session can work in, in `git worktree list` order: the
   * checkout's linked worktrees but the Project's own, leaving out bare,
   * missing and locked ones; those Sessions work in too, to share.
   */
  worktrees: ExistingWorktree[];
}

/** A git worktree of the Project's checkout that already exists. */
export interface ExistingWorktree {
  /** Its folder, as git reports it. */
  path: string;
  /** The branch it has checked out; absent on a detached HEAD. */
  branch?: string;
}

/** An existing branch a worktree Session checks out: a local one, or one on `origin` by its name there. */
export interface ExistingBranch {
  name: string;
  remote: boolean;
}

/** What a worktree Session starts on instead of a new branch: an existing branch, in a new worktree, or an existing worktree, by its path. */
export type ExistingWorkingCopy = { branch: ExistingBranch } | { worktree: string };

/** Where a Session's agent works. */
export interface WorkingCopy {
  kind: WorkingCopyKind;
  /** The working copy's folder, in its Project's Environment. */
  path: string;
}

/** Work in a worktree that removing it would lose, or leave only on its local branch. */
export interface UnsavedWork {
  /** Whether it has uncommitted changes, untracked files included. */
  uncommitted: boolean;
  /** How many of its commits are on no remote branch. */
  unpushedCommits: number;
  /** Whether HEAD is detached, so those commits are on no branch and archiving loses them. */
  detached: boolean;
}

/**
 * Which Session to archive or delete, and whether to discard the unsaved
 * work of its worktree, which otherwise holds it back.
 */
export interface CloseSessionParams {
  id: number;
  discard?: boolean;
}

/** What `sessions.archive` did: archived, or held back by unsaved work. */
export type ArchiveResult = { archived: true } | { archived: false; unsavedWork: UnsavedWork };

/** What `sessions.delete` did: deleted, or held back by unsaved work. */
export type DeleteResult = { deleted: true } | { deleted: false; unsavedWork: UnsavedWork };

export interface Session {
  id: number;
  projectId: number;
  title: string;
  workingCopy: WorkingCopy;
  /** The agent the Session runs on, e.g. `OpenCode`. */
  agent: string;
  /** The agent's own id for the conversation (OpenCode's `ses_…`), once it has one. */
  agentSessionId?: string;
  /**
   * The branch its working copy had checked out when Loom last looked: at
   * start, after each turn, when the Session is opened and when its
   * Environment connects. Absent until known; a detached HEAD shows as its
   * short commit id.
   */
  branch?: string;
  /** The issue the Session works on, once linked. */
  issue?: ForgeLink;
  /** Its current branch's Merge request, once linked. */
  mergeRequest?: ForgeLink;
  /** Where its Merge request is, as Loom last knew: `open` while linked, until Babysit sees otherwise or Archive looks again. */
  mergeRequestState?: MergeRequestState;
  /** What Babysit last saw of its open Merge request; absent with no Merge request to babysit. */
  babysit?: BabysitStatus;
  /** Set when the user has stopped Babysit watching its Merge request; a new link starts it again. */
  babysitOff?: boolean;
  /** Set when its Merge request's feedback goes straight to the agent; seeded from the global default. */
  autoPrompt?: boolean;
  /** Set when it runs in the Full access Approval mode, picked when it started: Loom approves all its agent asks. */
  fullAccess?: boolean;
  status: SessionStatus;
  /**
   * Set when a worktree Session's worktree is gone, deleted outside Loom: it
   * can only be archived. Checked with its branch: after each turn, when
   * the Session is opened and when its Environment connects.
   */
  worktreeMissing?: boolean;
  /**
   * What its branch changed against the merge-base with its start base, for
   * the Glance strip's diff stat: worked out after each turn and when the Session is
   * opened, kept in memory only. Absent until known.
   */
  diffStat?: DiffStat;
  /**
   * The messages the user sent while it was Working, oldest first, waiting
   * to be sent one by one as runs settle. Kept in the database; absent when
   * empty.
   */
  queue?: QueuedMessage[];
  /** Set when its agent can take a queued message mid-run (Steer); otherwise Send now interrupts the run. */
  canSteer?: boolean;
  /**
   * The model the user picked, `provider/model`, and its Effort level: what
   * each prompt runs with, from the next one. Absent for the agent's own
   * choice (OpenCode's default model, or the model's default Effort).
   */
  model?: string;
  effort?: string;
  /**
   * What the Session's agent offers to pick, and runs with, as it last
   * reported: known once its agent has started while the Client runs.
   */
  agentConfig?: AgentConfig;
  /**
   * The commands the Session's agent offers, as it last announced them:
   * known once its agent has started while the Client runs. Its skills are
   * the Project's (`projects.commands`).
   */
  agentCommands?: AgentCommand[];
  /** How full the agent's context was after its last run that reported it. */
  context?: ContextUsage;
  /** What the Session has used so far, from its usage buckets and its runs; updated as turns end and runs start and stop. Session highlights' checks aren't in it. */
  usage?: SessionUsage;
  /**
   * Its Highlights, counted: present while the Highlights Panel means
   * something for it, Session highlights being on or it having some.
   */
  highlights?: HighlightCounts;
  /** Why the Session is `waiting`. */
  waitingReason?: WaitingReason;
  /** What went wrong, when waiting on an `error`. */
  error?: string;
  /**
   * Whether the Session has news the user hasn't opened yet. Set when it goes
   * Waiting, cleared when the user opens or replies to it.
   */
  unread: boolean;
  /**
   * Clock time a Snoozed Session comes back to the Inbox, unread; absent
   * when it isn't Snoozed. Only a Waiting Session is Snoozed: any change of
   * status ends it.
   */
  snoozedUntil?: number;
  /** Clock time the Session was started. */
  createdAt: number;
  /** Clock time its status last changed. */
  updatedAt: number;
}

/** How many Highlights a Session has, open or resolved, and how many came since the user last looked at its Highlights Panel. */
export interface HighlightCounts {
  count: number;
  unseen: number;
}

/** The kinds of Highlight, in the order the Highlights Panel groups them. */
export const HIGHLIGHT_KINDS = ['for-you', 'not-done', 'risk', 'assumption', 'decision'] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];

/** Each kind of Highlight, as the user reads it. */
export const HIGHLIGHT_LABELS: Record<HighlightKind, string> = { 'for-you': 'For you', 'not-done': 'Not done', risk: 'Risk', assumption: 'Assumption', decision: 'Decision' };

export function isHighlightKind(value: unknown): value is HighlightKind {
  return typeof value === 'string' && (HIGHLIGHT_KINDS as readonly string[]).includes(value);
}

/**
 * Something the user should know about a Session's work, which Session
 * highlights' model noted after a turn: never rewritten, only resolved (by
 * the model, giving why, or by the user) and reopened.
 */
export interface Highlight {
  id: number;
  kind: HighlightKind;
  /** One or two sentences, as the model wrote them. */
  text: string;
  /** The transcript item the turn it came from starts at: the user's message. */
  itemId: number;
  /** Clock time it was noted. */
  createdAt: number;
  /** Set once resolved; gone when the user reopens it. */
  resolved?: HighlightResolution;
}

export interface HighlightResolution {
  /** The model, giving `reason`, or the user. */
  by: 'model' | 'user';
  reason?: string;
  /** The transcript item the turn that resolved it starts at, when the model did. */
  itemId?: number;
  /** Clock time it was resolved. */
  at: number;
}

/** A Session's Highlights, oldest first, and how checking them goes. */
export interface SessionHighlights {
  highlights: Highlight[];
  /** The Highlights with a greater id came since the user last looked at the Panel. */
  seenThrough: number;
  /** While a check of the turns since the last one runs. */
  checking: boolean;
  /** Why the last check failed; gone once one succeeds. Its turns are checked again with the next. */
  error?: string;
}

/** The Session highlights setting: whether a model checks each turn for Highlights, and which. */
export interface HighlightsSettings {
  on: boolean;
  /** `provider/model`, as the agent names it: required while on. */
  model?: string;
  /** Its Effort level; the model's default while absent. */
  effort?: string;
}

export const DEFAULT_HIGHLIGHTS: HighlightsSettings = { on: false };

/** A Session's usage so far. */
export interface SessionUsage {
  /** Tokens of every kind, summed. */
  tokens: number;
  /** What its agent reported, in USD. */
  reportedCost: number;
  /** How long it was Working, in ms, the run going on left out. */
  workingMs: number;
  /** Clock time the run going on started, while Working. */
  workingSince?: number;
}

/** A message waiting in a Session's queue. */
export interface QueuedMessage {
  id: number;
  text: string;
  /** What is attached to it, stored already; absent when nothing is. */
  attachments?: Attachment[];
}

/** A file or image the user attaches to a message, as the renderer read it. */
export interface NewAttachment {
  /** Its file name, which the agent sees too. */
  name: string;
  /** Its media type, if the renderer knows it; otherwise guessed from the name. */
  mimeType?: string;
  data: Uint8Array;
}

/**
 * The user's note on a line or range of a Session's diff, sent with a prompt
 * as a block: `path:start-end`, the quoted lines and the note. It is kept
 * nowhere but in the text of the message it goes with.
 */
export interface DiffComment {
  /** The file's path in the working copy, as the diff names it. */
  path: string;
  /** The first and last lines commented, as the diff numbers them: a removed line by its old number, any other by its new one. */
  start: number;
  end: number;
  /** The lines, as the diff shows them: each starts with ` `, `-` or `+`. */
  lines: string[];
  note: string;
}

/**
 * The user's note on a passage of a Session's conversation, sent with a
 * prompt as a block: the passage quoted, then the note. Like a DiffComment,
 * it is kept nowhere but in the text of the message it goes with.
 */
export interface ConversationComment {
  /** The text the user selected in the conversation, as it reads there. */
  quote: string;
  note: string;
}

/** A comment going with a prompt: on the diff, or on the conversation. */
export type MessageComment = DiffComment | ConversationComment;

/** Whether a comment is on the conversation rather than the diff. */
export function isConversationComment(comment: MessageComment): comment is ConversationComment {
  return 'quote' in comment;
}

/** How a diff comment's range is written: `path:start-end`, or `path:start` for one line. */
export function diffCommentRange({ path, start, end }: Pick<DiffComment, 'path' | 'start' | 'end'>): string {
  return start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
}

/**
 * A file or image attached to a message: stored in the attachments folder in
 * `userData`, per Session by content hash, and given to the agent with its
 * message, written into the Session's Environment through its bridge.
 */
export interface Attachment {
  /** Its file name, as a plain name with no folder. */
  name: string;
  /** Its media type, as the renderer gave it or guessed from its name. */
  mimeType: string;
  /** In bytes. */
  size: number;
  /** Its content's SHA-256, in hex. */
  hash: string;
}

/** Whether a media type is an image's, which goes to the agent as an image when it takes them. */
export function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** The most files `sessions.files` and `projects.files` list. */
export const MAX_LISTED_FILES = 20_000;

/** The most one message can have attached. */
export const MAX_ATTACHMENTS = 10;
/** The largest file that can be attached, in bytes. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** A diff's size: files changed, lines added and removed. Untracked files count as files of added lines. */
export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}

/** How a file in a Session's diff changed: committed on its branch, changed since its last commit, or new to git. */
export type DiffFileStatus = 'committed' | 'modified' | 'untracked';

/** A file the diff deletes, or renames (from its `oldPath`). */
export type DiffFileChange = 'deleted' | 'renamed';

/**
 * Which of a Session's changes its diff shows: all of them (its working tree
 * against its start base), those committed on its branch (HEAD against its
 * start base), or those not committed yet (its working tree against HEAD,
 * untracked files with them).
 */
export type DiffScope = 'all' | 'committed' | 'uncommitted';

/** Every DiffScope, in the order the Changes Panel offers them. */
export const DIFF_SCOPES: readonly DiffScope[] = ['all', 'committed', 'uncommitted'];

/** How many files each DiffScope holds; one with no start base to compare with has none. */
export type DiffCounts = Partial<Record<DiffScope, number>>;

/** One file of a Session's diff. */
export interface DiffFile {
  /** Its path in the working copy, with `/`. */
  path: string;
  /** Where it was before a rename. */
  oldPath?: string;
  status: DiffFileStatus;
  /** Set when the diff deletes or renames it; none when it adds it or changes its content. */
  change?: DiffFileChange;
  added: number;
  removed: number;
  binary: boolean;
  /** An untracked file past the counting limit: listed, but its lines aren't counted or read. */
  uncounted?: boolean;
}

/**
 * A Session's diff, of one DiffScope: against the merge-base of HEAD and its
 * start base (an `origin/…` branch as the local ref has it, else the local
 * default branch; see DiffBaseSource for which), or against HEAD for
 * uncommitted changes only. An archived worktree Session's is its branch's
 * commits, read-only. `counts` is how many files each scope holds, for a
 * Session that isn't archived.
 */
export type DiffSummary =
  | { available: false; reason: string }
  | { available: true; readOnly: boolean; base: string; baseSource?: DiffBaseSource; files: DiffFile[]; counts?: DiffCounts };

/**
 * Where a diff's start base came from (none for an uncommitted-only diff, against `HEAD`):
 * - `recorded`: Loom recorded it when it made the branch, or the user set it
 *   (`sessions.setDiffBase`), in the repository's local git config;
 * - `created-from`: the branch's reflog says it was created from it;
 * - `default`: neither says, so it is `origin`'s default branch, a guess;
 * - `local`: there's no `origin` branch to compare with, so it is the local
 *   default branch, which may be behind `origin`'s.
 */
export type DiffBaseSource = 'recorded' | 'created-from' | 'default' | 'local';

/** One file's unified diff text, cut short past a size limit. */
export interface FileDiff {
  text: string;
  truncated: boolean;
}

/** Loom's own settings, the same for every Project. */
export interface Settings extends Appearance {
  /**
   * Where new worktrees go, as `<root>/<project>/<session>`, the Session's
   * folder named after its branch without the prefix. A leading `~` is the
   * user's home in the Project's Environment.
   */
  worktreeRoot: string;
  /**
   * How to run the user's editor, in the Session's Environment with its full
   * PATH: a program and its arguments, quoted as in a shell. `{path}` is the
   * folder or file to open; without it, the path goes last.
   */
  editorCommand: string;
  /**
   * How to run the user's terminal, in the working copy's folder: like
   * editorCommand, but the path is only passed where `{path}` says. Empty
   * until the user sets it.
   */
  terminalCommand: string;
  /** Files the Changes view shows collapsed, as glob patterns on a path or file name (`*` matches within a folder). */
  diffCollapsedPatterns: string[];
  /**
   * Whether the agent goes ahead with each category of action reaching
   * beyond its Session's working copy and the temp directory, or asks first
   * with an Approval request. Agents started from now on get the new rules.
   */
  approvals: ApprovalPolicy;
  /**
   * How many minutes a Working Session's agent may go without a word
   * before the Session goes Waiting as stuck. A whole number, at least 1.
   */
  stuckAfterMinutes: number;
  /** Whether a new Session starts with auto-prompt on: its Merge request's feedback goes straight to the agent. */
  autoPromptDefault: boolean;
  /** The Approval mode the New Session composer starts on. */
  approvalModeDefault: ApprovalMode;
  /** The Layout: each Panel kind's size, as the user left it, the same for every Session. */
  layout: LayoutSettings;
  /** The Inbox's width, and whether it is shown or collapsed to a rail: the same for every Session. */
  inbox: InboxSettings;
  /** How the Changes view is laid out, as the user left it: the same for every Session. */
  diffView: DiffViewSettings;
  /** Session highlights: off until the user turns it on with a model. */
  highlights: HighlightsSettings;
}

/** The Changes view's layout, kept in settings. */
export interface DiffViewSettings {
  /** Whether the tree of changed files is open, where it stacks above the diffs in a narrow Panel; a wide one always shows it beside them. */
  fileList: boolean;
  /** Whether long lines wrap, rather than scroll sideways. */
  wrap: boolean;
  /** Whether diffs show side by side, rather than unified. */
  sideBySide: boolean;
}

/** The Changes view until the user changes it: unified, long lines scrolling, the file tree open. */
export const DEFAULT_DIFF_VIEW: DiffViewSettings = { fileList: true, wrap: false, sideBySide: false };

/**
 * The kinds of action an Approval request is about (see APPROVAL_CATEGORIES
 * for what each covers). The agent reads, edits and runs commands in its
 * working copy and the temp directory freely, whatever these say.
 */
export type ApprovalCategory = 'ownPush' | 'ownMergeRequest' | 'mcp' | 'writeElsewhere' | 'otherPush' | 'forge' | 'system';

export type ApprovalSetting = 'allow' | 'ask';

/**
 * A Session's Approval mode: `supervised`, its agent's requests follow the
 * approval settings and ask the user what they don't allow; `full`, Loom
 * approves every one of them, a push to the default branch included.
 */
export type ApprovalMode = 'supervised' | 'full';

/** Each Approval mode, in the order the pickers list them, with its name and what it does. */
export const APPROVAL_MODES: Record<ApprovalMode, { label: string; description: string }> = {
  supervised: { label: 'Supervised', description: 'Asks you before what the approval settings say Ask.' },
  full: { label: 'Full access', description: 'Approves everything the agent asks, a push to the default branch included.' },
};

/** Whether `value` names an Approval mode Loom has. */
export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && Object.hasOwn(APPROVAL_MODES, value);
}

export type ApprovalPolicy = Record<ApprovalCategory, ApprovalSetting>;

/** Each category, in the order Settings lists them, with its name and its default. */
export const APPROVAL_CATEGORIES: Record<ApprovalCategory, { label: string; description: string; default: ApprovalSetting }> = {
  ownPush: { label: "Push the Session's own branch", description: 'A plain push of the branch the working copy has checked out.', default: 'allow' },
  ownMergeRequest: { label: "Open or update the Session's own Merge request", description: 'gh pr create or edit, glab mr create or update.', default: 'allow' },
  mcp: { label: 'MCP and extension tools', description: "Tools from your MCP servers and OpenCode plugins.", default: 'allow' },
  writeElsewhere: { label: 'Files outside the working copy', description: 'Writing or deleting files outside the working copy and the temp directory.', default: 'ask' },
  otherPush: {
    label: 'Force push, push another branch',
    description: "Force pushes, pushes to other branches and deleting remote branches or tags. A push to the Project's default branch always asks.",
    default: 'ask',
  },
  forge: { label: 'Other Forge changes', description: 'gh and glab actions that change the Forge: merging or closing, comments, issues, releases.', default: 'ask' },
  system: { label: 'sudo and global installs', description: 'sudo, and installing packages or tools for the whole machine.', default: 'ask' },
};

/** What each category is set to until the user changes it. */
export const DEFAULT_APPROVALS = Object.fromEntries(Object.entries(APPROVAL_CATEGORIES).map(([category, { default: setting }]) => [category, setting])) as ApprovalPolicy;

/** Whether `value` names an approval category Loom has. */
export function isApprovalCategory(value: unknown): value is ApprovalCategory {
  return typeof value === 'string' && Object.hasOwn(APPROVAL_CATEGORIES, value);
}

export const DEFAULT_DIFF_COLLAPSED_PATTERNS = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',
  '*.lock',
];

/** How many auto-prompts may go in a row with no message from the user, so a broken fix loop can't spin forever. */
export const MAX_AUTO_PROMPTS = 3;

export const DEFAULT_SETTINGS: Settings = {
  worktreeRoot: '~/loom/worktrees',
  editorCommand: 'code',
  terminalCommand: '',
  diffCollapsedPatterns: DEFAULT_DIFF_COLLAPSED_PATTERNS,
  approvals: DEFAULT_APPROVALS,
  stuckAfterMinutes: 15,
  autoPromptDefault: false,
  approvalModeDefault: 'supervised',
  layout: DEFAULT_LAYOUT,
  inbox: DEFAULT_INBOX,
  diffView: DEFAULT_DIFF_VIEW,
  highlights: DEFAULT_HIGHLIGHTS,
  ...DEFAULT_APPEARANCE,
};

export type ToolStatus = 'running' | 'completed' | 'failed';

/** One choice of a `select` or `multiselect` question field. */
export interface QuestionOption {
  /** What the answer holds when it is chosen. */
  value: string;
  label: string;
  description?: string;
}

interface FieldBase {
  /** Where its value goes in the answer. */
  key: string;
  title?: string;
  description?: string;
  required: boolean;
}

/**
 * One input of a question the agent asked: its own question tool's, or a
 * dialog from the user's plugins or MCP servers (select, confirm, input,
 * editor, forms).
 * - `text`: free text, of up to `maxLength` characters, matching `pattern` if given;
 * - `select`: one of `options`;
 * - `multiselect`: some of `options`, between `minItems` and `maxItems`;
 * - `number`: a number between `minimum` and `maximum`, whole if `integer`;
 * - `boolean`: yes or no.
 */
export type QuestionField =
  | (FieldBase & { type: 'text'; default?: string; minLength?: number; maxLength?: number; pattern?: string; format?: 'email' | 'uri' | 'date' | 'date-time' })
  | (FieldBase & { type: 'select'; options: QuestionOption[]; default?: string })
  | (FieldBase & { type: 'multiselect'; options: QuestionOption[]; default?: string[]; minItems?: number; maxItems?: number })
  | (FieldBase & { type: 'number'; integer: boolean; default?: number; minimum?: number; maximum?: number })
  | (FieldBase & { type: 'boolean'; default?: boolean });

/** One field's value in an answer. */
export type AnswerValue = string | number | boolean | string[];

/** An answer to a question, by field key; fields left blank are left out. */
export type Answer = Record<string, AnswerValue>;

/**
 * - `asked`: the agent waits for the user's answer;
 * - `answered`: the user answered;
 * - `dismissed`: the user declined to answer;
 * - `expired`: the run ended before the user answered, so it can't be answered any more.
 */
export type QuestionState = 'asked' | 'answered' | 'dismissed' | 'expired';

/**
 * - `asked`: the agent waits for the user to say whether it may trust the Project's local files;
 * - `trusted` / `untrusted`: what the user said, for the Project, or what the Project already had;
 * - `expired`: as for a question.
 */
export type TrustState = 'asked' | 'trusted' | 'untrusted' | 'expired';

/**
 * - `asked`: the agent waits for the user's decision;
 * - `approved`: the user approved it once;
 * - `approved-session`: the user approved its whole category for the Session;
 * - `denied`: the user denied it, or archived the Session while it was asked;
 * - `expired`: the run ended before the user decided.
 */
export type ApprovalState = 'asked' | 'approved' | 'approved-session' | 'denied' | 'expired';

/** The user's decision on an Approval request. */
export type ApprovalDecision = 'once' | 'session' | 'deny';

/** One entry of a Session's conversation, in order. */
export type TranscriptItem =
  /** What the user sent, with what they attached to it, if anything. */
  | { kind: 'user'; id: number; text: string; attachments?: Attachment[] }
  /** `streaming` while the agent is still adding to it. */
  | { kind: 'agent'; id: number; text: string; streaming: boolean }
  /** The agent's thinking, apart from its reply; `streaming` as for `agent`. */
  | { kind: 'thinking'; id: number; text: string; streaming: boolean }
  /**
   * One tool call, kept up to date. Its `input` and `output` are capped at
   * 256 KB each, keeping head and tail around a marker; `truncated` if cut.
   * A call still running when its run ended is `failed`.
   */
  | {
      kind: 'tool';
      id: number;
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: ToolStatus;
      input?: string;
      output?: string;
      truncated?: boolean;
    }
  /**
   * A question the agent asked: its question tool, or a dialog from the
   * user's plugins or MCP servers. `answer` is set once `answered`.
   */
  | { kind: 'question'; id: number; message: string; fields: QuestionField[]; state: QuestionState; answer?: Answer }
  /** The agent asking whether to trust the Project's local files: asked once per Project. */
  | { kind: 'trust'; id: number; message: string; state: TrustState }
  /**
   * An Approval request: the agent paused before an action reaching beyond
   * its working copy. `detail` is the exact command, or the paths, it's
   * about. `category` is absent when Loom can't tell which it is in (the
   * user's own OpenCode rules asked), so it can only be approved once.
   * `defaultBranch` is set for a push to the Project's default branch,
   * which always asks. `message` is what the user told the agent on denying.
   */
  | {
      kind: 'approval';
      id: number;
      toolCallId?: string;
      title: string;
      tool: string;
      detail: string;
      category?: ApprovalCategory;
      defaultBranch?: string;
      state: ApprovalState;
      message?: string;
    }
  /** A run that failed, with the agent's message. */
  | { kind: 'error'; id: number; message: string }
  /** The run was interrupted: by the user, with Stop or to send a queued message now, or by Loom quitting or crashing. */
  | { kind: 'interruption'; id: number; by: 'stop' | 'send-now' | 'quit' }
  /**
   * The user changed the model or Effort between runs, applying from the
   * next prompt: what they picked, `model` for a new model, `effort` for a
   * new Effort level (a new model without one goes back to its default).
   */
  | { kind: 'model'; id: number; model?: string; effort?: string }
  /** A Merge request was linked to the Session: found on its branch, linked by the user or by the agent's tool. */
  | { kind: 'merge-request'; id: number; number: number; url: string }
  /** The agent's Link merge request tool named a Merge request Loom couldn't link, as `mergeRequest` gave it, and why. */
  | { kind: 'merge-request-refused'; id: number; mergeRequest: string; reason: string }
  /**
   * Babysit found feedback on the Merge request; `state` is `sent` once Send
   * to agent or auto-prompt has passed it on. `paused` when auto-prompt would
   * have, but has gone as many times in a row as it may without the user.
   */
  | { kind: 'feedback'; id: number; number: number; url: string; items: FeedbackItem[]; ci?: BabysitCi; state: 'new' | 'sent'; paused?: boolean }
  /** Babysit saw progress on the Merge request that needs nothing done. */
  | ({ kind: 'feedback-info'; id: number } & FeedbackInfo)
  /**
   * Babysit found the Merge request merged or closed: the Session was
   * archived, or, its worktree having unsaved work, left Waiting
   * (`unsaved-work`) for the user to archive or carry on.
   */
  | { kind: 'merge-request-ended'; id: number; number: number; url: string; state: EndedMergeRequestState; archived: boolean; unsavedWork?: UnsavedWork };

/** The ranges the usage dashboard covers, in days ending today. */
export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/** Tokens by kind, as the agent reported them per turn. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** Tokens of every kind, summed. */
export function totalTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
}

/**
 * What became of a Session: its Merge request `merged` or `closed`,
 * `archived` without a Merge request, or else `open` (not archived, or
 * archived with its Merge request still open).
 */
export type SessionOutcome = 'merged' | 'closed' | 'archived' | 'open';

/** A Session among the ones that used the most tokens in the range. */
export interface TopSession {
  sessionId: number;
  title: string;
  projectId: number;
  /** Its Project's name, as it was when its usage was last recorded. */
  project: string;
  /** Whether the user has removed its Project. */
  projectRemoved?: true;
  issue?: ForgeLink;
  mergeRequest?: ForgeLink;
  /** The model it used the most tokens with in the range. */
  model: string;
  tokens: number;
  /** How long it was Working in the range, in ms. */
  workingMs: number;
  outcome: SessionOutcome;
}

/**
 * The usage dashboard over the last `days` days, today included, from this
 * machine's Sessions: tokens (all kinds summed) and reported cost from the
 * turns that ended in the range, filed under the day each ended; Sessions
 * started in the range and their outcomes; runs and waits that ended in it.
 */
export interface UsageDashboard {
  days: UsageRange;
  /** Every day of the range, oldest first, as `YYYY-MM-DD` in local time, with its tokens by Project id. */
  perDay: Array<{ day: string; tokens: number; byProject: Record<number, number> }>;
  tokens: number;
  /** What the agents reported, in USD: subscription and local models report $0. */
  reportedCost: number;
  sessionsStarted: number;
  /** Sessions archived in the range whose Merge request was merged. */
  mergeRequestsMerged: number;
  /** The median agent run (Working until Waiting or archived), in ms; absent with none. */
  medianRunMs?: number;
  /** The median wait for the user (on a question or Approval request, or finished and unanswered, while Loom ran), in ms; absent with none. */
  medianWaitMs?: number;
  /** By tokens, most first; `project` is its name as its usage was last recorded. */
  perProject: Array<{ projectId: number; project: string; tokens: number; removed?: true }>;
  perModel: Array<{ model: string; tokens: number }>;
  mix: TokenCounts;
  /** Cache reads out of all prompt tokens (input, cache read and cache write), 0 to 1; absent with none. */
  cacheHitRate?: number;
  /** Of the Sessions started in the range: how many ended each way, and how many were stuck at least once. */
  outcomes: Record<SessionOutcome, number> & { stuck: number };
  /** The Sessions that used the most tokens in the range, most first, at most TOP_SESSIONS. */
  topSessions: TopSession[];
}

/** How many Sessions the dashboard's Top Sessions lists. */
export const TOP_SESSIONS = 10;

/**
 * Whether the Client's database could be opened. When `damaged`, it failed
 * `PRAGMA quick_check` or isn't a database: main serves only this topic and
 * `database.restoreLatestSnapshot` until it is restored.
 */
export type DatabaseStatus =
  | { state: 'ok' }
  | {
      state: 'damaged';
      /** The database file. */
      path: string;
      /** What SQLite reported. */
      problem: string;
      /** Every snapshot's path, newest first. */
      snapshots: string[];
    };

/**
 * A Terminal in the Dock: a shell in its Session's Environment, started in
 * the Session's working copy, running until it exits, it is closed, its
 * Session is archived or Loom quits. Nothing of it outlives Loom.
 */
export interface TerminalInfo {
  id: number;
  sessionId: number;
  /** `Terminal 1`, `Terminal 2`, …: numbered in the order the Session's terminals were opened. */
  title: string;
}

/** A terminal's size in character cells. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

/** A piece of what a terminal printed: UTF-8 bytes, which may split a character. */
export interface TerminalOutput {
  data: Uint8Array;
  /** Set on what was printed before the listener came, which is not to be acknowledged. */
  replay?: boolean;
}

/** Commands the renderer can invoke, with their parameters and results. */
export interface Commands {
  'environments.list': { params: void; result: EnvironmentStatus[] };
  /** Checks the agent again in every connected Environment, and resolves once done. */
  'environments.detect': { params: void; result: void };
  /**
   * Re-reads an Environment's shell environment, for processes started from
   * now on, then checks its agent again.
   */
  'environments.reload': { params: { id: string }; result: void };
  /** Opens an http(s) URL in the user's browser; rejects anything else. */
  'links.open': { params: { url: string }; result: void };
  /** Asks the user to choose a folder; null if they cancel. */
  'dialogs.chooseFolder': { params: void; result: string | null };
  'projects.list': { params: void; result: Project[] };
  /**
   * Adds the git checkout containing `path` as a Project, in the given
   * Environment (the native one by default). Rejects a folder that isn't in a
   * git repository, and a checkout that is already a Project. With
   * `restore`, brings back that removed Project instead (see
   * `projects.restorable`), with its name, branch prefix, trust and Sessions.
   * Resolves once its Forge has been checked.
   */
  'projects.link': { params: { path: string; environmentId?: string; restore?: number }; result: Project };
  /**
   * The removed Project that the checkout containing `path` would restore:
   * the one removed last whose identity (its origin's host and repository, or
   * else its Environment and path) matches; null with none.
   */
  'projects.restorable': { params: { path: string; environmentId?: string }; result: RestorableProject | null };
  /**
   * Removes a Project: archives its Sessions as `sessions.archive` would,
   * then hides it, keeping its Sessions and usage as history. Its checkout is
   * left on disk. Held back, touching nothing, when a Session's worktree has
   * unsaved work, unless `discard`.
   */
  'projects.remove': { params: { id: number; discard?: boolean }; result: RemoveProjectResult };
  /**
   * Sets what the Project's branch names start with. Rejects a prefix git
   * would not accept at the start of a branch name.
   */
  'projects.setBranchPrefix': { params: { id: number; branchPrefix: string }; result: Project };
  /**
   * The open issues on the Project's Forge, any of them, not only the user's,
   * matching `search` if given, as many as the Forge's CLI lists by default.
   * Rejects when the Project's Forge is off.
   */
  'projects.issues': { params: { id: number; search?: string }; result: Issue[] };
  /**
   * Fetches the Project's `origin`, then lists what a worktree Session can
   * start from (see Branches): `origin`'s branches to branch from, the
   * branches git can still check out, and the worktrees a Session can work
   * in. Rejects if `origin` can't be fetched.
   */
  'projects.branches': { params: { id: number }; result: Branches };
  /** Checks every Project's Forge again, and resolves once done. */
  'projects.check': { params: void; result: void };
  /**
   * The models the agent offers in the Project's checkout, for starting a
   * Session: asked of a private agent probe (never `opencode models`), once
   * per checkout until the agent is checked again (`environments.detect`).
   * Models the user turned off are left out.
   */
  'projects.models': { params: { id: number }; result: ModelChoice[] };
  /**
   * The commands and skills the agent offers in the Project's checkout, for
   * the composer's `/`: commands first, then skills, as the agent lists them.
   * Asked of the same agent probe as `projects.models`, and kept as long.
   * Empty when the agent can't list them.
   */
  'projects.commands': { params: { id: number }; result: AgentCommand[] };
  /**
   * The files in the Project's checkout, as `sessions.files` lists a
   * Session's, for @-mentions before a Session exists; with `ref`, the
   * files git has on that branch (`origin/main`, `loom/spike`) instead, for
   * a new worktree starting from it. Rejects a ref git doesn't know.
   */
  'projects.files': { params: { id: number; ref?: string }; result: string[] };
  /** The Loom window got focus: read every Session's branch and worktree again. */
  'sessions.check': { params: void; result: void };
  /**
   * Sets where new worktrees go. Rejects a root that is neither absolute nor
   * under `~`.
   */
  'settings.setWorktreeRoot': { params: { worktreeRoot: string }; result: Settings };
  /** Sets the editor command. Rejects an empty one, or one with an unclosed quote. */
  'settings.setEditorCommand': { params: { editorCommand: string }; result: Settings };
  /** Sets the terminal command; empty turns "Open in terminal" off. Rejects an unclosed quote. */
  'settings.setTerminalCommand': { params: { terminalCommand: string }; result: Settings };
  /**
   * Sets how many minutes without a word from a Working Session's agent make
   * it stuck, from the next agent event on. Rejects anything but a whole
   * number of at least 1.
   */
  'settings.setStuckAfterMinutes': { params: { minutes: number }; result: Settings };
  /** Sets whether Sessions started from now on have auto-prompt on. */
  'settings.setAutoPromptDefault': { params: { on: boolean }; result: Settings };
  /** Sets the Approval mode the New Session composer starts on. Rejects one Loom has not. */
  'settings.setApprovalModeDefault': { params: { mode: ApprovalMode }; result: Settings };
  /** Sets which files the Changes view shows collapsed; blank patterns are dropped. */
  'settings.setDiffCollapsedPatterns': { params: { patterns: string[] }; result: Settings };
  /**
   * Sets whether the agent asks before actions of `category`. Agents
   * started from now on get the new rules. Loom answers by the new setting
   * at once what running agents still ask, so going to Allow takes effect
   * at once; going to Ask, only for agents started after.
   */
  'settings.setApproval': { params: { category: ApprovalCategory; setting: ApprovalSetting }; result: Settings };
  /** Sets the theme or fonts given. Rejects one not in Loom's lists. */
  'settings.setAppearance': { params: Partial<Appearance>; result: Settings };
  /** Sets the width (in the Side area) or height (in the Dock) of a Panel kind in the Layout, kept within its minimum and maximum. */
  'settings.setPanelSize': { params: { kind: PanelKind; dimension: PanelDimension; size: number }; result: Settings };
  /** Sets the area a Panel kind sits in, in the Layout. Rejects a kind or an area Loom has not. */
  'settings.setPanelArea': { params: { kind: PanelKind; area: PanelArea }; result: Settings };
  /** Sets the Inbox's width (kept within its least and most), whether it is shown, or both. */
  'settings.setInbox': { params: Partial<InboxSettings>; result: Settings };
  /** Sets the Changes view's layout, all of it. Rejects anything but true or false. */
  'settings.setDiffView': { params: DiffViewSettings; result: Settings };
  /**
   * Sets Session highlights, all of it: on, Sessions are checked for
   * Highlights from their next turn, with `model` (required while on) and
   * `effort`. Off, no Session is checked, and its Highlights stay.
   */
  'settings.setHighlights': { params: HighlightsSettings; result: Settings };
  'sessions.list': { params: void; result: Session[] };
  /**
   * Starts a Session on a Project and sends it its first prompt. Resolves with
   * the new Session, Working, once its record exists; the run goes on after.
   *
   * A `worktree` Session gets its own git worktree: Loom fetches `origin` and
   * branches from `origin/<default branch>` as `branch` (by default
   * `<prefix>/<slug of the prompt>`, see suggestBranch), adding `-2`, `-3`, …
   * if that is taken, in a new folder under the worktree root. Files the
   * checkout's `.worktreeinclude` lists that git ignores are copied in. It
   * rejects if any of that fails. A `checkout` Session stays on whatever
   * branch the Project's checkout has.
   *
   * `base` names another `origin` branch to branch from instead, without
   * `origin/`; it rejects if `origin` has no such branch.
   *
   * A `worktree` Session given an `existing` working copy names no new
   * branch (`branch` and `base` are not allowed):
   * - `{ branch }` checks that branch out as-is in a new worktree, in a
   *   folder named after it: a local one, or for one on `origin`, its
   *   same-named local branch, created to track it if there is none.
   *   `.worktreeinclude` files are copied in all the same. It rejects a
   *   branch checked out in another worktree, naming it.
   * - `{ worktree }`, the path of a worktree Branches lists, works in it as
   *   it is, on whatever it has checked out; nothing is fetched or copied.
   *   It rejects a locked worktree. Other Sessions may work in it too:
   *   archiving the last of them removes the worktree, as for any worktree
   *   Session.
   *
   * Started from an `issue`, the Session is linked to it, its first prompt
   * starts with the issue's number, title, URL and body (`prompt` may then be
   * empty), and the branch suggested is `<prefix>/<issue#>-<slug of the title>`.
   *
   * `model` (see `projects.models`) and `effort` are what its first prompt
   * runs with; the agent's default model, or the model's default Effort,
   * while absent.
   *
   * `attachments` go with the first prompt (see `sessions.send`).
   *
   * `approvalMode` is the Session's for good; the `approvalModeDefault`
   * setting while absent. Rejects one Loom has not.
   */
  'sessions.create': {
    params: {
      projectId: number;
      workingCopy: WorkingCopyKind;
      branch?: string;
      base?: string;
      existing?: ExistingWorkingCopy;
      issue?: Issue;
      prompt: string;
      attachments?: NewAttachment[];
      approvalMode?: ApprovalMode;
    } & ModelPick;
    result: Session;
  };
  /**
   * Sends a prompt to a Waiting Session, which becomes Working. While the
   * Session is Working, the prompt joins its queue instead, sent once the runs
   * before it settle. A stuck Session's run is interrupted for it, as with
   * `sessions.sendNow`. Rejects while the agent waits on an answer.
   *
   * `attachments` are stored at once and go to the agent with the prompt;
   * the prompt may then be empty. Rejects more than MAX_ATTACHMENTS, one
   * over MAX_ATTACHMENT_BYTES, and one with no name.
   *
   * `comments` follow the prompt's text as blocks, in order: a diff
   * comment's `path:start-end`, its quoted lines and its note; a
   * conversation comment's passage, quoted, and its note. The prompt may
   * then be empty. Rejects a comment with no note, or nothing quoted.
   */
  'sessions.send': { params: { id: number; prompt: string; attachments?: NewAttachment[]; comments?: MessageComment[] }; result: void };
  /**
   * The files in the Session's working copy, for @-mentions: tracked and
   * untracked ones git doesn't ignore, as paths relative to it with `/`, by
   * path, at most MAX_LISTED_FILES. Rejects for an archived Session, or one
   * whose worktree is missing.
   */
  'sessions.files': { params: { id: number }; result: string[] };
  /**
   * Interrupts the Session's run without sending its queue, which it keeps:
   * the Session goes Waiting (stopped). Rejects when no run is going.
   */
  'sessions.stop': { params: { id: number }; result: void };
  /** Drops a message from the Session's queue. */
  'sessions.removeQueued': { params: { id: number; queuedId: number }; result: void };
  /**
   * Sends a queued message now: a run going is interrupted first, which the
   * transcript shows; the rest of the queue stays.
   */
  'sessions.sendNow': { params: { id: number; queuedId: number }; result: void };
  /**
   * Changes the model the Session runs on, `provider/model`, or its Effort
   * level, or both, from the next prompt, adding a marker to its timeline.
   * A new model goes back to its default Effort unless one is given. Only
   * between runs: rejects while the agent is Working or waits on an answer,
   * and for a Session that can take no prompt (archived, its worktree
   * missing). A running agent is switched at once and
   * rejects a model or Effort level it doesn't offer, changing nothing;
   * with none running, the change is checked against `projects.models`
   * when they can be listed. Changes go one at a time, in order, and a
   * prompt sent meanwhile waits for them, coming after their markers.
   */
  'sessions.setModel': { params: { id: number } & ModelPick; result: void };
  /** Gives a queued message to the agent mid-run, for an agent that can be steered (`canSteer`). */
  'sessions.steer': { params: { id: number; queuedId: number }; result: void };
  /**
   * Archives a Session, stopping its agent, mid-run if Working. A checkout
   * Session's checkout is left as it is. A worktree Session's worktree is
   * removed, keeping its local branch and never touching the remote; if the
   * worktree has uncommitted changes or commits on no remote branch, it
   * resolves with that unsaved work and archives nothing, unless `discard`.
   * A worktree another Session that isn't archived works in is left to it,
   * as a checkout is.
   * A Session whose worktree is missing archives as it is.
   */
  'sessions.archive': { params: CloseSessionParams; result: ArchiveResult };
  /**
   * Deletes a Session for good, whatever its status: its agent is stopped
   * and its worktree removed as `sessions.archive` would (its local branch
   * kept, held back by unsaved work unless `discard`), then its record, its
   * conversation and its attachments are gone. Its usage still counts on the
   * dashboard. Rejects while the Session is being archived or reopened.
   */
  'sessions.delete': { params: CloseSessionParams; result: DeleteResult };
  /**
   * Asks a Waiting Session's agent to open its branch's Merge request, or
   * update it, with a canned prompt; Loom never creates one itself. Rejects
   * when the Project's Forge is off or not checked yet, when the working copy
   * is on the default branch or on no branch. Queued while the Session is Working.
   */
  'sessions.requestMergeRequest': { params: { id: number }; result: void };
  /**
   * Links the Merge request `mergeRequest` names to the Session by hand, for
   * what the lookup after each turn misses: its number (`12`, `#12`, `!12`)
   * or its URL on the Project's Forge. Checked on the Forge first: rejects one
   * it doesn't have, or that is merged or closed, and a Session on the
   * default branch, archived, or whose Project's Forge is off. The link stays
   * while the Session's branch does, even if no open Merge request is found
   * on that branch.
   */
  'sessions.linkMergeRequest': { params: { id: number; mergeRequest: string }; result: void };
  /**
   * The Session's Merge request as its Forge has it now, for its Panel: its
   * state, branches, commits and changes, its checks, and its reviews and
   * comments. Rejects with no Merge request linked, or the Project's Forge
   * off or out of reach.
   */
  'sessions.mergeRequest': { params: { id: number }; result: MergeRequestDetails };
  /** The Session's Merge request's diff as its Forge has it now, for its Panel's Diff tab: rejects as `sessions.mergeRequest` does. */
  'sessions.mergeRequestDiff': { params: { id: number }; result: MergeRequestDiff };
  /**
   * Squashes and merges the Session's Merge request on its Forge, as the user
   * confirmed in its Panel: one commit titled `title`, merged only while its
   * source branch is still at `head`. The user's own confirmation stands for
   * an Approval request. Resolves to its state just after: still open when
   * the Forge merges it later (a merge queue, or once its pipeline passes).
   * Rejects with what the Forge said when it won't merge it, and as
   * `sessions.mergeRequest` does.
   */
  'sessions.squashAndMerge': { params: { id: number; title: string; head: string }; result: { state?: MergeRequestState } };
  /**
   * Sends the agent the feedback on card `itemId`, as one message, queued if
   * the Session is Working. Rejects when the card has been sent already.
   */
  'sessions.sendFeedback': { params: { id: number; itemId: number }; result: void };
  /**
   * Replies `body` (Markdown) to review thread `thread` of the Session's
   * Merge request, on its Forge, as the user asked in a note on the diff;
   * Babysit then reads the Merge request again. Rejects an archived Session,
   * an empty reply, and as `sessions.mergeRequest` does.
   */
  'sessions.replyToReviewThread': { params: { id: number; thread: string; body: string }; result: void };
  /** Resolves review thread `thread` of the Session's Merge request on its Forge, then has Babysit read it again; rejects as `sessions.replyToReviewThread` does. */
  'sessions.resolveReviewThread': { params: { id: number; thread: string }; result: void };
  /** Starts or stops Babysit watching the Session's Merge request; started again, it reports what came meanwhile. Rejects an archived Session. */
  'sessions.setBabysitting': { params: { id: number; on: boolean }; result: void };
  /** Turns auto-prompt on or off for the Session; rejects an archived Session or one whose worktree is gone. */
  'sessions.setAutoPrompt': { params: { id: number; on: boolean }; result: void };
  /**
   * Runs the editor command on the Session's working copy, or on `file`, a
   * path relative to it, in the Session's Environment. Resolves once the
   * editor has started. Rejects a file outside the working copy, and when the
   * editor isn't on the Environment's PATH.
   */
  'sessions.openInEditor': { params: { id: number; file?: string }; result: void };
  /**
   * Works out the Session's diff (and the Glance strip's diff stat) again, in its
   * Environment. Never fetches. Not available for an archived checkout
   * Session, or an archived worktree Session whose branch is gone.
   */
  'sessions.diff': { params: { id: number; scope?: DiffScope }; result: DiffSummary };
  /**
   * What the Session's working copy holds now, as a string that changes
   * whenever its diff may have: a commit, a file added, removed or edited,
   * by the agent or anyone else. Cheap enough to ask every few seconds.
   * Never fetches.
   */
  'sessions.diffFingerprint': { params: { id: number }; result: string };
  /**
   * The `origin/…` branches the Session's diff can be against, as the local
   * refs have them, by name. Never fetches.
   */
  'sessions.diffBases': { params: { id: number }; result: string[] };
  /**
   * Sets the start base the Session's diff is against, `origin/<branch>`,
   * for its current branch, in the repository's local git config; it stays
   * with the branch. Rejects one the local refs don't have, a Session that
   * isn't on a branch, and an archived Session.
   */
  'sessions.setDiffBase': { params: { id: number; base: string }; result: void };
  /** One file of the Session's diff, as `sessions.diff` listed it. */
  'sessions.diffFile': { params: { id: number; path: string; scope?: DiffScope }; result: FileDiff };
  /**
   * Runs the terminal command in the Session's working copy, in its
   * Environment. Rejects when no terminal command is set.
   */
  'sessions.openInTerminal': { params: { id: number }; result: void };
  /**
   * Sends a Session Waiting on an error its last prompt again, starting its
   * Environment again first if that failed to start. Rejects unless the
   * prompt went unanswered: its conversation ends with the error right after it.
   */
  'sessions.retry': { params: { id: number }; result: void };
  /**
   * Has the agent go on with the run Loom quit or crashed during: the
   * Session, Waiting as interrupted, becomes Working, and its agent is sent
   * CONTINUE_PROMPT in its resumed conversation. Rejects for any other Session.
   */
  'sessions.continue': { params: { id: number }; result: void };
  /**
   * Answers the question of the transcript item `itemId`, or dismisses it
   * when `answer` is null; once nothing else is asked, the Session is
   * Working again. Rejects unless that question is still asked, and an
   * answer that doesn't fit its fields: a required one left blank, a value
   * of the wrong type, not among the options or out of bounds.
   */
  'sessions.answer': { params: { id: number; itemId: number; answer: Answer | null }; result: void };
  /**
   * Answers the trust request of the transcript item `itemId`. The Project
   * keeps the answer: later requests in any of its Sessions get it without
   * asking, and any other Session waiting on one is answered too. Rejects
   * unless that request is still asked.
   */
  'sessions.trust': { params: { id: number; itemId: number; trusted: boolean }; result: void };
  /**
   * Decides the Approval request of the transcript item `itemId`: approves
   * it once; approves it and, for the rest of the Session, every request of
   * its category (Loom answers them itself, never writing the agent's
   * config); or denies it, `message` going to the agent as the next prompt
   * once its run ends. Once nothing else is asked, the Session is Working
   * again. Rejects unless that request is still asked, and `session` for
   * one with no category or a push to the default branch.
   */
  'sessions.approve': { params: { id: number; itemId: number; decision: ApprovalDecision; message?: string }; result: void };
  /**
   * Opens a terminal of `cols` by `rows` for the Session: the user's login
   * shell, in its working copy, in its Environment, with the Environment's
   * full environment. Rejects for an archived Session, one whose worktree is
   * missing, and in a native Windows Environment (WSL is fine).
   */
  'terminals.open': { params: { sessionId: number } & TerminalSize; result: TerminalInfo };
  /** Types `data` into the terminal. */
  'terminals.write': { params: { id: number; data: string }; result: void };
  /** Sets the terminal's size in character cells. */
  'terminals.resize': { params: { id: number } & TerminalSize; result: void };
  /**
   * Says `bytes` of the terminal's output have been shown. Until they are,
   * the shell is held back once it gets far enough ahead, so a flood of
   * output never outruns the screen.
   */
  'terminals.ack': { params: { id: number; bytes: number }; result: void };
  /** Closes the terminal, killing its shell and everything it started. */
  'terminals.close': { params: { id: number }; result: void };
  /**
   * Renames a Session, whatever its status: `title`, trimmed, from now on.
   * Rejects an empty title.
   */
  'sessions.rename': { params: { id: number; title: string }; result: void };
  /**
   * Links a Session to an issue on its Project's Forge, in place of any it
   * had, while its Project is there. Rejects an issue with no number or no
   * http(s) link.
   */
  'sessions.linkIssue': { params: { id: number; issue: ForgeLink }; result: void };
  /**
   * Keeps a Session's Panels as the user left them: which are open in each
   * Panel area, the one shown and whether each area is shown. Its Terminals'
   * Panels don't come back once Loom quits, as the Terminals end with it.
   * Rejects Panels Loom has not, or one open twice.
   */
  'sessions.setPanels': { params: { id: number; panels: SessionPanels }; result: void };
  /**
   * Resolves one of a Session's Highlights by hand, or reopens one resolved
   * (by the user or the model). Rejects a Highlight the Session hasn't.
   */
  'sessions.resolveHighlight': { params: { id: number; highlightId: number; resolved: boolean }; result: void };
  /** The user has looked at the Session's Highlights Panel: what it has so far is seen, and its tab's badge goes. */
  'sessions.seeHighlights': { params: { id: number }; result: void };
  /** Marks a Session read (the user opened it) or unread again. */
  'sessions.setUnread': { params: { id: number; unread: boolean }; result: void };
  /**
   * Snoozes a Waiting Session until `until`, a clock time to come: it leaves
   * the Inbox and comes back unread then, or as soon as its status changes.
   * `null` ends the snooze now. Rejects a Session that isn't Waiting or
   * whose worktree is missing, and a time that isn't to come.
   */
  'sessions.snooze': { params: { id: number; until: number | null }; result: void };
  /** The usage dashboard over the last `days` days (see UsageDashboard). Rejects a range not in USAGE_RANGES. */
  'usage.dashboard': { params: { days: UsageRange }; result: UsageDashboard };
  /**
   * Moves the damaged database file (and its -wal and -shm) aside under a
   * timestamped name, copies the latest snapshot into its place, and starts.
   * Rejects when the database isn't damaged or there is no snapshot.
   */
  'database.restoreLatestSnapshot': { params: void; result: void };
}

/** Topics the renderer can subscribe to, with the value each one carries. */
export interface Topics {
  environments: EnvironmentStatus[];
  /** Every Project, by name. */
  projects: Project[];
  /** Every removed Project, by name. */
  removedProjects: RemovedProject[];
  settings: Settings;
  /** Every Session, newest first. */
  sessions: Session[];
  /** One Session's conversation, as it streams in. */
  transcript: TranscriptItem[];
  /** One Session's Panels in each Panel area, as the user left them. */
  panels: SessionPanels;
  /** One Session's Highlights, and how checking them goes. */
  highlights: SessionHighlights;
  /** One Session's open terminals, in the order they were opened. */
  terminals: TerminalInfo[];
  /**
   * What one terminal prints: first the end of what it printed so far
   * (TERMINAL_REPLAY_BYTES at most, possibly nothing, marked `replay`), then
   * each new piece, to be acknowledged with `terminals.ack` once shown.
   */
  terminalOutput: TerminalOutput;
  database: DatabaseStatus;
}

/** What the topics that need one are subscribed with. */
export interface TopicParams {
  transcript: { sessionId: number };
  panels: { sessionId: number };
  highlights: { sessionId: number };
  terminals: { sessionId: number };
  terminalOutput: { id: number };
}

/** How much of what a terminal printed main keeps, to show it to a new listener. */
export const TERMINAL_REPLAY_BYTES = 1 << 20;

export type CommandName = keyof Commands;
export type TopicName = keyof Topics;
/** The arguments after the listener that subscribing to `T` takes. */
export type TopicArgs<T extends TopicName> = T extends keyof TopicParams ? [params: TopicParams[T]] : [];

export type Unsubscribe = () => void;

export interface LoomApi {
  invoke<C extends CommandName>(
    command: C,
    ...params: Commands[C]['params'] extends void ? [] : [Commands[C]['params']]
  ): Promise<Commands[C]['result']>;
  /**
   * Calls `listener` with the topic's current value right away, then with
   * every new value until unsubscribed.
   */
  subscribe<T extends TopicName>(topic: T, listener: (value: Topics[T]) => void, ...params: TopicArgs<T>): Unsubscribe;
}
