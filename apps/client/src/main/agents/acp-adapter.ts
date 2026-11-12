// An AgentAdapter for any agent that speaks ACP v1 over stdio, one process per
// Session (ADR 0005). A profile says how to start a given agent; ACP itself
// stays inside this module, translated into Loom's AgentEvents.
import { isImage, type AgentConfig, type Answer, type ModelChoice, type ModelPick, type PlanEntry, type PlanStatus, type QuestionField, type QuestionOption, type TokenCounts, type ToolStatus } from '../../shared/api';
import { ResumeRefused, type AgentAdapter, type AgentEvent, type AgentPrompt, type AgentResponse, type AgentSession, type ApprovalAction, type OpenOptions, type ToolCall } from './adapter';
import { isNotFound } from '../environments/exec';
import { AcpConnection, AcpError } from './acp';
import { agentCommandsOf } from './commands';

/** How to start one ACP agent. */
export interface AcpProfile {
  name: string;
  command: string;
  args: string[];
  /** Variables the agent's process gets for this Session: its approval rules. */
  env?: (options: Pick<OpenOptions, 'approvals' | 'workingCopy' | 'tempDir' | 'toolsOff'>) => Record<string, string>;
  /** The agent's own tools; any other is from the user's MCP servers or plugins. */
  ownTools: ReadonlySet<string>;
  /**
   * The agent's tool that writes its plan, as `todos` in its input, if it
   * has one rather than ACP's plan updates: its calls are the plan, not tool calls.
   */
  planTool?: string;
}

const PROTOCOL_VERSION = 1;

/**
 * How long an agent gets to exit once its stdin is closed before it is
 * killed. Real time rather than the Clock, like the bridge's own shutdown.
 */
const EXIT_GRACE_MS = 5_000;

