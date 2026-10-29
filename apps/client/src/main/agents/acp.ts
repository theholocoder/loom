// The Agent Client Protocol's transport: JSON-RPC 2.0, one message per line,
// over an agent process's stdio carried by a bridge channel.
import { StringDecoder } from 'node:string_decoder';
import type { Channel, ChannelExit } from '../environments/channel';

/** A JSON-RPC error the agent answered a request with. */
export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Message {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpHandlers {
  onNotification(method: string, params: unknown): void;
  /** Ends with the process; `reason` says how. */
  onClose(reason: string): void;
}

const METHOD_NOT_FOUND = -32601;

/** The client side of an ACP connection: Loom's. */
export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private closedReason: string | undefined;

  constructor(
    private readonly channel: Channel,
    private readonly handlers: AcpHandlers,
  ) {
    const decoder = new StringDecoder('utf8');
    let partial = '';
    channel.listen({
      onData: (chunk) => {
        const lines = (partial + decoder.write(chunk)).split('\n');
        partial = lines.pop()!;
        for (const line of lines) if (line.trim()) this.receive(line);
      },
      onExit: (exit) => this.close(describeExit(exit)),
    });
  }

  /** Sends a request and resolves with its result; rejects with an AcpError, or when the process ends. */
  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closedReason) return Promise.reject(new Error(this.closedReason));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((error: Error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', method, params });
  }

  /** Closes the agent's stdin, which tells it to exit. */
  end(): Promise<void> {
    return this.channel.closeStdin();
  }

  private send(message: Message): Promise<void> {
    return this.channel.write(JSON.stringify(message) + '\n');
  }

  private receive(line: string): void {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      // Agents may log to stdout; a line that isn't JSON-RPC is not for Loom.
      return;
    }
    if (message.method !== undefined) {
      if (message.id === undefined) this.handlers.onNotification(message.method, message.params);
      // Loom answers no agent requests yet (permissions, questions, files).
      else void this.send({ jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: `Loom does not handle ${message.method}` } }).catch(() => {});
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new AcpError(message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result);
  }

  private close(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
    this.handlers.onClose(reason);
  }
}

function describeExit(exit: ChannelExit): string {
  if (exit.error) return `the agent's Environment went away: ${exit.error}`;
  const how = exit.exitCode === -1 ? 'was killed' : `exited with code ${exit.exitCode}`;
  return exit.stderr ? `the agent ${how}: ${exit.stderr}` : `the agent ${how}`;
}
