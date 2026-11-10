// A long-lived process in an Environment whose stdin and stdout main drives
// through the bridge, multiplexed with every other channel's on the bridge's
// stdio: an agent's ACP stdio. See bridge/protocol/channel.go.
import type { TerminalSize } from '../../shared/api';

/** What starts a channel's process. */
export interface ChannelParams {
  /** Looked up on the Environment's PATH. */
  command: string;
  args?: string[];
  /** The folder the process runs in. */
  cwd?: string;
  /** Variables added to the Environment's own for this process. */
  env?: Record<string, string>;
  /**
   * Runs the process on a pseudo-terminal of this size, with the
   * Environment's full environment: a terminal in Loom. `command` then
   * defaults to the user's login shell.
   */
  pty?: TerminalSize;
}

export interface ChannelExit {
  /** The process's exit code; absent when the bridge itself went away. */
  exitCode?: number;
  /** The end of what the process wrote to stderr. */
  stderr: string;
  /** Why the channel ended without the process's exit being reported. */
  error?: string;
}

export interface ChannelListener {
  onData(chunk: Buffer): void;
  onExit(exit: ChannelExit): void;
}

/** What a channel needs from its bridge connection. */
export interface ChannelTransport {
  request<T>(method: string, timeoutMs: number, params?: unknown): Promise<T>;
}

const CHANNEL_REQUEST_TIMEOUT_MS = 30_000;
/** The most of a write one `channel.write` carries: base64 makes it a third bigger, under the bridge's 16 MiB frame. */
const MAX_WRITE_BYTES = 4 << 20;

/**
 * Bytes received but not yet acknowledged before main acknowledges them. It
 * is well under the bridge's 256 KiB window, so the bridge never stalls on a
 * process main is keeping up with.
 */
const ACK_THRESHOLD = 64 << 10;

export class Channel {
  private listener: ChannelListener | undefined;
  /** What arrived before anyone listened. */
  private early: Array<{ data: Buffer } | { exit: ChannelExit }> = [];
  private unacknowledged = 0;
  private exited = false;
  /** Writes go one at a time: the bridge handles requests concurrently. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    readonly id: number,
    /** Where the command was found. */
    readonly path: string,
    private readonly transport: ChannelTransport,
  ) {}

  /**
   * Whether the listener acknowledges what it has handled itself (see
   * `acknowledge`), rather than the channel on delivery.
   */
  private manualAck = false;

  /**
   * Starts delivering the process's output, including what came before.
   * With `manualAck`, nothing is acknowledged until the listener calls
   * `acknowledge`, so the process is held back by whoever reads its output
   * last, such as a terminal's renderer.
   */
  listen(listener: ChannelListener, options: { manualAck?: boolean } = {}): void {
    this.listener = listener;
    this.manualAck = options.manualAck ?? false;
    for (const item of this.early.splice(0)) {
      if ('data' in item) this.deliver(item.data);
      else listener.onExit(item.exit);
    }
  }

  /**
   * Writes to the process's stdin, after any write already in flight. A big
   * write, such as a prompt with images in it, goes in pieces, each well
   * within the bridge's frame limit once base64-encoded.
   */
  write(data: string | Buffer): Promise<void> {
    const bytes = Buffer.from(data);
    const write = this.writing.then(async () => {
      for (let at = 0; at < bytes.length || at === 0; at += MAX_WRITE_BYTES) {
        const encoded = bytes.subarray(at, at + MAX_WRITE_BYTES).toString('base64');
        await this.transport.request<void>('channel.write', CHANNEL_REQUEST_TIMEOUT_MS, { channel: this.id, data: encoded });
      }
    });
    this.writing = write.catch(() => {});
    return write;
  }

  /** Closes the process's stdin, once pending writes are done. */
  closeStdin(): Promise<void> {
    const close = this.writing.then(() => this.transport.request<void>('channel.close', CHANNEL_REQUEST_TIMEOUT_MS, { channel: this.id }));
    this.writing = close.catch(() => {});
    return close;
  }

  /** Acknowledges `bytes` of the output delivered, for a listener with `manualAck`. */
  acknowledge(bytes: number): void {
    if (bytes <= 0 || this.exited) return;
    // A failed ack means the channel or the bridge is gone, which its exit reports.
    this.transport.request('channel.ack', CHANNEL_REQUEST_TIMEOUT_MS, { channel: this.id, bytes }).catch(() => {});
  }

  /** Sets a terminal channel's size. */
  resize(size: TerminalSize): Promise<void> {
    return this.transport.request<void>('channel.resize', CHANNEL_REQUEST_TIMEOUT_MS, { channel: this.id, ...size });
  }

  /** Kills the process and everything it started. */
  kill(): Promise<void> {
    return this.transport.request<void>('channel.kill', CHANNEL_REQUEST_TIMEOUT_MS, { channel: this.id });
  }

  /** Called by the connection with each channel.data event. */
  receiveData(data: Buffer): void {
    if (this.listener) this.deliver(data);
    else this.early.push({ data });
  }

  /** Called by the connection with the channel.exit event, or when the bridge goes away. */
  receiveExit(exit: ChannelExit): void {
    if (this.exited) return;
    this.exited = true;
    if (this.listener) this.listener.onExit(exit);
    else this.early.push({ exit });
  }

  private deliver(data: Buffer): void {
    this.listener!.onData(data);
    if (this.manualAck) return;
    this.unacknowledged += data.length;
    if (this.unacknowledged < ACK_THRESHOLD) return;
    const bytes = this.unacknowledged;
    this.unacknowledged = 0;
    this.acknowledge(bytes);
  }
}
