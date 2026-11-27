// Loom's own contract with an agent (ADR 0005). The Session service drives
// every agent through it; how an agent is spoken to (ACP for OpenCode) stays
// behind it. Adapters report facts as events; the Session service derives
// Session status from them.
import type { AgentCommand, AgentConfig, Answer, ApprovalPolicy, ModelPick, FileChange, PlanEntry, QuestionField, SubagentStatus, TokenCounts, ToolStatus } from '../../shared/api';
import type { Channel, ChannelParams } from '../environments/channel';
import type { BridgeCall } from '../environments/exec';

/** Where an agent's process runs: its Session's Environment. */
export interface AgentEnvironment {
  label: string;
  openChannel(params: ChannelParams): Promise<Channel>;
}

/** What an agent reports, in Loom's vocabulary. */
export type AgentEvent =
  /**
   * A run started: one Loom prompted, or, `background`, one the agent
   * started on its own, as on a Subagent's result. A background run ends
   * with `run-settled` like any other.
   */
  | { type: 'run-started'; background?: true }
  | { type: 'text-delta'; text: string }
  /** More of the agent's thinking, shown apart from its reply. */
  | { type: 'thinking-delta'; text: string }
  /** The agent's plan for the run, whole: when it gives it, and whenever it changes. */
  | { type: 'plan'; entries: PlanEntry[] }
  /** The agent called a tool: one of its own, or one from the user's MCP servers and plugins. */
  | ({ type: 'tool-started'; title: string } & ToolCall)
  /** What changed of a tool call; what's left out is as it was. `input` and `output` are given whole. */
  | ({ type: 'tool-updated'; title?: string } & ToolCall)
  /**
   * The agent asks the user something and waits for the answer: its question
   * tool, or a dialog from the user's plugins or MCP servers. Answered with
   * AgentSession.answer, under `requestId`.
   */
  | { type: 'question-asked'; requestId: string; message: string; fields: QuestionField[]; subagentId?: string }
  /** The agent asks whether to trust the Project's local files; answered like a question. */
  | { type: 'trust-asked'; requestId: string; message: string }
  /**
   * The agent paused before an action its approval rules ask about, until
   * AgentSession.answer approves or denies it under `requestId`.
   */
  | { type: 'approval-asked'; requestId: string; action: ApprovalAction; subagentId?: string }
  /**
   * A Subagent started, or how its work goes changed: all that is known of
   * it each time. Its parent is the Session's agent, or another Subagent.
   */
  | { type: 'subagent-status'; subagent: SubagentReport }
  /** Something a Subagent did, as the Session's agent would report it. */
  | { type: 'subagent-event'; subagentId: string; event: SubagentEvent }
  /** What the agent offers to pick and runs with: when it starts, and whenever that changes. */
  | { type: 'config'; config: AgentConfig }
  /** The commands it offers, all of them (`kind: 'command'`): when it starts, and whenever they change. */
  | { type: 'commands'; commands: AgentCommand[] }
  /**
   * How full its context is, in tokens, out of the model's window: after a
   * run. `cost` is what the conversation has cost so far, in USD, as the agent
   * reports it (0 for subscription and local models), when it says.
   */
  | { type: 'usage'; used: number; size: number; cost?: number }
  /** The tokens the run used, by kind, once it has ended, cancelled or not: before its `run-settled`. */
  | { type: 'turn-usage'; tokens: TokenCounts }
  /** The tokens a Subagent used, when the agent reports them: counted as the Session's. */
  | { type: 'subagent-usage'; subagentId: string; tokens: TokenCounts }
  /** The run ended normally. */
  | { type: 'run-settled' }
  /** The run ended in an error, such as a provider's (no credit, exhausted quota). */
  | { type: 'run-failed'; error: string }
  /** The agent's process ended; the session can't be used any more. */
  | { type: 'closed'; error?: string };

/** What a Subagent does that its transcript shows. */
export type SubagentEvent = Extract<AgentEvent, { type: 'text-delta' | 'thinking-delta' | 'plan' | 'tool-started' | 'tool-updated' }>;