/** The name Loom's MCP server goes by: agents prefix its tools with it (OpenCode: `loom_link_merge_request`). */
export const LOOM_MCP_SERVER = 'loom';

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

  async open({ environment, workingCopy, tempDir, approvals, toolsOff, loomTools, resume, onEvent }: OpenOptions): Promise<AgentSession> {
    // The user's own setup (OpenCode config, MCP servers, plugins, skills,
    // AGENTS.md) loads as it would in their terminal: the agent starts in the
    // working copy with the Environment's own env and only the profile's args,
    // plus the profile's variables for the Session's approval rules.
    const env = this.profile.env?.({ approvals, workingCopy, tempDir, ...(toolsOff ? { toolsOff } : {}) });
    const channel = await environment.openChannel({ command: this.profile.command, args: this.profile.args, cwd: workingCopy, ...(env ? { env } : {}) }).catch((error: unknown) => {
      if (isNotFound(error)) throw new Error(`${this.profile.name} isn't installed in ${environment.label}, or isn't on your shell's PATH.`);
      throw error;
    });
    let sessionId: string | undefined;
    /** Commands announced before the session's id was known, for whichever session they were. */
    let earlyCommands: { forSession: string; update: SessionUpdate } | undefined;
    /** While `session/load` replays the conversation's history, which Loom has already. */
    let replaying = false;
    /** Once opening has failed: the process is killed, and its end is no news for the Session. */
    let abandoned = false;
    /** The agent's config options as it last reported them, and what Loom reads of them. */
    let options: ConfigOption[] = [];
    let config: AgentConfig = configOf(options);
    const configured = (reported: unknown) => {
      if (!Array.isArray(reported)) return;
      options = reported as ConfigOption[];
      config = configOf(options);
      onEvent({ type: 'config', config });
    };
    /**
     * Elicitations and permission requests waiting on the user, by the
     * requestId Loom gave them: answered by the user, or cancelled with the run.
     */
    const asked = new Map<string, { answer: (response: AgentResponse) => void; cancel: () => void }>();
    let asks = 0;
    const ask = <T,>(prefix: string, event: (requestId: string) => AgentEvent, respond: (response: AgentResponse) => T | undefined, cancelled: T) => {
      const requestId = `${prefix}-${++asks}`;
      return new Promise<T>((resolve) => {
        const settle = (result: T) => {
          asked.delete(requestId);
          resolve(result);
        };
        asked.set(requestId, {
          answer: (response) => {
            const result = respond(response);
            if (result !== undefined) settle(result);
          },
          cancel: () => settle(cancelled),
        });
        onEvent(event(requestId));
      });
    };
    /** What translating this session's updates needs. */
    const context: UpdateContext = { calls: new Map(), workingCopy, planTool: this.profile.planTool };
    /** Reports what Loom shows of a session update, if anything. */
    const report = (update: SessionUpdate) => {
      const event = translate(update, context);
      if (event) onEvent(event);
    };
    const connection = new AcpConnection(channel, {
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        const { sessionId: forSession, update } = params as { sessionId: string; update: SessionUpdate };
        // The agent may announce its commands before its answer to `session/new` is read, and does while it replays history.
        if (update?.sessionUpdate === 'available_commands_update') {
          if (sessionId === undefined) return void (earlyCommands = { forSession, update });
          if (forSession === sessionId) report(update);
          return;
        }
        if (forSession !== sessionId || replaying) return;
        if (update.sessionUpdate === 'config_option_update') return configured((update as { configOptions?: unknown }).configOptions);
        report(update);
      },
      onRequest: (method, params) => {
        if (method === 'session/request_permission') {
          const request = params as PermissionRequest;
          if (request.sessionId !== sessionId) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
          const action = approvalActionOf(request.toolCall ?? {}, this.profile.ownTools);
          return ask<PermissionResponse>(
            'permission',
            (requestId) => ({ type: 'approval-asked', requestId, action }),
            (response) => (response.kind === 'approval' ? permissionResponse(request.options, response.approved) : undefined),
            { outcome: { outcome: 'cancelled' } },
          );
        }
        if (method !== 'elicitation/create') return undefined;
        const request = params as ElicitationRequest;
        if (request.sessionId !== sessionId) return Promise.resolve({ action: 'cancel' });
        const fields = request.mode === 'form' ? fieldsOf(request.requestedSchema) : undefined;
        // A form Loom can't show is cancelled, as OpenCode does when it can't show one.
        if (!fields) return Promise.resolve({ action: 'cancel' });
        return ask<ElicitationResponse>(
          'elicitation',
          (requestId) => ({ type: 'question-asked', requestId, message: typeof request.message === 'string' ? request.message : '', fields }),
          (response) => (response.kind === 'question' ? elicitationResponse(response) : undefined),
          { action: 'cancel' },
        );
      },
      onClose: (reason) => {
        asked.clear();
        if (abandoned) return;
        onEvent({ type: 'closed', error: reason });
      },
    });
    /** Whether the agent takes images inline in a prompt, as `initialize` said. */
    let images = false;
    try {
      const initialized = await connection.request<{ agentCapabilities?: AgentCapabilities }>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        // Without `elicitation.form`, OpenCode skips its questions and tells the model the user couldn't be asked.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: 'loom', version: this.clientVersion },
      });
      images = initialized?.agentCapabilities?.promptCapabilities?.image === true;
      // Beside the user's own tools, Loom's MCP server, whose one tool the agent calls to link a Merge request.
      const mcpServers = loomTools ? [{ name: LOOM_MCP_SERVER, command: loomTools.command, args: loomTools.args, env: [] }] : [];
      let reported: unknown;
      if (resume === undefined) {
        ({ sessionId, configOptions: reported } = await connection.request<{ sessionId: string; configOptions?: unknown }>('session/new', { cwd: workingCopy, mcpServers }));
      } else {
        sessionId = resume;
        const params = { sessionId, cwd: workingCopy, mcpServers };
        const capabilities = initialized?.agentCapabilities;
        // `session/resume` takes the conversation up as it is; failing that, `session/load` replays it first.
        // Only the agent's own answer turns it down: a process or transport that fails is a failure to start.
        const refusal = (error: unknown) => {
          if (error instanceof AcpError) return error;
          throw error;
        };
        const resumed = capabilities?.sessionCapabilities?.resume
          ? await connection.request<{ configOptions?: unknown }>('session/resume', params).catch(refusal)
          : new AcpError(0, `${this.profile.name} can't resume a conversation`);
        let taken = resumed;
        if (resumed instanceof AcpError && capabilities?.loadSession === true) {
          replaying = true;
          try {
            taken = await connection.request<{ configOptions?: unknown }>('session/load', params).catch(refusal);
          } finally {
            replaying = false;
          }
        }
        if (taken instanceof AcpError) throw new ResumeRefused(`${this.profile.name} could not resume this Session's conversation: ${taken.message.replace(/\.$/, '')}`);
        reported = taken?.configOptions;
      }
      configured(reported);
      if (earlyCommands?.forSession === sessionId) report(earlyCommands.update);
      earlyCommands = undefined;
    } catch (error) {
      abandoned = true;
      await channel.kill().catch(() => {});
      if (error instanceof ResumeRefused) throw error;
      throw new Error(`${this.profile.name} could not start a session: ${(error as Error).message}`);
    }
    const id = sessionId;
    const name = this.profile.name;
    /** Sets one config option; the agent answers with all of them as they now are. */
    const set = async (category: string, value: string, what: string) => {
      const option = optionOf(options, category);
      if (!option) throw new Error(`${name} offers no ${what} to pick here.`);
      try {
        const { configOptions } = await connection.request<{ configOptions?: unknown }>('session/set_config_option', { sessionId: id, configId: option.id, value });
        configured(configOptions);
      } catch (error) {
        throw new Error(`${name} could not switch to ${what} ${value}: ${(error as Error).message}`);
      }
    };
    return {
      id,
      configure: async ({ model, effort }: ModelPick) => {
        if (model !== undefined && model !== config.model) await set(MODEL, model, 'the model');
        if (effort !== undefined && effort !== config.effort) await set(EFFORT, effort, 'Effort');
      },
      prompt: (prompt) => {
        onEvent({ type: 'run-started' });
        connection.request<{ stopReason: string; usage?: unknown }>('session/prompt', { sessionId: id, prompt: promptBlocks(prompt, images) }).then(
          (response) => {
            // ACP's per-turn usage is unstable: what doesn't fit is left out, never a failure.
            const tokens = tokensOf(response?.usage);
            if (tokens) onEvent({ type: 'turn-usage', tokens });
            onEvent({ type: 'run-settled' });
          },
          (error: Error) => onEvent({ type: 'run-failed', error: error.message }),
        );
      },
      answer: (requestId, response) => asked.get(requestId)?.answer(response),
      // ACP: the client answers what the agent still asks as cancelled; the run then ends as cancelled.
      cancel: () => {
        for (const request of [...asked.values()]) request.cancel();
        void connection.notify('session/cancel', { sessionId: id }).catch(() => {});
      },
      close: async () => {
        await connection.end().catch(() => {});
        let grace: ReturnType<typeof setTimeout> | undefined;
        const kill = new Promise<void>((resolve) => (grace = setTimeout(resolve, EXIT_GRACE_MS)));
        if ((await Promise.race([connection.exited.then(() => 'exited'), kill])) !== 'exited') await channel.kill().catch(() => {});
        clearTimeout(grace);
      },
    };
  }
}

