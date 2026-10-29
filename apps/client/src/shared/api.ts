// The typed API between the renderer and main. The renderer talks to main
// only through this: commands it invokes, and topics it subscribes to. It is
// also the seam tests drive main through (seam A) and fake for the renderer
// (seam B), so everything the UI can see or do goes through here.

/** What the Environment's bridge reported in its handshake. */
export interface BridgeInfo {
  protocolVersion: number;
  /** The Client version the bridge was built with. */
  version: string;
  os: string;
  arch: string;
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
}

/** Topics the renderer can subscribe to, with the value each one carries. */
export interface Topics {
  environments: EnvironmentStatus[];
}

export type CommandName = keyof Commands;
export type TopicName = keyof Topics;

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
  subscribe<T extends TopicName>(topic: T, listener: (value: Topics[T]) => void): Unsubscribe;
}
