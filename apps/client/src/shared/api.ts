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

/** Where a Session's agent works. */
export interface WorkingCopy {
  kind: WorkingCopyKind;
  /** The working copy's folder, in its Project's Environment. */
  path: string;
}

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
}

export const DEFAULT_SETTINGS: Settings = { worktreeRoot: '~/loom/worktrees', editorCommand: 'code', terminalCommand: '', ...DEFAULT_APPEARANCE };

/** One entry of a Session's conversation, in order. */
export type TranscriptItem =
  | { kind: 'user'; id: number; text: string }
  /** `streaming` while the agent is still adding to it. */
  | { kind: 'agent'; id: number; text: string; streaming: boolean }
  /** A run that failed, with the agent's message. */
  | { kind: 'error'; id: number; message: string };

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
  /** Checks every Project's Forge again, and resolves once done. */
  'projects.check': { params: void; result: void };
  /**
   * Sets where new worktrees go. Rejects a root that is neither absolute nor
   * under `~`.
   */
  'settings.setWorktreeRoot': { params: { worktreeRoot: string }; result: Settings };
  /** Sets the editor command. Rejects an empty one, or one with an unclosed quote. */
  'settings.setEditorCommand': { params: { editorCommand: string }; result: Settings };
  /** Sets the terminal command; empty turns "Open in terminal" off. Rejects an unclosed quote. */
  'settings.setTerminalCommand': { params: { terminalCommand: string }; result: Settings };
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
   * Started from an `issue`, the Session is linked to it, its first prompt
   * starts with the issue's number, title, URL and body (`prompt` may then be
   * empty), and the branch suggested is `<prefix>/<issue#>-<slug of the title>`.
   */
  'sessions.create': {
    params: { projectId: number; workingCopy: WorkingCopyKind; branch?: string; issue?: Issue; prompt: string };
    result: Session;
  };
  /**
   * Sends a prompt to a Waiting Session, which becomes Working. Rejects while
   * the Session is Working.
   */
  'sessions.send': { params: { id: number; prompt: string }; result: void };
  /**
   * Archives a Session, stopping its agent, mid-run if Working. Only checkout
   * Sessions so far, which archive without touching the checkout.
   */
  'sessions.archive': { params: { id: number }; result: void };
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
   * Runs the terminal command in the Session's working copy, in its
   * Environment. Rejects when no terminal command is set.
   */
  'sessions.openInTerminal': { params: { id: number }; result: void };
  /** Marks a Session read (the user opened it) or unread again. */
  'sessions.setUnread': { params: { id: number; unread: boolean }; result: void };
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
