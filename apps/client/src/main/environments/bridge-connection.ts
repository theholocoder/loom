import type { ChildProcess } from 'node:child_process';
import type { Clock, TimerHandle } from '../clock';
import { encodeFrame, FrameDecoder } from './frames';

interface Response {
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: TimerHandle;
}

export class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Request/response over one bridge process's stdio. */
export class BridgeConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closedReason: Error | undefined;
  private closeListeners: Array<(reason: Error) => void> = [];

  constructor(
    private readonly child: ChildProcess,
    private readonly clock: Clock,
  ) {
    const decoder = new FrameDecoder();
    child.stdout!.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        this.fail(error as Error);
        child.kill();
        return;
      }
      for (const message of messages) this.receive(message as Response);
    });
    child.stdin!.on('error', () => {});
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => this.fail(new Error(`bridge exited (${signal ?? `code ${code}`})`)));
  }

  request<T>(method: string, timeoutMs: number, params?: unknown): Promise<T> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge did not answer "${method}" within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      this.child.stdin!.write(encodeFrame(params === undefined ? { id, method } : { id, method, params }));
    });
  }

  onClose(listener: (reason: Error) => void): void {
    this.closeListeners.push(listener);
  }

  /**
   * Closes the bridge's stdin, which tells it to shut down, and waits for it
   * to exit, killing it if it hasn't within `graceMs`. This runs on real time
   * rather than the Clock: shutting down must not wait on a test's clock.
   */
  async close(graceMs = 5_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.stdin!.end();
    const kill = setTimeout(() => this.child.kill('SIGKILL'), graceMs);
    await exited;
    clearTimeout(kill);
  }

  private receive(response: Response): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    this.clock.clearTimeout(pending.timer);
    if (response.error) pending.reject(new BridgeRequestError(response.error.code, response.error.message));
    else pending.resolve(response.result);
  }

  private fail(reason: Error): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const { reject, timer } of this.pending.values()) {
      this.clock.clearTimeout(timer);
      reject(reason);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(reason);
  }
}
