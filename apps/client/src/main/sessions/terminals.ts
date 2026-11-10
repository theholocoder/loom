// The terminals in Loom's dock: each a shell on a bridge channel with a
// pseudo-terminal, in its Session's Environment and working copy. They run
// until their shell exits, they are closed, their Session is archived or
// Loom quits; nothing of them outlives Loom.
import type { Channel, ChannelParams } from '../environments/channel';
import { TERMINAL_REPLAY_BYTES, type Session, type TerminalInfo, type TerminalOutput } from '../../shared/api';

/** What a terminal needs from its Session's Environment. */
export interface TerminalEnvironment {
  label: string;
  /** The bridge's OS, once connected: terminals need a pseudo-terminal, which native Windows lacks. */
  os(): string | undefined;
  ready(): Promise<void>;
  openChannel(params: ChannelParams): Promise<Channel>;
}

export interface TerminalsOptions {
  session(id: number): Session | undefined;
  /** The Session's Environment, if Loom has it. */
  environment(session: Session): TerminalEnvironment | undefined;
}

interface Running {
  info: TerminalInfo;
  channel: Channel;
  /** The end of what it printed, at most TERMINAL_REPLAY_BYTES, for a new listener. */
  replay: Buffer[];
  replayBytes: number;
  listeners: Set<(output: TerminalOutput) => void>;
  /** Bytes given to listeners that none has acknowledged yet. */
  pending: number;
}

export class Terminals {
  private nextId = 1;
  private running = new Map<number, Running>();
  /** How many terminals each Session has opened, for their titles. */
  private opened = new Map<number, number>();
  private listListeners = new Map<number, Set<(list: TerminalInfo[]) => void>>();

  constructor(private readonly options: TerminalsOptions) {}

  async open({ sessionId, cols, rows }: { sessionId: number; cols: number; rows: number }): Promise<TerminalInfo> {
    const session = this.options.session(sessionId);
    if (!session) throw new Error(`unknown Session ${sessionId}`);
    if (session.status === 'archived') throw new Error('The Session is archived, so it has no terminal.');
    if (session.worktreeMissing) throw new Error("The Session's worktree is missing, so a terminal can't open in it.");
    if (!(cols >= 1 && rows >= 1)) throw new Error('A terminal needs at least one column and one row.');
    const environment = this.options.environment(session);
    if (!environment) throw new Error(`unknown Environment for Session ${sessionId}`);
    await environment.ready();
    if (environment.os() === 'windows') throw new Error(`Terminals need a Unix or WSL Environment; ${environment.label} is native Windows.`);
    const channel = await environment.openChannel({ command: '', cwd: session.workingCopy.path, pty: { cols: Math.floor(cols), rows: Math.floor(rows) } });

    const number = (this.opened.get(sessionId) ?? 0) + 1;
    this.opened.set(sessionId, number);
    const terminal: Running = {
      info: { id: this.nextId++, sessionId, title: `Terminal ${number}` },
      channel,
      replay: [],
      replayBytes: 0,
      listeners: new Set(),
      pending: 0,
    };
    this.running.set(terminal.info.id, terminal);
    channel.listen(
      {
        onData: (data) => this.received(terminal, data),
        onExit: () => {
          this.running.delete(terminal.info.id);
          this.listChanged(sessionId);
        },
      },
      { manualAck: true },
    );
    this.listChanged(sessionId);
    return terminal.info;
  }

  write(id: number, data: string): Promise<void> {
    return this.get(id).channel.write(data);
  }

  resize(id: number, cols: number, rows: number): Promise<void> {
    if (!(cols >= 1 && rows >= 1)) throw new Error('A terminal needs at least one column and one row.');
    return this.get(id).channel.resize({ cols: Math.floor(cols), rows: Math.floor(rows) });
  }

  /** A listener has shown `bytes` more of the output; what it replayed counts for nothing. */
  ack(id: number, bytes: number): void {
    const terminal = this.running.get(id);
    if (!terminal) return;
    const acknowledged = Math.min(Math.max(0, bytes), terminal.pending);
    terminal.pending -= acknowledged;
    terminal.channel.acknowledge(acknowledged);
  }

  async close(id: number): Promise<void> {
    const terminal = this.running.get(id);
    if (!terminal) return;
    // Gone from the list at once; its exit follows.
    this.running.delete(id);
    this.listChanged(terminal.info.sessionId);
    await terminal.channel.kill().catch(() => {});
  }

  /** Closes the terminals of every Session that is archived, or gone. */
  sessionsChanged(sessions: Session[]): void {
    const live = new Set(sessions.filter((s) => s.status !== 'archived').map((s) => s.id));
    for (const terminal of [...this.running.values()]) {
      if (!live.has(terminal.info.sessionId)) void this.close(terminal.info.id);
    }
  }

  /** Closes every terminal, as Loom quits. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.close(id)));
  }

  subscribeList(sessionId: number, listener: (list: TerminalInfo[]) => void): () => void {
    let listeners = this.listListeners.get(sessionId);
    if (!listeners) this.listListeners.set(sessionId, (listeners = new Set()));
    listeners.add(listener);
    listener(this.list(sessionId));
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listListeners.delete(sessionId);
    };
  }

  /** Gives `listener` the end of what the terminal printed so far, then each new piece. */
  subscribeOutput(id: number, listener: (output: TerminalOutput) => void): () => void {
    const terminal = this.running.get(id);
    if (!terminal) {
      listener({ data: new Uint8Array() });
      return () => {};
    }
    terminal.listeners.add(listener);
    listener({ data: Buffer.concat(terminal.replay) });
    return () => {
      terminal.listeners.delete(listener);
      // With nobody left to show it, the shell must not be held back.
      if (!terminal.listeners.size) this.ack(id, terminal.pending);
    };
  }

  private received(terminal: Running, data: Buffer): void {
    terminal.replay.push(data);
    terminal.replayBytes += data.length;
    while (terminal.replayBytes - terminal.replay[0]!.length >= TERMINAL_REPLAY_BYTES) {
      terminal.replayBytes -= terminal.replay.shift()!.length;
    }
    if (!terminal.listeners.size) {
      terminal.channel.acknowledge(data.length);
      return;
    }
    terminal.pending += data.length;
    for (const listener of [...terminal.listeners]) listener({ data });
  }

  private get(id: number): Running {
    const terminal = this.running.get(id);
    if (!terminal) throw new Error(`no open terminal ${id}`);
    return terminal;
  }

  private list(sessionId: number): TerminalInfo[] {
    return [...this.running.values()].filter((t) => t.info.sessionId === sessionId).map((t) => t.info);
  }

  private listChanged(sessionId: number): void {
    const listeners = this.listListeners.get(sessionId);
    if (!listeners) return;
    const list = this.list(sessionId);
    for (const listener of [...listeners]) listener(list);
  }
}
