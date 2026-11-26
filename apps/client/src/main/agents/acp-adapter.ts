// An AgentAdapter for any agent that speaks ACP v1 over stdio, one process per
// Session (ADR 0005). A profile says how to start a given agent; ACP itself
// stays inside this module, translated into Loom's AgentEvents.
import { isImage, type AgentConfig, type Answer, type ModelChoice, type ModelPick, type PlanEntry, type PlanStatus, type QuestionField, type QuestionOption, type SubagentStatus, type TokenCounts, type ToolStatus } from '../../shared/api';
import { ResumeRefused, type AgentAdapter, type AgentEvent, type AgentPrompt, type AgentResponse, type AgentSession, type ApprovalAction, type OpenOptions, type ScriptCall, type SubagentEvent, type SubagentReport, type ToolCall } from './adapter';
import { systemClock, type Clock, type TimerHandle } from '../clock';
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
  /**
   * The agent's tool that starts a Subagent, if it reports its Subagents as
   * OpenCode does (`opencode/session/child_update`, which Loom opts into).
   */
  subagentTool?: string;
}

const PROTOCOL_VERSION = 1;

/**
 * How long a run the agent started on its own (a background run, as on a
 * Subagent's result) may say nothing, with no tool call running and nothing
 * asked, before it counts as ended: the agent reports no end to it.
 */
export const BACKGROUND_RUN_QUIET_MS = 10_000;