/**
 * A prompt as ACP content blocks: its text, then a link to each attached
 * file's copy in the Environment, which every ACP agent takes; an image goes
 * inline instead to an agent that takes images, still naming its copy.
 */
function promptBlocks({ text, files }: AgentPrompt, images: boolean): Array<Record<string, unknown>> {
  return [
    ...(text ? [{ type: 'text', text }] : []),
    ...files.map(({ path, name, mimeType, size, data }) => {
      const uri = fileUri(path);
      if (images && isImage(mimeType) && data) return { type: 'image', mimeType, data: Buffer.from(data).toString('base64'), uri };
      return { type: 'resource_link', name, uri, mimeType, size };
    }),
  ];
}

/** A `file://` URI for an absolute path, `/home/…` or `C:/…`. */
function fileUri(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  return `file://${slashed.startsWith('/') ? '' : '/'}${encodeURI(slashed).replaceAll('?', '%3F').replaceAll('#', '%23')}`;
}

/** What translating a session's updates needs. */
interface UpdateContext {
  /** The name and kind of each tool call, by its id, as the agent reported them first: its updates leave them out. */
  calls: Map<string, { name?: string; kind?: string }>;
  workingCopy: string;
  /** See AcpProfile.planTool. */
  planTool?: string;
}

function translate(update: SessionUpdate, { calls, workingCopy, planTool }: UpdateContext): AgentEvent | undefined {
  switch (update.sessionUpdate) {
    case 'available_commands_update': {
      const listed = (update as { availableCommands?: unknown }).availableCommands;
      if (!Array.isArray(listed)) return undefined;
      return { type: 'commands', commands: agentCommandsOf('command', listed) };
    }
    case 'usage_update': {
      const { used, size, cost } = update as { used?: unknown; size?: unknown; cost?: { amount?: unknown; currency?: unknown } };
      if (!isCount(used) || !isCount(size) || size === 0) return undefined;
      const amount = cost?.amount;
      // Only USD is summed; a cost in another currency isn't one Loom can add up.
      const reported = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && (cost?.currency ?? 'USD') === 'USD' ? amount : undefined;
      return { type: 'usage', used, size, ...(reported === undefined ? {} : { cost: reported }) };
    }
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const text = (update as ContentChunk).content?.type === 'text' ? (update as ContentChunk).content?.text : undefined;
      if (!text) return undefined;
      return { type: update.sessionUpdate === 'agent_message_chunk' ? 'text-delta' : 'thinking-delta', text };
    }
    case 'plan': {
      const { entries } = update as { entries?: unknown };
      return Array.isArray(entries) ? { type: 'plan', entries: planOf(entries) } : undefined;
    }
    case 'tool_call':
    case 'tool_call_update': {
      const call = update as AcpToolCall;
      if (typeof call.toolCallId !== 'string') return undefined;
      const known = calls.get(call.toolCallId) ?? {};
      // OpenCode names its tool beside ACP's fields, on the call's start only.
      const name = known.name ?? (typeof call.name === 'string' && call.name ? call.name : undefined);
      const reportedKind = typeof call.kind === 'string' ? call.kind : undefined;
      const kind = reportedKind ?? known.kind;
      calls.set(call.toolCallId, { ...(name ? { name } : {}), ...(kind ? { kind } : {}) });
      if (planTool !== undefined && name === planTool) {
        const todos = (call.rawInput as { todos?: unknown } | undefined)?.todos;
        return Array.isArray(todos) ? { type: 'plan', entries: planOf(todos) } : undefined;
      }
      const command = kind === 'execute' ? (call.rawInput as { command?: unknown } | undefined)?.command : undefined;
      const fields = {
        toolCallId: call.toolCallId,
        toolKind: reportedKind,
        name: update.sessionUpdate === 'tool_call' ? name : undefined,
        command: typeof command === 'string' && command ? command : undefined,
        subject: subjectOf(call, workingCopy),
        status: STATUSES[call.status as string],
        input: call.rawInput === undefined ? undefined : stringOf(call.rawInput),
        output: outputOf(call),
        diffs: diffsOf(call, workingCopy),
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

/** What Loom reads of the capabilities an ACP agent reports in `initialize`. */
interface AgentCapabilities {
  loadSession?: unknown;
  promptCapabilities?: { image?: unknown };
  /** `resume` is ACP's unstable `session/resume`. */
  sessionCapabilities?: { resume?: unknown };
}

// ACP v1's session config options: Loom reads the model and Effort ones, by
// category (ACP's `thought_level` for Effort), and leaves the rest alone.
interface ConfigOption {
  id?: unknown;
  category?: unknown;
  type?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

const MODEL = 'model';
const EFFORT = 'thought_level';
/** The id of each category's option, as OpenCode names them, for an agent that leaves the category out: ACP makes it optional. */
const OPTION_IDS: Record<string, string> = { [MODEL]: 'model', [EFFORT]: 'effort' };

/** The select option of `category`, if the agent has one; else the one of that category's usual id. */
function optionOf(options: ConfigOption[], category: string): (ConfigOption & { id: string }) | undefined {
  const selects = options.filter((o): o is ConfigOption & { id: string } => typeof o?.id === 'string' && o.type === 'select');
  return selects.find((o) => o.category === category) ?? selects.find((o) => o.id === OPTION_IDS[category]);
}

/** The values of a select option, with their names, flattened out of any groups. */
function choicesOf(option: ConfigOption | undefined): Array<{ value: string; name?: string }> {
  const flat = (list: unknown): Array<{ value: string; name?: string }> =>
    Array.isArray(list)
      ? list.flatMap((o: { value?: unknown; name?: unknown; options?: unknown }) =>
          typeof o?.value === 'string' ? [{ value: o.value, ...(typeof o.name === 'string' ? { name: o.name } : {}) }] : flat(o?.options),
        )
      : [];
  return flat(option?.options);
}

/** What Loom reads of the agent's config options: its models, as `provider/model`, and the current model's Effort levels. */
function configOf(options: ConfigOption[]): AgentConfig {
  const model = optionOf(options, MODEL);
  const effort = optionOf(options, EFFORT);
  const models: ModelChoice[] = choicesOf(model).map(({ value, name }) => {
    // OpenCode names a model `provider/Name`; the provider is in its id already.
    const provider = value.split('/', 1)[0]!;
    const shown = name?.startsWith(`${provider}/`) ? name.slice(provider.length + 1) : name;
    return { id: value, name: shown || value };
  });
  const efforts = choicesOf(effort).map((c) => c.value);
  return {
    ...(typeof model?.currentValue === 'string' && model.currentValue ? { model: model.currentValue } : {}),
    models,
    ...(typeof effort?.currentValue === 'string' && efforts.length ? { effort: effort.currentValue } : {}),
    efforts,
  };
}

/** ACP's `PromptResponse.usage` (unstable) as Loom's token counts; undefined unless it has input and output counts. */
function tokensOf(usage: unknown): TokenCounts | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  if (!isCount(u.inputTokens) || !isCount(u.outputTokens)) return undefined;
  const count = (value: unknown) => (isCount(value) ? value : 0);
  return { input: u.inputTokens, output: u.outputTokens, reasoning: count(u.thoughtTokens), cacheRead: count(u.cachedReadTokens), cacheWrite: count(u.cachedWriteTokens) };
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

// ACP v1's shapes for the updates Loom shows. Anything else in them is ignored.
interface ContentChunk {
  content?: { type: string; text?: string };
}

interface AcpToolCall {
  toolCallId?: unknown;
  /** OpenCode's own: the tool's name. */
  name?: unknown;
  locations?: unknown;
  title?: unknown;
  kind?: unknown;
  status?: unknown;
  content?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
}

const STATUSES: Record<string, ToolStatus> = { pending: 'running', in_progress: 'running', completed: 'completed', failed: 'failed' };

/** The tool's output as text: its content blocks but its diffs, or else its raw output. */
function outputOf({ content, rawOutput }: AcpToolCall): string | undefined {
  if (Array.isArray(content) && content.length > 0) {
    const blocks = content.filter((block) => !isDiff(block));
    // A call that only changed files has nothing else to say.
    return blocks.length ? blocks.map(contentText).join('\n') : undefined;
  }
  if (rawOutput === undefined || rawOutput === null) return undefined;
  // OpenCode puts the text a tool returned in `output`, beside its metadata.
  const output = (rawOutput as { output?: unknown }).output;
  return typeof output === 'string' ? output : stringOf(rawOutput);
}

/** One tool call content block as text; what isn't text is summarised. */
function contentText(block: unknown): string {
  const { type, content } = (block ?? {}) as { type?: unknown; content?: { type?: unknown; text?: unknown } };
  if (type === 'content') return content?.type === 'text' && typeof content.text === 'string' ? content.text : `[${String(content?.type ?? 'content')}]`;
  return `[${String(type ?? 'content')}]`;
}

const PLAN_STATUSES = new Set<string>(['pending', 'in_progress', 'completed', 'cancelled']);

/** A plan's steps, as ACP's entries or OpenCode's todos give them: those with text, a status Loom doesn't know read as pending. */
function planOf(entries: unknown[]): PlanEntry[] {
  return entries.flatMap((entry) => {
    const { content, status } = (entry ?? {}) as { content?: unknown; status?: unknown };
    if (typeof content !== 'string' || !content.trim()) return [];
    return [{ content, status: typeof status === 'string' && PLAN_STATUSES.has(status) ? (status as PlanStatus) : 'pending' }];
  });
}

/**
 * What the call worked on: what it searched for or fetched, as its input
 * says, or else the files and folders it names, the working copy itself left
 * out. Undefined when it says neither.
 */
function subjectOf({ rawInput, locations }: AcpToolCall, workingCopy: string): string | undefined {
  const input = (rawInput ?? {}) as { pattern?: unknown; query?: unknown; url?: unknown };
  const sought = [input.pattern, input.query, input.url].find((value): value is string => typeof value === 'string' && value !== '');
  if (sought) return sought;
  const paths = Array.isArray(locations) ? locations.flatMap((l: { path?: unknown }) => (typeof l?.path === 'string' ? [inWorkingCopy(l.path, workingCopy)] : [])) : [];
  const named = paths.filter((path) => path !== '' && path !== workingCopy);
  return named.length ? named.join(', ') : undefined;
}

/** ACP's diff content block: a file's text before (null for a new file) and after. */
interface AcpDiff {
  type: 'diff';
  path: string;
  oldText?: string | null;
  newText: string;
}

function isDiff(block: unknown): block is AcpDiff {
  const { type, path, oldText, newText } = (block ?? {}) as Record<string, unknown>;
  return type === 'diff' && typeof path === 'string' && typeof newText === 'string' && (oldText === undefined || oldText === null || typeof oldText === 'string');
}

/** The files the call changed, as its diff blocks say; undefined when it has none. */
function diffsOf({ content }: AcpToolCall, workingCopy: string): ToolCall['diffs'] {
  if (!Array.isArray(content)) return undefined;
  const diffs = content.filter(isDiff).map(({ path, oldText, newText }) => ({ path: inWorkingCopy(path, workingCopy), ...(typeof oldText === 'string' ? { oldText } : {}), newText }));
  return diffs.length ? diffs : undefined;
}

/** `path` from the working copy when it is in there (`src/app.ts`), else as it is. */
function inWorkingCopy(path: string, workingCopy: string): string {
  const slashed = (p: string) => p.replaceAll('\\', '/');
  const root = slashed(workingCopy).replace(/\/+$/, '');
  const file = slashed(path);
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : path;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
}

// ACP v1's permission request: the tool call the agent wants to make, and the options to answer with.
interface PermissionRequest {
  sessionId?: unknown;
  toolCall?: AcpToolCall;
  options?: unknown;
}

/** What the agent wants to do, from its tool call: the command for a shell one, the paths for the rest. */
function approvalActionOf(call: NonNullable<PermissionRequest['toolCall']>, ownTools: ReadonlySet<string>): ApprovalAction {
  const input = (call.rawInput ?? {}) as { command?: unknown; cwd?: unknown; workdir?: unknown };
  // OpenCode names the tool; ACP itself only gives its kind, which says nothing of whose it is.
  const name = typeof call.name === 'string' && call.name ? call.name : undefined;
  const tool = name ?? (typeof call.kind === 'string' ? call.kind : 'tool');
  const command = typeof input.command === 'string' ? input.command : undefined;
  const cwd = typeof input.workdir === 'string' ? input.workdir : typeof input.cwd === 'string' ? input.cwd : undefined;
  const paths = Array.isArray(call.locations) ? call.locations.flatMap((l: { path?: unknown }) => (typeof l?.path === 'string' ? [l.path] : [])) : [];
  return defined({
    toolCallId: typeof call.toolCallId === 'string' ? call.toolCallId : undefined,
    tool,
    toolKind: typeof call.kind === 'string' ? call.kind : undefined,
    title: typeof call.title === 'string' && call.title.trim() ? call.title : (command ?? tool),
    command,
    cwd: command === undefined ? undefined : cwd,
    // A shell command's location is the folder it runs in, not what it touches.
    paths: command === undefined ? paths : [],
    extension: name !== undefined && !ownTools.has(name.toLowerCase()),
  });
}

/** ACP v1's answer to a permission request: an option picked, or cancelled with the run. */
type PermissionResponse = { outcome: { outcome: 'selected'; optionId: string } } | { outcome: { outcome: 'cancelled' } };

/**
 * Loom answers only "once" or "reject", never "always": a grant for the
 * Session lives in Loom. Options are picked by kind, falling back to
 * OpenCode's ids.
 */
function permissionResponse(options: unknown, approved: boolean): PermissionResponse {
  const kind = approved ? 'allow_once' : 'reject_once';
  const option = Array.isArray(options) ? options.find((o: { kind?: unknown; optionId?: unknown }) => o?.kind === kind && typeof o.optionId === 'string') : undefined;
  return { outcome: { outcome: 'selected', optionId: (option as { optionId: string } | undefined)?.optionId ?? (approved ? 'once' : 'reject') } };
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
