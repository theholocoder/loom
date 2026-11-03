// An AgentAdapter for any agent that speaks ACP v1 over stdio, one process per
// Session (ADR 0005). A profile says how to start a given agent; ACP itself
// stays inside this module, translated into Loom's AgentEvents.
import type { ToolStatus } from '../../shared/api';
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
    // The user's own setup (OpenCode config, MCP servers, plugins, skills,
    // AGENTS.md) loads as it would in their terminal: the agent starts in the
    // working copy with the Environment's own env and only the profile's args.
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
      // Loom adds no tools of its own (ADR 0006): the agent's are the user's.
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
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const text = (update as ContentChunk).content?.type === 'text' ? (update as ContentChunk).content?.text : undefined;
      if (!text) return undefined;
      return { type: update.sessionUpdate === 'agent_message_chunk' ? 'text-delta' : 'thinking-delta', text };
    }
    case 'tool_call':
    case 'tool_call_update': {
      const call = update as AcpToolCall;
      if (typeof call.toolCallId !== 'string') return undefined;
      const fields = {
        toolCallId: call.toolCallId,
        toolKind: typeof call.kind === 'string' ? call.kind : undefined,
        status: STATUSES[call.status as string],
        input: call.rawInput === undefined ? undefined : stringOf(call.rawInput),
        output: outputOf(call),
      };
      const title = typeof call.title === 'string' && call.title.trim() ? call.title : undefined;
      // ACP leaves out what didn't change; so does the event.
      const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as typeof fields;
      if (update.sessionUpdate === 'tool_call') return { type: 'tool-started', title: title ?? 'Tool call', ...defined };
      return { type: 'tool-updated', ...(title ? { title } : {}), ...defined };
    }
  }
  return undefined;
}

// ACP v1's shapes for the updates Loom shows. Anything else in them is ignored.
interface ContentChunk {
  content?: { type: string; text?: string };
}

interface AcpToolCall {
  toolCallId?: unknown;
  title?: unknown;
  kind?: unknown;
  status?: unknown;
  content?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
}

const STATUSES: Record<string, ToolStatus> = { pending: 'running', in_progress: 'running', completed: 'completed', failed: 'failed' };

/** The tool's output as text: its content blocks, or else its raw output. */
function outputOf({ content, rawOutput }: AcpToolCall): string | undefined {
  if (Array.isArray(content) && content.length > 0) return content.map(contentText).join('\n');
  if (rawOutput === undefined || rawOutput === null) return undefined;
  // OpenCode puts the text a tool returned in `output`, beside its metadata.
  const output = (rawOutput as { output?: unknown }).output;
  return typeof output === 'string' ? output : stringOf(rawOutput);
}

/** One tool call content block as text; what isn't text is summarised. */
function contentText(block: unknown): string {
  const { type, content, path } = (block ?? {}) as { type?: unknown; content?: { type?: unknown; text?: unknown }; path?: unknown };
  if (type === 'content') return content?.type === 'text' && typeof content.text === 'string' ? content.text : `[${String(content?.type ?? 'content')}]`;
  if (type === 'diff') return `[diff of ${String(path ?? 'a file')}]`;
  return `[${String(type ?? 'content')}]`;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
}
