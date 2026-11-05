import type { ChildProcess } from 'node:child_process';
import { OPENCODE_NAME, type BridgeInfo, type EnvironmentStatus, type ModelChoice, type ShellEnvironmentSource } from '../../shared/api';
import { detectOpenCode, listOpenCodeModels } from '../agents/opencode';
import type { Clock, TimerHandle } from '../clock';
import { BridgeConnection } from './bridge-connection';
import type { Channel, ChannelParams } from './channel';

export type SpawnBridge = (command: string, args: string[]) => ChildProcess;

export const HANDSHAKE_TIMEOUT_MS = 20_000;
export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MS = 10_000;
/** How long to wait before each restart of a bridge that died; after the last, the Environment is failed. */
export const RESTART_BACKOFF_MS = [1_000, 5_000, 30_000];
/** Resolving the shell environment runs the shell twice at most, 5 s each. */
export const SHELL_ENVIRONMENT_TIMEOUT_MS = 15_000;
/** The bridge protocol version this Client speaks. */
export const PROTOCOL_VERSION = 2;

export interface EnvironmentOptions {
  id: string;
  label: string;
  bridgePath: string;
  /** The Client's version, which the bridge must have been built with. */
  appVersion: string;
  clock: Clock;
  spawnBridge: SpawnBridge;
  onChange: (status: EnvironmentStatus) => void;
}

/** One Environment, driven through its long-lived loom-bridge process. */
export class Environment {
  private connection: BridgeConnection | undefined;
  private current: EnvironmentStatus;
  private pingTimer: TimerHandle | undefined;
  private stopped = false;
  private detecting: Promise<void> | undefined;
  private child: ChildProcess | undefined;
  private restartTimer: TimerHandle | undefined;
  /** Restarts tried since the bridge last connected. */
  private restarts = 0;
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  /** The models the agent offers, by checkout, until the agent is checked again. */
  private models = new Map<string, Promise<ModelChoice[]>>();

  constructor(private readonly options: EnvironmentOptions) {
    this.current = { id: options.id, label: options.label, state: 'starting' };
  }

  get status(): EnvironmentStatus {
    return this.current;
  }

  /** Starts the bridge. A bridge that fails to start leaves the Environment failed. */
  start(): Promise<void> {
    return this.connect();
  }

  /**
   * Starts a failed Environment's bridge again, as Retry does; nothing
   * happens unless it is failed.
   */
  async restart(): Promise<void> {
    if (this.current.state !== 'failed' || this.stopped) return;
    this.restarts = 0;
    await this.connect();
  }