/** A Subagent as the agent reports it. */
export interface SubagentReport {
  /** The agent's own id for it. */
  subagentId: string;
  /** The Subagent that started it; absent for one the Session's agent started. */
  parentId?: string;
  depth: number;
  status: SubagentStatus;
  /** What it was asked to do, in a few words, once the agent says. */
  description?: string;
  /** The tool call that started it, in its parent's, once linked. */
  toolCallId?: string;
  /** The kind of agent it runs as, and the model it was given, when the agent says. */
  agent?: string;
  model?: string;
  error?: string;
}

/** A tool call as an agent reports it, by the agent's id for it. */
export interface ToolCall {
  toolCallId: string;
  /** What sort of tool, such as read, edit or execute. */
  toolKind?: string;
  /** The tool's own name, when the agent gives it. */
  name?: string;
  /** The command line, for a shell command. */
  command?: string;
  /** What it worked on: its files, in the working copy when they are in there, or what it searched for or fetched. */
  subject?: string;
  status?: ToolStatus;
  input?: string;
  output?: string;
  /** The files it changed, given whole; their paths in the working copy when they are in there. */
  diffs?: FileChange[];
  /**
   * The tools a script it ran called, named as the script called them
   * (`loom.link_merge_request`), once the script has ended: OpenCode's Code
   * Mode reports no tool call of its own for them.
   */
  scriptCalls?: ScriptCall[];
  /** The Subagent it started, for the agent's subagent tool, once the agent says which. */
  subagentId?: string;
}

/** A tool a script called, as the agent reports it: its name, how it went, and its input. */
export interface ScriptCall {
  name: string;
  status: ToolStatus;
  input?: string;
}

/** What an agent asks approval for, as it reports it. */
export interface ApprovalAction {
  /** The tool call it is part of, if the agent says. */
  toolCallId?: string;
  /** The tool's name, as the agent calls it: `shell`, `write`, `read`, or an MCP tool's. */
  tool: string;
  /** What sort of tool, such as read, edit or execute. */
  toolKind?: string;
  /** What the agent calls it: the command, a path, or the tool's name. */
  title: string;
  /** The command line, for a shell command. */
  command?: string;
  /** Where the command runs. */
  cwd?: string;
  /** The files or folders it is about, absolute. */
  paths: string[];
  /** Whether the tool is from the user's MCP servers or plugins rather than the agent's own. */
  extension: boolean;
  /** Whether the agent offers to allow it always (ACP's `allow_always`), as it keeps such a grant. */
  always?: true;
}

export interface OpenOptions {
  environment: AgentEnvironment;
  /** The Session's working copy, where the agent works. */
  workingCopy: string;
  /** The Environment's temp directory, where the agent works freely too. */
  tempDir: string;
  /** The folder attachments are copied into for it, where it works freely too. */
  attachmentsDir?: string;
  /** What the agent asks approval for, beyond its working copy and the temp directory. */
  approvals: ApprovalPolicy;
  /**
   * Every tool refused, the agent's own included, rather than `approvals`:
   * an agent that only reads what it is sent and answers (Session
   * highlights' checks, ADR 0010).
   */
  toolsOff?: boolean;
  /**
   * Loom's own MCP server, run in the Environment as `command args` over
   * stdio: its tools (`link_merge_request`, `link_issue`) are for Loom to see
   * the agent call. None when the Environment can't run it.
   */
  loomTools?: { command: string; args: string[] };
  /**
   * The agent's id of a conversation to take up again (`AgentSession.id`)
   * rather than start a new one; what it replays of its history isn't
   * reported. Opening rejects with ResumeRefused if the agent can't take it up.
   */
  resume?: string;
  onEvent: (event: AgentEvent) => void;
}

/** The agent started but can't take up the conversation it was asked to resume, as when it no longer has it. */
export class ResumeRefused extends Error {}

/**
 * Where an agent keeps the usage of its conversations, Loom's and the user's
 * own alike (its database, its transcripts), step by step, as it lets Loom
 * read it through an Environment's bridge. Absent for an agent Loom can only
 * count from what it reports of Loom's runs (`turn-usage`).
 */
export interface AgentUsageSource {
  /**
   * The agent's conversations in the Environment changed at or after `since`
   * (the agent's clock time, ms), or all of them without it. Rejects when the
   * agent can't say, as an older version that keeps no such record.
   */
  conversations(call: BridgeCall, since?: number): Promise<AgentConversation[]>;
  /**
   * The steps of conversation `id` that used the model, in any order: every
   * one completed at or after `since`, or all of them without it. A step
   * still going is left out until it completes.
   */
  steps(call: BridgeCall, id: string, since?: number): Promise<UsageStep[]>;
}