/** OpenCode's opt-in to its Subagents' updates, and the notification they come in. */
const CHILD_UPDATES = 'opencode/child-session-updates';
const CHILD_UPDATE = 'opencode/session/child_update';

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
    /** What background runs' quiet is timed on. */
    private readonly clock: Clock = systemClock,
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
          // A background run waiting on the answer may go quiet from now.
          quietLater();
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
    const { planTool, subagentTool } = this.profile;
    /** What translating this session's updates needs. */
    const context: UpdateContext = { calls: new Map(), workingCopy, planTool, subagentTool };
    /** Whether Loom's `session/prompt` is open: updates that come with none are a background run's. */
    let prompting = false;
    /** The run the agent started on its own, while it goes, with the timer that ends it once quiet. */
    let background: { quiet?: TimerHandle } | undefined;
    /** The tool calls of the session's own run still running: a background run isn't quiet while one is. */
    const running = new Set<string>();
    const clock = this.clock;
    /** Ends the background run once it has said nothing for BACKGROUND_RUN_QUIET_MS, from now, unless it waits on something. */
    const quietLater = () => {
      if (!background) return;
      if (background.quiet !== undefined) clock.clearTimeout(background.quiet);
      background.quiet = undefined;
      if (running.size > 0 || asked.size > 0) return;
      background.quiet = clock.setTimeout(() => endBackground(), BACKGROUND_RUN_QUIET_MS);
    };
    const startBackground = () => {
      if (background || prompting) return;
      background = {};
      onEvent({ type: 'run-started', background: true });
      quietLater();
    };
    /** Ends the background run going, if any: reported as settled unless a prompt takes over. */
    const endBackground = ({ settle = true } = {}) => {
      if (!background) return;
      if (background.quiet !== undefined) clock.clearTimeout(background.quiet);
      background = undefined;
      running.clear();
      if (settle) onEvent({ type: 'run-settled' });
    };
    /** The Subagents the agent reported, by its id for them. */
    const children = new Map<string, Child>();
    /** Subagent tool calls not linked to their Subagent yet, by their parent's id ('' for the session's own). */
    const unlinked = new Map<string, Array<{ toolCallId: string; input: SubagentInput }>>();
    const reportChild = (child: Child, error?: string) => onEvent({ type: 'subagent-status', subagent: childReport(child, error) });
    /** Links `child` to the subagent tool call that started it: `toolCallId` when the agent said which, else the first by its description. */
    const link = (child: Child, toolCallId?: string): boolean => {
      if (child.toolCallId !== undefined) return false;
      const calls = unlinked.get(child.parentId ?? '') ?? [];
      const at = toolCallId !== undefined ? calls.findIndex((c) => c.toolCallId === toolCallId) : calls.findIndex((c) => c.input.description === child.title);
      if (at < 0) {
        if (toolCallId === undefined) return false;
        child.toolCallId = toolCallId;
        return true;
      }
      const [call] = calls.splice(at, 1);
      Object.assign(child, { toolCallId: call!.toolCallId, ...call!.input });
      return true;
    };
    /** Keeps what a tool call event says that background runs and Subagents need: whether it runs, and what a subagent tool call starts. */
    const noteCall = (event: AgentEvent, parent: string, update: SessionUpdate) => {
      if (event.type !== 'tool-started' && event.type !== 'tool-updated') return;
      if (parent === '') {
        if (event.status === 'running') running.add(event.toolCallId);
        else if (event.status !== undefined) running.delete(event.toolCallId);
      }
      const named = (parent === '' ? context : children.get(parent)?.context)?.calls.get(event.toolCallId)?.name;
      if (subagentTool === undefined || named !== subagentTool) return;
      const input = subagentInputOf((update as AcpToolCall).rawInput);
      if (input) {
        const calls = unlinked.get(parent) ?? [];
        const known = calls.find((c) => c.toolCallId === event.toolCallId);
        if (known) known.input = input;
        else if (![...children.values()].some((c) => c.toolCallId === event.toolCallId)) calls.push({ toolCallId: event.toolCallId, input });
        unlinked.set(parent, calls);
        // Its Subagent may have been reported first.
        const waiting = [...children.values()].find((c) => (c.parentId ?? '') === parent && c.toolCallId === undefined && c.title === input.description);
        if (waiting && link(waiting)) reportChild(waiting);
      }
      const started = event.subagentId === undefined ? undefined : children.get(event.subagentId);
      if (started && link(started, event.toolCallId)) reportChild(started);
    };
    /** Reports what Loom shows of a session update, if anything. */
    const report = (update: SessionUpdate) => {
      const event = translate(update, context);
      if (!event) return;
      noteCall(event, '', update);
      onEvent(event);
    };
    /** What the agent reported of one of its Subagents. */
    const childUpdated = (params: ChildUpdate) => {
      const id = params.childSessionId;
      if (typeof id !== 'string' || !id) return;
      let child = children.get(id);
      if (!child) {
        const parentId = typeof params.parentSessionId === 'string' && params.parentSessionId !== sessionId ? params.parentSessionId : undefined;
        child = { id, depth: count(params.depth) ?? 1, status: 'running', context: { calls: new Map(), workingCopy, planTool, subagentTool }, ...(parentId ? { parentId } : {}), ...(text(params.title) ? { title: params.title as string } : {}) };
        children.set(id, child);
        link(child);
        if (params.type !== 'status') reportChild(child);
      }
      if (params.type === 'status') {
        const status = typeof params.status === 'string' ? CHILD_STATUSES[params.status] : undefined;
        if (!status) return;
        const ended = status !== 'running';
        // The result of one the session's agent started starts its next run: Working from now, not between.
        if (ended && child.parentId === undefined && child.status === 'running') startBackground();
        child.status = status;
        const tokens = tokensOf(params.usage);
        if (tokens) onEvent({ type: 'subagent-usage', subagentId: id, tokens });
        reportChild(child, errorOf(params.error));
        return;
      }
      if (params.type !== 'update' || typeof params.update !== 'object' || params.update === null) return;
      const update = unprefixed(params.update as SessionUpdate, child.id, text(params.title));
      const event = translate(update, child.context);
      if (!event || !SUBAGENT_EVENTS.has(event.type)) return;
      noteCall(event, child.id, update);
      onEvent({ type: 'subagent-event', subagentId: id, event: event as SubagentEvent });
    };
    /** Which Subagent a request is from: undefined for the session's own; null for one Loom doesn't know. */
    const askerOf = (forSession: unknown): string | undefined | null => (forSession === sessionId ? undefined : typeof forSession === 'string' && children.has(forSession) ? forSession : null);
    const connection = new AcpConnection(channel, {
      onNotification: (method, params) => {
        if (method === CHILD_UPDATE) {
          if (subagentTool === undefined || replaying || sessionId === undefined || (params as ChildUpdate)?.rootSessionId !== sessionId) return;
          return childUpdated(params as ChildUpdate);
        }
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
        // With no prompt open, what the agent does is a run of its own (on a Subagent's result); news such as its usage isn't.
        const doing = subagentTool !== undefined && BACKGROUND_WORK.has(update.sessionUpdate);
        if (doing) startBackground();
        report(update);
        if (doing) quietLater();
      },
      onRequest: (method, params) => {
        if (method === 'session/request_permission') {
          const request = params as PermissionRequest;
          const asker = askerOf(request.sessionId);
          if (asker === null) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
          const call = asker === undefined || !request.toolCall ? request.toolCall : unprefixed(request.toolCall as AcpToolCall & SessionUpdate, asker, children.get(asker)?.title);
          const action = approvalActionOf(call ?? {}, this.profile.ownTools, request.options);
          return ask<PermissionResponse>(
            'permission',
            (requestId) => ({ type: 'approval-asked', requestId, action, ...(asker ? { subagentId: asker } : {}) }),
            (response) => (response.kind === 'approval' ? permissionResponse(request.options, response) : undefined),
            { outcome: { outcome: 'cancelled' } },
          );
        }
        if (method !== 'elicitation/create') return undefined;
        const request = params as ElicitationRequest;
        const asker = askerOf(request.sessionId);
        if (asker === null) return Promise.resolve({ action: 'cancel' });
        const fields = request.mode === 'form' ? fieldsOf(request.requestedSchema) : undefined;
        // A form Loom can't show is cancelled, as OpenCode does when it can't show one.
        if (!fields) return Promise.resolve({ action: 'cancel' });
        return ask<ElicitationResponse>(
          'elicitation',
          (requestId) => ({ type: 'question-asked', requestId, message: typeof request.message === 'string' ? request.message : '', fields, ...(asker ? { subagentId: asker } : {}) }),
          (response) => (response.kind === 'question' ? elicitationResponse(response) : undefined),
          { action: 'cancel' },
        );
      },
      onClose: (reason) => {
        asked.clear();
        endBackground({ settle: false });
        if (abandoned) return;
        onEvent({ type: 'closed', error: reason });
      },
    });
    /** Whether the agent takes images inline in a prompt, as `initialize` said. */
    let images = false;
    let canStopSubagents = false;
    try {
      const initialized = await connection.request<{ agentCapabilities?: AgentCapabilities }>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        // Without `elicitation.form`, OpenCode skips its questions and tells the model the user couldn't be asked.
        // With the opt-in, OpenCode reports its Subagents apart, rather than mixing them into the session's own updates.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} }, ...(subagentTool !== undefined ? { _meta: { [CHILD_UPDATES]: true } } : {}) },
        clientInfo: { name: 'loom', version: this.clientVersion },
      });
      images = initialized?.agentCapabilities?.promptCapabilities?.image === true;
      // Stopping one Subagent takes it up as a session of its own, then closes it, which interrupts it (OpenCode 2.4.2).
      canStopSubagents = subagentTool !== undefined && initialized?.agentCapabilities?.loadSession === true && !!initialized.agentCapabilities.sessionCapabilities?.close;
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
        // The prompt's run takes over from a background one Loom took to be going.
        endBackground({ settle: false });
        prompting = true;
        running.clear();
        onEvent({ type: 'run-started' });
        const ended = () => {
          prompting = false;
          running.clear();
        };
        connection.request<{ stopReason: string; usage?: unknown }>('session/prompt', { sessionId: id, prompt: promptBlocks(prompt, images) }).then(
          (response) => {
            ended();
            // ACP's per-turn usage is unstable: what doesn't fit is left out, never a failure.
            const tokens = tokensOf(response?.usage);
            if (tokens) onEvent({ type: 'turn-usage', tokens });
            onEvent({ type: 'run-settled' });
          },
          (error: Error) => {
            ended();
            onEvent({ type: 'run-failed', error: error.message });
          },
        );
      },
      answer: (requestId, response) => asked.get(requestId)?.answer(response),
      // ACP: the client answers what the agent still asks as cancelled; the run then ends as cancelled.
      // A background run has no prompt to end: Loom stops waiting on it.
      cancel: () => {
        for (const request of [...asked.values()]) request.cancel();
        void connection.notify('session/cancel', { sessionId: id }).catch(() => {});
        endBackground();
      },
      ...(canStopSubagents
        ? {
            stopSubagent: async (subagentId: string) => {
              const child = children.get(subagentId);
              if (child?.status !== 'running') throw new Error('That Subagent is not running.');
              try {
                // Its history, replayed, is no news: updates for any session but this one are left out.
                await connection.request('session/load', { sessionId: subagentId, cwd: workingCopy, mcpServers: [] });
                await connection.request('session/close', { sessionId: subagentId });
              } catch (error) {
                throw new Error(`${name} could not stop the Subagent: ${(error as Error).message}`);
              }
            },
          }
        : {}),
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
  /** See AcpProfile.subagentTool. */
  subagentTool?: string;
}

