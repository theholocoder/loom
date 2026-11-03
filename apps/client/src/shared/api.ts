// The typed API between the renderer and main. The renderer talks to main
// only through this: commands it invokes, and topics it subscribes to. It is
// also the seam tests drive main through (seam A) and fake for the renderer
// (seam B), so everything the UI can see or do goes through here.
import { DEFAULT_APPEARANCE, type Appearance } from './appearance';

/** What the Environment's bridge reported in its handshake. */
export interface BridgeInfo {
  protocolVersion: number;
  /** The Client version the bridge was built with. */
  version: string;
  os: string;
  arch: string;
  /** The user's home folder in the Environment, which `~` means there. */
  home: string;
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

/** The branch prefix a new Project gets. */
export const DEFAULT_BRANCH_PREFIX = 'loom';

/**
 * - `working`: the agent is running; the Session doesn't need the user.
 * - `waiting`: the Session needs the user; `waitingReason` says why.
 * - `archived`: closed, kept for history.
 */
export type SessionStatus = 'working' | 'waiting' | 'archived';

export type WaitingReason = 'finished' | 'stopped' | 'question' | 'approval' | 'stuck' | 'error' | 'interrupted' | 'feedback';

/**
 * - `worktree`: the Session's own git worktree.
 * - `checkout`: the Project's checkout itself, on whatever branch it has.
 */
export type WorkingCopyKind = 'worktree' | 'checkout';

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
   * The branches git can still check out, local ones first, each by name:
   * local branches not checked out in the checkout or any worktree, and
   * `origin`'s branches whose same-named local branch isn't either.
   */
  existing: ExistingBranch[];
  /** The checkout's other worktrees, the Project's checkout itself left out, in `git worktree list` order. */
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

/** What `sessions.archive` did: archived, or held back by unsaved work. */
export type ArchiveResult = { archived: true } | { archived: false; unsavedWork: UnsavedWork };

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
  status: SessionStatus;
  /**
   * Set when a worktree Session's worktree is gone, deleted outside Loom: it
   * can only be archived. Checked with its branch: after each turn, when
   * the Session is opened and when its Environment connects.
   */
  worktreeMissing?: boolean;
  /**
   * What its branch changed against the merge-base with its start base, for
   * the Session header's changes control: worked out after each turn and when the Session is
   * opened, kept in memory only. Absent until known.
   */
  diffStat?: DiffStat;
  /** Why the Session is `waiting`. */
  waitingReason?: WaitingReason;
  /** What went wrong, when waiting on an `error`. */
  error?: string;
  /**
   * Whether the Session has news the user hasn't opened yet. Set when it goes
   * Waiting, cleared when the user opens or replies to it.
   */
  unread: boolean;
  /** Clock time the Session was started. */
  createdAt: number;
  /** Clock time its status last changed. */
  updatedAt: number;
}

/** A diff's size: files changed, lines added and removed. Untracked files count as files of added lines. */
export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}

/** How a file in a Session's diff changed: committed on its branch, changed since its last commit, or new to git. */
export type DiffFileStatus = 'committed' | 'modified' | 'untracked';

/** One file of a Session's diff. */
export interface DiffFile {
  /** Its path in the working copy, with `/`. */
  path: string;
  /** Where it was before a rename. */
  oldPath?: string;
  status: DiffFileStatus;
  added: number;
  removed: number;
  binary: boolean;
  /** An untracked file past the counting limit: listed, but its lines aren't counted or read. */
  uncounted?: boolean;
}

/**
 * A Session's diff: its working tree against the merge-base of HEAD and its
 * start base (`origin/<default branch>`, as the local ref has it), or against
 * HEAD for uncommitted changes only. An archived worktree Session's is its
 * branch's commits, read-only.
 */
export type DiffSummary =
  | { available: false; reason: string }
  | { available: true; readOnly: boolean; base: string; files: DiffFile[] };

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
  /** Files the diff panel shows collapsed, as glob patterns on a path or file name (`*` matches within a folder). */
  diffCollapsedPatterns: string[];
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