/** One of an agent's conversations, as its own records list it. */
export interface AgentConversation {
  /** The agent's own id for it: a Session's `AgentSession.id`, or a Subagent's `subagentId`. */
  id: string;
  /** The conversation that started it, for a Subagent's. */
  parentId?: string;
  /** The folder it runs in, when the agent says. */
  directory?: string;
  /** The agent's clock time it last changed. */
  updatedAt: number;
  createdAt?: number;
  /**
   * All it has used so far, when the agent keeps a total: more than its
   * steps when it also ran the model for itself (OpenCode's titles).
   */
  total?: { tokens: TokenCounts; cost: number };
}

/** One step of a conversation that used the model, as the agent's own records count it. */
export interface UsageStep {
  /** The agent's own id for it, unique in its conversation and growing with time. */
  id: string;
  /** The agent's clock time it completed: its usage is filed under that day. */
  at: number;
  startedAt?: number;
  endsRun: boolean;
  /** The model it ran with, `provider/model`, when the agent says. */
  model?: string;
  tokens: TokenCounts;
  /** What it cost, in USD, as the agent reports it (0 for subscription and local models). */
  cost: number;
}

export interface AgentAdapter {
  /** The agent's name, as the UI shows it. */
  readonly name: string;
  /** Whether its sessions take a message mid-run (`AgentSession.steer`). */
  readonly canSteer?: boolean;
  /** Where its usage can be read from, every conversation's, when it keeps one Loom can read. */
  readonly usage?: AgentUsageSource;
  /** Starts the agent in the working copy, for a new conversation or one it resumes. */
  open(options: OpenOptions): Promise<AgentSession>;
}

/** One conversation with an agent, in its own process. */
export interface AgentSession {
  /** The agent's own id for the conversation. */
  readonly id: string;
  /**
   * Has the agent run with `choice` from its next run: what is given and
   * differs from what it runs with now. Changing the model goes back to the
   * new model's default Effort unless one is given. Rejects a model or
   * Effort level the agent doesn't offer; a `config` event follows a change.
   */
  configure(choice: ModelPick): Promise<void>;
  /** Starts a run; its progress and outcome arrive as events. */
  prompt(prompt: AgentPrompt): void;
  /**
   * Answers what the agent asked under `requestId` in this run. A request
   * the agent no longer waits on is ignored.
   */
  answer(requestId: string, response: AgentResponse): void;
  /**
   * Interrupts the run going, if any: what the agent asks is withdrawn, and
   * the run ends (settles or fails) soon after.
   */
  cancel(): void;
  /**
   * Stops the running Subagent `subagentId` alone; its `subagent-status`
   * follows. Absent for an agent that can't. Rejects if the agent can't.
   */
  stopSubagent?(subagentId: string): Promise<void>;
  /** Gives the agent `text` mid-run, for an agent that can be steered (`AgentAdapter.canSteer`). */
  steer?(prompt: AgentPrompt): void;
  /** Ends the agent's process; resolves once it has exited, killed if it doesn't within a few seconds. */
  close(): Promise<void>;
}

/** What a run is asked: the user's text, and the files they attached, written where the agent can read them. */
export interface AgentPrompt {
  /** May be empty when files are attached. */
  text: string;
  files: PromptFile[];
}

/** A file attached to a prompt, as the agent gets it: a copy in its Environment. */
export interface PromptFile {
  /** Its path in the Environment. */
  path: string;
  /** Its file name, as the user attached it. */
  name: string;
  mimeType: string;
  /** In bytes. */
  size: number;
  /** An image's content, for an agent that takes images inline; absent for any other file. */
  data?: Uint8Array;
}

/**
 * The user's response to an agent's request: an answer to its question (null
 * dismisses it), whether to trust, or whether to go ahead, once or, with
 * `always`, by the agent's own "always" option.
 */
export type AgentResponse = { kind: 'question'; answer: Answer | null } | { kind: 'trust'; trusted: boolean } | { kind: 'approval'; approved: boolean; always?: boolean };
