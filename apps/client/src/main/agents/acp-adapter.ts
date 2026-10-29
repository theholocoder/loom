// An AgentAdapter for any agent that speaks ACP v1 over stdio, one process per
// Session (ADR 0005). A profile says how to start a given agent; ACP itself
// stays inside this module, translated into Loom's AgentEvents.
import type { AgentAdapter, AgentEvent, AgentSession, OpenOptions } from './adapter';
import { isNotFound } from '../environments/exec';
import { AcpConnection } from './acp';

/** How to start one ACP agent. */
export interface AcpProfile {
  name: string;
  command: string;
  args: string[];
}

const PROTOCOL_VERSION = 1;

interface SessionUpdate {
  sessionUpdate: string;
  content?: { type: string; text?: string };
}

export class AcpAdapter implements AgentAdapter {
  constructor(
    private readonly profile: AcpProfile,
    /** The Client's version, reported in `initialize`. */
    private readonly clientVersion: string,
  ) {}

  get name(): string {
    return this.profile.name;
  }

  async open({ environment, workingCopy, onEvent }: OpenOptions): Promise<AgentSession> {
    const channel = await environment.openChannel({ command: this.profile.command, args: this.profile.args, cwd: workingCopy }).catch((error: unknown) => {
      if (isNotFound(error)) throw new Error(`${this.profile.name} isn't installed in ${environment.label}, or isn't on your shell's PATH.`);
      throw error;
    });
    let sessionId: string | undefined;
    const connection = new AcpConnection(channel, {
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        const { sessionId: forSession, update } = params as { sessionId: string; update: SessionUpdate };
        if (forSession !== sessionId) return;
        const event = translate(update);
        if (event) onEvent(event);
      },
      onClose: (reason) => onEvent({ type: 'closed', error: reason }),
    });
    try {
      await connection.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'loom', version: this.clientVersion },
      });
      ({ sessionId } = await connection.request<{ sessionId: string }>('session/new', { cwd: workingCopy, mcpServers: [] }));
    } catch (error) {
      await channel.kill().catch(() => {});
      throw new Error(`${this.profile.name} could not start a session: ${(error as Error).message}`);
    }
    const id = sessionId;
    return {
      id,
      prompt: (text) => {
        onEvent({ type: 'run-started' });
        connection.request<{ stopReason: string }>('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }] }).then(
          () => onEvent({ type: 'run-settled' }),
          (error: Error) => onEvent({ type: 'run-failed', error: error.message }),
        );
      },
      close: () => connection.end(),
    };
  }
}

function translate(update: SessionUpdate): AgentEvent | undefined {
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text) {
    return { type: 'text-delta', text: update.content.text };
  }
  return undefined;
}
