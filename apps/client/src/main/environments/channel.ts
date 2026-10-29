// A long-lived process in an Environment whose stdin and stdout main drives
// through the bridge, multiplexed with every other channel's on the bridge's
// stdio: an agent's ACP stdio. See bridge/protocol/channel.go.

/** What starts a channel's process. */
export interface ChannelParams {
  /** Looked up on the Environment's PATH. */
  command: string;
  args?: string[];
  /** The folder the process runs in. */
  cwd?: string;
  /** Variables added to the Environment's own for this process. */
  env?: Record<string, string>;
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

  /** Starts delivering the process's output, including what came before. */
  listen(listener: ChannelListener): void {
    this.listener = listener;
    for (const item of this.early.splice(0)) {
      if ('data' in item) this.deliver(item.data);
      else listener.onExit(item.exit);
    }
  }

  /** Writes to the process's stdin, after any write already in flight. */
  write(data: string | Buffer): Promise<void> {
    const encoded = Buffer.from(data).toString('base64');
    const write = this.writing.then(() => this.transport.request<void>('channel.write', CHANNEL_REQUEST_TIMEOUT_MS, { channel: this.id, data: encoded }));
    this.writing = write.catch(() => {});
    return write;
  }

  /** Closes the process's stdin, once pending writes are done. */
  closeStdin(): Promise<void> {
    const close = this.writing.then(() => this.transport.request<void>('channel.close', CHANNEL_REQUEST_TIMEOUT_MS, { channel: this.id }));
    this.writing = close.catch(() => {});
    return close;
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
    this.unacknowledged += data.length;
    if (this.unacknowledged < ACK_THRESHOLD || this.exited) return;
    const bytes = this.unacknowledged;
    this.unacknowledged = 0;
    // A failed ack means the channel or the bridge is gone, which its exit reports.
    this.transport.request('channel.ack', CHANNEL_REQUEST_TIMEOUT_MS, { channel: this.id, bytes }).catch(() => {});
  }
}