/** OpenCode 2.4.2's `opencode/session/child_update`: a status, or one of the Subagent's own session updates. */
interface ChildUpdate {
  rootSessionId?: unknown;
  childSessionId?: unknown;
  parentSessionId?: unknown;
  depth?: unknown;
  title?: unknown;
  type?: unknown;
  status?: unknown;
  error?: unknown;
  update?: unknown;
  /** Its tokens, in ACP's `PromptResponse.usage` shape, should the agent ever report them. */
  usage?: unknown;
}

/** What Loom keeps of one Subagent while its agent runs. */
interface Child extends Partial<SubagentInput> {
  id: string;
  parentId?: string;
  depth: number;
  /** What the agent calls it: the description it was given. */
  title?: string;
  status: SubagentStatus;
  toolCallId?: string;
  context: UpdateContext;
}

/** What a subagent tool call's input says of the Subagent. */
interface SubagentInput {
  description: string;
  agent?: string;
  model?: string;
}

/** The session updates that are the agent at work, which start a background run with no prompt open. */
const BACKGROUND_WORK = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);

const CHILD_STATUSES: Record<string, SubagentStatus> = { created: 'running', running: 'running', completed: 'completed', failed: 'failed', interrupted: 'interrupted' };
const SUBAGENT_EVENTS = new Set<AgentEvent['type']>(['text-delta', 'thinking-delta', 'plan', 'tool-started', 'tool-updated']);