export const DEFAULT_SETTINGS: Settings = {
  worktreeRoot: '~/loom/worktrees',
  editorCommand: 'code',
  terminalCommand: '',
  diffCollapsedPatterns: DEFAULT_DIFF_COLLAPSED_PATTERNS,
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

/** One entry of a Session's conversation, in order. */
export type TranscriptItem =
  | { kind: 'user'; id: number; text: string }
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
  /** A run that failed, with the agent's message. */
  | { kind: 'error'; id: number; message: string };

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
   * git repository, and a checkout that is already a Project. Resolves once
   * its Forge has been checked.
   */
  'projects.link': { params: { path: string; environmentId?: string }; result: Project };
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
   * Fetches the Project's `origin`, then lists the branches a worktree Session
   * can branch from (`origin`'s) or check out (those, and local branches not
   * checked out anywhere). Rejects if `origin` can't be fetched.
   */
  'projects.branches': { params: { id: number }; result: Branches };
  /** Checks every Project's Forge again, and resolves once done. */
  'projects.check': { params: void; result: void };
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
  /** Sets which files the diff panel shows collapsed; blank patterns are dropped. */
  'settings.setDiffCollapsedPatterns': { params: { patterns: string[] }; result: Settings };
  /** Sets the theme or fonts given. Rejects one not in Loom's lists. */
  'settings.setAppearance': { params: Partial<Appearance>; result: Settings };
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
   * A `worktree` Session given an `existingBranch` checks that branch out
   * as-is instead, in a folder named after it: a local one, or for one on
   * `origin`, its same-named local branch, created to track it if there is
   * none. `branch` and `base` are then not allowed. `.worktreeinclude` files
   * are copied in all the same.
   *
   * A `worktree` Session given an `existingWorktree`, the path of one of the
   * checkout's other worktrees (see Branches), works in that worktree as it
   * is, on whatever it has checked out; nothing is fetched or copied. It is
   * a worktree Session like any other: archiving it removes the worktree.
   * `branch`, `base` and `existingBranch` are then not allowed.
   *
   * Started from an `issue`, the Session is linked to it, its first prompt
   * starts with the issue's number, title, URL and body (`prompt` may then be
   * empty), and the branch suggested is `<prefix>/<issue#>-<slug of the title>`.
   */
  'sessions.create': {
    params: {
      projectId: number;
      workingCopy: WorkingCopyKind;
      branch?: string;
      base?: string;
      existingBranch?: ExistingBranch;
      existingWorktree?: string;
      issue?: Issue;
      prompt: string;
    };
    result: Session;
  };
  /**
   * Sends a prompt to a Waiting Session, which becomes Working. Rejects while
   * the Session is Working.
   */
  'sessions.send': { params: { id: number; prompt: string }; result: void };
  /**
   * Archives a Session, stopping its agent, mid-run if Working. A checkout
   * Session's checkout is left as it is. A worktree Session's worktree is
   * removed, keeping its local branch and never touching the remote; if the
   * worktree has uncommitted changes or commits on no remote branch, it
   * resolves with that unsaved work and archives nothing, unless `discard`.
   * A Session whose worktree is missing archives as it is.
   */
  'sessions.archive': { params: { id: number; discard?: boolean }; result: ArchiveResult };
  /**
   * Asks a Waiting Session's agent to open its branch's Merge request, or
   * update it, with a canned prompt; Loom never creates one itself. Rejects
   * when the Project's Forge is off or not checked yet, when the working copy
   * is on the default branch or on no branch, and while the Session is Working.
   */
  'sessions.requestMergeRequest': { params: { id: number }; result: void };
  /**
   * Runs the editor command on the Session's working copy, or on `file`, a
   * path relative to it, in the Session's Environment. Resolves once the
   * editor has started. Rejects a file outside the working copy, and when the
   * editor isn't on the Environment's PATH.
   */
  'sessions.openInEditor': { params: { id: number; file?: string }; result: void };
  /**
   * Works out the Session's diff (and the Session header's changes control) again, in its
   * Environment. Never fetches. Not available for an archived checkout
   * Session, or an archived worktree Session whose branch is gone.
   */
  'sessions.diff': { params: { id: number; uncommittedOnly?: boolean }; result: DiffSummary };
  /** One file of the Session's diff, as `sessions.diff` listed it. */
  'sessions.diffFile': { params: { id: number; path: string; uncommittedOnly?: boolean }; result: FileDiff };
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
  /** Marks a Session read (the user opened it) or unread again. */
  'sessions.setUnread': { params: { id: number; unread: boolean }; result: void };
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
  settings: Settings;
  /** Every Session, newest first. */
  sessions: Session[];
  /** One Session's conversation, as it streams in. */
  transcript: TranscriptItem[];
  database: DatabaseStatus;
}

/** What the topics that need one are subscribed with. */
export interface TopicParams {
  transcript: { sessionId: number };
}

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