  /**
   * Resolves once the Environment is connected, waiting while its bridge
   * starts or restarts; rejects if it fails to start.
   */
  ready(): Promise<void> {
    if (this.current.state === 'connected') return Promise.resolve();
    if (this.current.state === 'failed' || this.stopped) return Promise.reject(this.failure());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async connect(): Promise<void> {
    const { clock } = this.options;
    if (this.current.state !== 'starting') this.update({ state: 'starting' });
    let child: ChildProcess;
    try {
      child = this.options.spawnBridge(this.options.bridgePath, []);
    } catch (error) {
      this.startFailed((error as Error).message);
      return;
    }
    const connection = new BridgeConnection(child, clock);
    this.connection = connection;
    this.child = child;
    connection.onClose((reason) => {
      // A bridge that dies while starting fails its handshake, handled below.
      if (this.connection !== connection || this.stopped) return;
      if (this.current.state !== 'connected' && this.current.state !== 'unresponsive') return;
      this.cancelPing();
      this.update({ state: 'disconnected', error: reason.message });
      this.scheduleRestart();
    });
    try {
      const bridge = await connection.request<BridgeInfo>('handshake', HANDSHAKE_TIMEOUT_MS);
      if (bridge.protocolVersion !== PROTOCOL_VERSION || bridge.version !== this.options.appVersion) {
        throw new Error(
          `loom-bridge ${bridge.version} (protocol ${bridge.protocolVersion}) does not match Loom ${this.options.appVersion} (protocol ${PROTOCOL_VERSION})`,
        );
      }
      if (this.stopped) return;
      this.restarts = 0;
      this.update({ state: 'connected', bridge, error: undefined, lastSeenAt: clock.now() });
      this.schedulePing(connection);
    } catch (error) {
      child.kill();
      this.startFailed((error as Error).message);
      return;
    }
    try {
      await this.readShellEnvironment(connection, 'environment.get');
    } catch {
      // Either the bridge went away, which its close listener has reported,
      // or it was slow; detecting below covers both.
    }
    await this.detectAgent();
  }

  /**
   * A start that failed: during restarts, the next one is tried after its
   * backoff; otherwise, or once they're used up, the Environment is failed.
   */
  private startFailed(error: string): void {
    if (this.stopped) return;
    if (this.restarts > 0 && this.restarts < RESTART_BACKOFF_MS.length) {
      this.update({ state: 'disconnected', error });
      this.scheduleRestart();
    } else {
      this.update({ state: 'failed', error });
    }
  }

  /** Starts the bridge again after the next backoff delay. */
  private scheduleRestart(): void {
    if (this.stopped) return;
    const delay = RESTART_BACKOFF_MS[this.restarts++]!;
    this.restartTimer = this.options.clock.setTimeout(() => {
      this.restartTimer = undefined;
      void this.connect();
    }, delay);
  }

  private failure(): Error {
    return new Error(this.current.error ? `${this.options.label} could not start: ${this.current.error}` : `${this.options.label} is not connected`);
  }

  /**
   * Checks the Environment's agent, unless the bridge isn't connected. A
   * check already running is joined rather than repeated.
   */
  detectAgent(): Promise<void> {
    const connection = this.connected();
    if (!connection) return Promise.resolve();
    // Checked again, the agent may offer other models: the user signed in to a provider, or out.
    this.models.clear();
    this.detecting ??= (async () => {
      const previous = this.current.agent ?? { name: OPENCODE_NAME, state: 'unknown' as const };
      this.update({ agent: { ...previous, checking: true } });
      const agent = await detectOpenCode((method, timeoutMs, params) => connection.request(method, timeoutMs, params));
      if (this.connection === connection) this.update({ agent: { ...agent, checking: false } });
    })().finally(() => (this.detecting = undefined));
    return this.detecting;
  }

  /**
   * Re-reads the shell environment for processes started from now on (running
   * ones keep theirs), then checks the agent again.
   */
  async reload(): Promise<void> {
    const connection = this.connected();
    if (!connection) throw new Error(`${this.options.label} is not connected`);
    await this.readShellEnvironment(connection, 'environment.reload');
    // A check started before the reload would report the old environment.
    await this.detecting;
    await this.detectAgent();
  }

  /**
   * The models the agent offers in the checkout at `path`, asked once per
   * checkout until the agent is checked again; a failed ask is asked again.
   */
  listModels(path: string): Promise<ModelChoice[]> {
    let listed = this.models.get(path);
    if (!listed) {
      listed = listOpenCodeModels((method, timeoutMs, params) => this.request(method, timeoutMs, params), path);
      this.models.set(path, listed);
      listed.catch(() => {
        if (this.models.get(path) === listed) this.models.delete(path);
      });
    }
    return listed;
  }

  /** Sends one request to the bridge; rejects unless the Environment is connected. */
  request<T>(method: string, timeoutMs: number, params?: unknown): Promise<T> {
    const connection = this.connected();
    if (!connection) return Promise.reject(new Error(`${this.options.label} is not connected`));
    return connection.request<T>(method, timeoutMs, params);
  }

  /** Starts a process on a channel; rejects unless the Environment is connected. */
  openChannel(params: ChannelParams): Promise<Channel> {
    const connection = this.connected();
    if (!connection) return Promise.reject(new Error(`${this.options.label} is not connected`));
    return connection.openChannel(params);
  }

  private connected(): BridgeConnection | undefined {
    return this.current.state === 'connected' ? this.connection : undefined;
  }

  /** Records where the bridge's shell environment came from, after `method` resolves it. */
  private async readShellEnvironment(connection: BridgeConnection, method: 'environment.get' | 'environment.reload'): Promise<void> {
    const { source } = await connection.request<{ source: ShellEnvironmentSource }>(method, SHELL_ENVIRONMENT_TIMEOUT_MS);
    if (this.connection === connection) this.update({ shellEnvironment: source });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelPing();
    if (this.restartTimer !== undefined) this.options.clock.clearTimeout(this.restartTimer);
    this.settleWaiters();
    await this.connection?.close();
  }

  private schedulePing(connection: BridgeConnection): void {
    if (this.stopped) return;
    this.pingTimer = this.options.clock.setTimeout(async () => {
      this.schedulePing(connection);
      try {
        await connection.request('ping', PING_TIMEOUT_MS);
        if (this.connection !== connection || this.stopped) return;
        this.update({ state: 'connected', lastSeenAt: this.options.clock.now() });
      } catch {
        if (this.connection !== connection || this.stopped || this.current.state !== 'connected') return;
        // A bridge that doesn't answer is killed, and so restarted.
        this.update({ state: 'unresponsive' });
        this.child?.kill('SIGKILL');
      }
    }, PING_INTERVAL_MS);
  }

  private cancelPing(): void {
    if (this.pingTimer === undefined) return;
    this.options.clock.clearTimeout(this.pingTimer);
    this.pingTimer = undefined;
  }

  private update(change: Partial<EnvironmentStatus>): void {
    this.current = { ...this.current, ...change };
    this.options.onChange(this.current);
    this.settleWaiters();
  }

  private settleWaiters(): void {
    const { state } = this.current;
    if (state !== 'connected' && state !== 'failed' && !this.stopped) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      if (state === 'connected' && !this.stopped) waiter.resolve();
      else waiter.reject(this.failure());
    }
  }
}
