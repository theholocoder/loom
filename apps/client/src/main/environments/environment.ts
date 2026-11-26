import type { ChildProcess } from 'node:child_process';
import { OPENCODE_NAME, type AgentCommand, type BridgeInfo, type EnvironmentStatus, type ModelChoice, type ShellEnvironmentSource } from '../../shared/api';
import { detectOpenCode, probeOpenCodeCheckout, type CheckoutOffer } from '../agents/opencode';
import type { Clock, TimerHandle } from '../clock';
import { BridgeConnection } from './bridge-connection';
import type { Channel, ChannelParams } from './channel';

/** Starts a bridge process: `command` with `args`, its environment the Client's plus `env`. */
export type SpawnBridge = (command: string, args: string[], env?: Record<string, string>) => ChildProcess;

/** How an Environment's bridge is started. */
export interface BridgeLaunch {
  command: string;
  args: string[];
  /** Added to the Client's environment. */
  env?: Record<string, string>;
}

export const HANDSHAKE_TIMEOUT_MS = 20_000;
export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MS = 10_000;
/** How long to wait before each restart of a bridge that died; after the last, the Environment is failed. */
export const RESTART_BACKOFF_MS = [1_000, 5_000, 30_000];
/** Resolving the shell environment runs the shell twice at most, 5 s each. */
export const SHELL_ENVIRONMENT_TIMEOUT_MS = 15_000;
/** The bridge protocol version this Client speaks. */
export const PROTOCOL_VERSION = 4;

export interface EnvironmentOptions {
  id: string;
  label: string;
  /** The WSL distro the Environment is, if it is one. */
  distro?: string;
  /** How its bridge is started, worked out as it starts. */
  launch: () => BridgeLaunch | Promise<BridgeLaunch>;
  /**
   * Installs the bridge where it is started from, when it didn't start or is
   * another Client's: a WSL distro's, which Loom copies there.
   */
  install?: () => Promise<void>;
  /** Waits to be used before starting, rather than at `start` (a WSL distro's, which would boot). */
  stopped?: boolean;
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
  /** What the agent offers, by checkout, until the agent is checked again. */
  private offers = new Map<string, Promise<CheckoutOffer>>();
  /** Asks of the agent running, by checkout. */
  private asking = new Map<string, Promise<CheckoutOffer>>();

  constructor(private readonly options: EnvironmentOptions) {
    this.current = { id: options.id, label: options.label, ...(options.distro && { distro: options.distro }), state: options.stopped ? 'stopped' : 'starting' };
  }

  get status(): EnvironmentStatus {
    return this.current;
  }

  /**
   * Starts the bridge, unless it waits to be used; a bridge that fails to
   * start leaves the Environment failed.
   */
  start(): Promise<void> {
    if (this.current.state === 'stopped') return Promise.resolve();
    return this.connect();
  }

  /**
   * Starts a failed Environment's bridge again, as Retry does, or one not
   * started yet; nothing happens otherwise.
   */
  async restart(): Promise<void> {
    if ((this.current.state !== 'failed' && this.current.state !== 'stopped') || this.stopped) return;
    this.restarts = 0;
    await this.connect();
  }

  /**
   * Resolves once the Environment is connected, starting it if it waited to
   * be used, and waiting while its bridge starts or restarts; rejects if it
   * fails to start.
   */
  ready(): Promise<void> {
    if (this.current.state === 'connected') return Promise.resolve();
    if (this.current.state === 'stopped' && !this.stopped) void this.connect();
    if (this.current.state === 'failed' || this.stopped) return Promise.reject(this.failure());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async connect(): Promise<void> {
    if (this.current.state !== 'starting') this.update({ state: 'starting' });
    let connection = await this.handshake();
    if (typeof connection === 'string' && this.options.install && !this.stopped) {
      // A bridge missing where it is started from, or another Client's, is installed again.
      this.update({ installing: true });
      try {
        await this.options.install();
      } catch (error) {
        this.update({ installing: undefined });
        this.startFailed((error as Error).message);
        return;
      }
      this.update({ installing: undefined });
      connection = await this.handshake();
    }
    if (typeof connection === 'string') {
      this.startFailed(connection);
      return;
    }
    if (this.stopped) return;
    try {
      await this.readShellEnvironment(connection, 'environment.get');
    } catch {
      // Either the bridge went away, which its close listener has reported,
      // or it was slow; detecting below covers both.
    }
    await this.detectAgent();
  }

  /**
   * Starts the bridge and shakes hands with it: its connection, once that is
   * done and the Environment is connected, or why it didn't start.
   */
  private async handshake(): Promise<BridgeConnection | string> {
    const { clock } = this.options;
    let child: ChildProcess;
    try {
      // Started at once when its launch line is known, as a restart's timer fires.
      const launch = this.options.launch();
      const { command, args, env } = launch instanceof Promise ? await launch : launch;
      child = this.options.spawnBridge(command, args, env);
    } catch (error) {
      return (error as Error).message;
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
      if (this.stopped) return connection;
      this.restarts = 0;
      this.update({ state: 'connected', bridge, error: undefined, lastSeenAt: clock.now() });
      this.schedulePing(connection);
      return connection;
    } catch (error) {
      child.kill();
      return (error as Error).message;
    }
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
    // Checked again, the agent may offer other models (the user signed in to a provider, or out), commands and skills.
    this.offers.clear();
    this.asking.clear();
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

  /** The models the agent offers in the checkout at `path` (see `offer`). */
  async listModels(path: string): Promise<ModelChoice[]> {
    return (await this.offer(path)).models;
  }

  /**
   * The commands and skills the agent offers in the checkout at `path` (see
   * `offer`); asked of it again when `fresh`, as skills may have been added.
   */
  async listCommands(path: string, fresh = false): Promise<AgentCommand[]> {
    return (await this.offer(path, fresh)).commands;
  }

  /**
   * What the agent offers in the checkout at `path`, asked once per checkout
   * until the agent is checked again, or until asked `fresh`; a failed ask is
   * asked again, and so is one that listed no models, as the agent may not
   * have loaded them yet. An ask already running is joined rather than
   * repeated; a fresh one that fails answers what was kept.
   */
  private offer(path: string, fresh = false): Promise<CheckoutOffer> {
    const kept = this.offers.get(path);
    if (kept && !fresh) return kept;
    let asked = this.asking.get(path);
    if (!asked) {
      const probe = probeOpenCodeCheckout((method, timeoutMs, params) => this.request(method, timeoutMs, params), path);
      this.asking.set(path, probe);
      asked = probe;
      const settled = (keep: boolean) => {
        // Asked before the agent was checked again, it isn't kept.
        if (this.asking.get(path) !== probe) return;
        this.asking.delete(path);
        if (keep) this.offers.set(path, probe);
      };
      probe.then(({ models }) => settled(models.length > 0), () => settled(false));
    }
    return kept ? asked.catch(() => kept) : asked;
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