function childReport({ id, parentId, depth, status, title, toolCallId, description, agent, model }: Child, error?: string): SubagentReport {
  return defined({ subagentId: id, parentId, depth, status, description: description ?? title, toolCallId, agent, model, error: status === 'failed' ? error : undefined });
}

/** The subagent tool's input, once it has its description: what to do, as which agent, on which model. */
function subagentInputOf(input: unknown): SubagentInput | undefined {
  const { description, agent, model } = (input ?? {}) as { description?: unknown; agent?: unknown; model?: unknown };
  if (!text(description)) return undefined;
  const { providerID, modelID } = (typeof model === 'object' && model !== null ? model : {}) as { providerID?: unknown; modelID?: unknown };
  const picked = text(model) ?? (text(providerID) && text(modelID) ? `${providerID as string}/${modelID as string}` : undefined);
  return defined({ description: description as string, agent: text(agent), model: picked });
}

/** A Subagent's update as its own: OpenCode prefixes its tool calls' ids with the Subagent's (`<id>:`) and their titles with its title (`<title>: `). */
function unprefixed<U extends SessionUpdate | AcpToolCall>(update: U, child: string, title: string | undefined): U {
  const call = update as AcpToolCall;
  const out = { ...update } as AcpToolCall;
  if (typeof call.toolCallId === 'string' && call.toolCallId.startsWith(`${child}:`)) out.toolCallId = call.toolCallId.slice(child.length + 1);
  if (title && typeof call.title === 'string' && call.title.startsWith(`${title}: `)) out.title = call.title.slice(title.length + 2);
  return out as U;
}

