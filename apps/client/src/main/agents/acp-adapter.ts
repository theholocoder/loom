// An AgentAdapter for any agent that speaks ACP v1 over stdio, one process per
// Session (ADR 0005). A profile says how to start a given agent; ACP itself
// stays inside this module, translated into Loom's AgentEvents.
import type { Answer, QuestionField, QuestionOption, ToolStatus } from '../../shared/api';
import type { AgentAdapter, AgentEvent, AgentResponse, AgentSession, OpenOptions } from './adapter';
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
    /** Elicitations waiting on the user, by the requestId Loom gave them. */
    const asked = new Map<string, (response: ElicitationResponse) => void>();
    let asks = 0;
    const connection = new AcpConnection(channel, {
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        const { sessionId: forSession, update } = params as { sessionId: string; update: SessionUpdate };
        if (forSession !== sessionId) return;
        const event = translate(update);
        if (event) onEvent(event);
      },
      onRequest: (method, params) => {
        if (method !== 'elicitation/create') return undefined;
        const request = params as ElicitationRequest;
        if (request.sessionId !== sessionId) return Promise.resolve({ action: 'cancel' });
        const fields = request.mode === 'form' ? fieldsOf(request.requestedSchema) : undefined;
        // A form Loom can't show is cancelled, as OpenCode does when it can't show one.
        if (!fields) return Promise.resolve({ action: 'cancel' });
        const requestId = `elicitation-${++asks}`;
        return new Promise<ElicitationResponse>((resolve) => {
          asked.set(requestId, resolve);
          onEvent({ type: 'question-asked', requestId, message: typeof request.message === 'string' ? request.message : '', fields });
        });
      },
      onClose: (reason) => {
        asked.clear();
        onEvent({ type: 'closed', error: reason });
      },
    });
    try {
      await connection.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        // Without `elicitation.form`, OpenCode skips its questions and tells the model the user couldn't be asked.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
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
      answer: (requestId, response) => {
        const resolve = asked.get(requestId);
        if (!resolve || response.kind !== 'question') return;
        asked.delete(requestId);
        resolve(elicitationResponse(response));
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

// ACP v1's form elicitation: a flat JSON Schema object of primitive fields.
interface ElicitationRequest {
  sessionId?: unknown;
  mode?: unknown;
  message?: unknown;
  requestedSchema?: { properties?: Record<string, PropertySchema>; required?: unknown };
}

interface PropertySchema {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
  format?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  enum?: unknown;
  enumNames?: unknown;
  oneOf?: unknown;
  anyOf?: unknown;
  items?: { enum?: unknown; anyOf?: unknown };
}

type ElicitationResponse = { action: 'accept'; content: Answer } | { action: 'decline' } | { action: 'cancel' };

function elicitationResponse(response: Extract<AgentResponse, { kind: 'question' }>): ElicitationResponse {
  return response.answer ? { action: 'accept', content: response.answer } : { action: 'decline' };
}

const FORMATS = new Set(['email', 'uri', 'date', 'date-time']);

/** The fields of a form's schema, in order; undefined if one of them isn't a kind Loom can show. */
function fieldsOf(schema: ElicitationRequest['requestedSchema']): QuestionField[] | undefined {
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const fields: QuestionField[] = [];
  for (const [key, property] of Object.entries(schema?.properties ?? {})) {
    const field = fieldOf(key, property ?? {}, required.has(key));
    if (!field) return undefined;
    fields.push(field);
  }
  return fields;
}

function fieldOf(key: string, p: PropertySchema, required: boolean): QuestionField | undefined {
  const base = defined({ key, title: text(p.title), description: text(p.description), required });
  switch (p.type) {
    case 'string': {
      const options = optionsOf(p.oneOf, p.enum, p.enumNames);
      if (options) return defined({ ...base, type: 'select' as const, options, default: text(p.default) });
      const format = typeof p.format === 'string' && FORMATS.has(p.format) ? (p.format as 'email') : undefined;
      return defined({ ...base, type: 'text' as const, default: text(p.default), minLength: count(p.minLength), maxLength: count(p.maxLength), pattern: text(p.pattern), format });
    }
    case 'array': {
      const options = optionsOf(p.items?.anyOf, p.items?.enum);
      if (!options) return undefined;
      const values = Array.isArray(p.default) ? p.default.filter((v): v is string => typeof v === 'string') : undefined;
      return defined({ ...base, type: 'multiselect' as const, options, default: values, minItems: count(p.minItems), maxItems: count(p.maxItems) });
    }
    case 'number':
    case 'integer':
      return defined({ ...base, type: 'number' as const, integer: p.type === 'integer', default: num(p.default), minimum: num(p.minimum), maximum: num(p.maximum) });
    case 'boolean':
      return defined({ ...base, type: 'boolean' as const, default: typeof p.default === 'boolean' ? p.default : undefined });
  }
  return undefined;
}

/** Titled options (`oneOf`/`anyOf` of `{const, title}`), or else plain `enum` values with their optional `enumNames`. */
function optionsOf(titled: unknown, values?: unknown, names?: unknown): QuestionOption[] | undefined {
  if (Array.isArray(titled)) {
    const options = titled
      .filter((o): o is { const: string; title?: unknown; description?: unknown } => typeof (o as { const?: unknown })?.const === 'string')
      .map((o) => defined({ value: o.const, label: text(o.title) ?? o.const, description: text(o.description) }));
    return options.length ? options : undefined;
  }
  if (Array.isArray(values)) {
    const labels = Array.isArray(names) ? names : [];
    const options = values.filter((v): v is string => typeof v === 'string').map((value, i) => ({ value, label: text(labels[i]) ?? value }));
    return options.length ? options : undefined;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/** Drops absent fields, so what Loom stores and compares has none. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
