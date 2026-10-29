import type { ChildProcess } from 'node:child_process';
import type { BridgeInfo, EnvironmentStatus, ShellEnvironmentSource } from '../../shared/api';
import { detectOpenCode, OPENCODE_NAME } from '../agents/opencode';
import type { Clock, TimerHandle } from '../clock';
import { BridgeConnection } from './bridge-connection';

export type SpawnBridge = (command: string, args: string[]) => ChildProcess;

export const HANDSHAKE_TIMEOUT_MS = 20_000;
export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MS = 10_000;
/** Resolving the shell environment runs the shell twice at most, 5 s each. */
export const SHELL_ENVIRONMENT_TIMEOUT_MS = 15_000;
/** The bridge protocol version this Client speaks. */
export const PROTOCOL_VERSION = 1;

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

  constructor(private readonly options: EnvironmentOptions) {
    this.current = { id: options.id, label: options.label, state: 'starting' };
  }

  get status(): EnvironmentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    const { clock } = this.options;
    let child: ChildProcess;
    try {
      child = this.options.spawnBridge(this.options.bridgePath, []);
    } catch (error) {
      this.update({ state: 'failed', error: (error as Error).message });
      return;
    }
    const connection = new BridgeConnection(child, clock);
    this.connection = connection;
    connection.onClose((reason) => {
      this.cancelPing();
      if (this.current.state === 'starting' || this.current.state === 'failed') {
        this.update({ state: 'failed', error: reason.message });
      } else {
        this.update({ state: 'disconnected', error: reason.message });
      }
    });
    try {
      const bridge = await connection.request<BridgeInfo>('handshake', HANDSHAKE_TIMEOUT_MS);
      if (bridge.protocolVersion !== PROTOCOL_VERSION || bridge.version !== this.options.appVersion) {
        throw new Error(
          `loom-bridge ${bridge.version} (protocol ${bridge.protocolVersion}) does not match Loom ${this.options.appVersion} (protocol ${PROTOCOL_VERSION})`,
        );
      }
      this.update({ state: 'connected', bridge, error: undefined, lastSeenAt: clock.now() });
      this.schedulePing(connection);
    } catch (error) {
      this.update({ state: 'failed', error: (error as Error).message });
      child.kill();
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
   * Checks the Environment's agent, unless the bridge isn't connected. A
   * check already running is joined rather than repeated.
   */
  detectAgent(): Promise<void> {
    const connection = this.connected();
    if (!connection) return Promise.resolve();
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

  /** Sends one request to the bridge; rejects unless the Environment is connected. */
  request<T>(method: string, timeoutMs: number, params?: unknown): Promise<T> {
    const connection = this.connected();
    if (!connection) return Promise.reject(new Error(`${this.options.label} is not connected`));
    return connection.request<T>(method, timeoutMs, params);
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
        if (this.connection !== connection || this.stopped || this.current.state === 'disconnected') return;
        this.update({ state: 'unresponsive' });
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
  }
}