function errorOf(error: unknown): string | undefined {
  if (text(error)) return error as string;
  const message = (error as { message?: unknown } | undefined)?.message;
  return text(message);
}

function translate(update: SessionUpdate, { calls, workingCopy, planTool, subagentTool }: UpdateContext): AgentEvent | undefined {
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
        scriptCalls: scriptCallsOf(call),
        subagentId: subagentTool !== undefined && name === subagentTool ? text((call.rawOutput as { metadata?: { sessionID?: unknown } } | undefined)?.metadata?.sessionID) : undefined,
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
  /** `resume` is ACP's unstable `session/resume`, `close` its `session/close`. */
  sessionCapabilities?: { resume?: unknown; close?: unknown };
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

/** OpenCode's Code Mode script statuses, as Loom's. */
const SCRIPT_STATUSES: Record<string, ToolStatus> = { running: 'running', completed: 'completed', error: 'failed' };

/**
 * The tools an OpenCode Code Mode script (its `execute` tool) called, as its
 * ended call's `rawOutput.metadata.toolCalls` lists them; undefined without.
 */
function scriptCallsOf({ rawOutput }: AcpToolCall): ScriptCall[] | undefined {
  const listed = (rawOutput as { metadata?: { toolCalls?: unknown } } | undefined)?.metadata?.toolCalls;
  if (!Array.isArray(listed)) return undefined;
  return listed.flatMap((entry): ScriptCall[] => {
    const { tool, status, input } = (entry ?? {}) as { tool?: unknown; status?: unknown; input?: unknown };
    const known = typeof status === 'string' ? SCRIPT_STATUSES[status] : undefined;
    if (typeof tool !== 'string' || !tool || !known) return [];
    return [{ name: tool, status: known, ...(input === undefined ? {} : { input: stringOf(input) }) }];
  });
}

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
function approvalActionOf(call: NonNullable<PermissionRequest['toolCall']>, ownTools: ReadonlySet<string>, options: unknown): ApprovalAction {
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
    always: permissionOption(options, 'allow_always') ? true : undefined,
  });
}

/** The agent's option of ACP kind `kind`, if it offers one. */
function permissionOption(options: unknown, kind: string): { optionId: string } | undefined {
  return Array.isArray(options) ? options.find((o: { kind?: unknown; optionId?: unknown }) => o?.kind === kind && typeof o.optionId === 'string') : undefined;
}

/** ACP v1's answer to a permission request: an option picked, or cancelled with the run. */
type PermissionResponse = { outcome: { outcome: 'selected'; optionId: string } } | { outcome: { outcome: 'cancelled' } };

/**
 * Loom answers "once" or "reject", and "always" only when the user picked
 * it: a grant for the Session lives in Loom, the agent's "always" in the
 * agent. Options are picked by kind, falling back to OpenCode's ids.
 */
function permissionResponse(options: unknown, { approved, always }: { approved: boolean; always?: boolean }): PermissionResponse {
  const [kind, fallback] = !approved ? ['reject_once', 'reject'] : always ? ['allow_always', 'always'] : ['allow_once', 'once'];
  return { outcome: { outcome: 'selected', optionId: permissionOption(options, kind)?.optionId ?? fallback } };
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
