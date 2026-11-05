// Loom's own contract with an agent (ADR 0005). The Session service drives
// every agent through it; how an agent is spoken to (ACP for OpenCode) stays
// behind it. Adapters report facts as events; the Session service derives
// Session status from them.
import type { AgentConfig, Answer, ApprovalPolicy, ModelPick, QuestionField, ToolStatus } from '../../shared/api';
import type { Channel, ChannelParams } from '../environments/channel';

/** Where an agent's process runs: its Session's Environment. */
export interface AgentEnvironment {
  label: string;
  openChannel(params: ChannelParams): Promise<Channel>;
}

/** What an agent reports, in Loom's vocabulary. */
export type AgentEvent =
  | { type: 'run-started' }
  | { type: 'text-delta'; text: string }
  /** More of the agent's thinking, shown apart from its reply. */
  | { type: 'thinking-delta'; text: string }
  /** The agent called a tool: one of its own, or one from the user's MCP servers and plugins. */
  | ({ type: 'tool-started'; title: string } & ToolCall)
  /** What changed of a tool call; what's left out is as it was. `input` and `output` are given whole. */
  | ({ type: 'tool-updated'; title?: string } & ToolCall)
  /**
   * The agent asks the user something and waits for the answer: its question
   * tool, or a dialog from the user's plugins or MCP servers. Answered with
   * AgentSession.answer, under `requestId`.
   */
  | { type: 'question-asked'; requestId: string; message: string; fields: QuestionField[] }
  /** The agent asks whether to trust the Project's local files; answered like a question. */
  | { type: 'trust-asked'; requestId: string; message: string }
  /**
   * The agent paused before an action its approval rules ask about, until
   * AgentSession.answer approves or denies it under `requestId`.
   */
  | { type: 'approval-asked'; requestId: string; action: ApprovalAction }
  /** What the agent offers to pick and runs with: when it starts, and whenever that changes. */
  | { type: 'config'; config: AgentConfig }
  /** How full its context is, in tokens, out of the model's window: after a run. */
  | { type: 'usage'; used: number; size: number }
  /** The run ended normally. */
  | { type: 'run-settled' }
  /** The run ended in an error, such as a provider's (no credit, exhausted quota). */
  | { type: 'run-failed'; error: string }
  /** The agent's process ended; the session can't be used any more. */
  | { type: 'closed'; error?: string };

/** A tool call as an agent reports it, by the agent's id for it. */
export interface ToolCall {
  toolCallId: string;
  /** What sort of tool, such as read, edit or execute. */
  toolKind?: string;
  status?: ToolStatus;
  input?: string;
  output?: string;
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
}

export interface OpenOptions {
  environment: AgentEnvironment;
  /** The Session's working copy, where the agent works. */
  workingCopy: string;
  /** The Environment's temp directory, where the agent works freely too. */
  tempDir: string;
  /** What the agent asks approval for, beyond its working copy and the temp directory. */
  approvals: ApprovalPolicy;
  onEvent: (event: AgentEvent) => void;
}

export interface AgentAdapter {
  /** The agent's name, as the UI shows it. */
  readonly name: string;
  /** Whether its sessions take a message mid-run (`AgentSession.steer`). */
  readonly canSteer?: boolean;
  /** Starts the agent for a new conversation in the working copy. */
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
  /** Gives the agent `text` mid-run, for an agent that can be steered (`AgentAdapter.canSteer`). */
  steer?(prompt: AgentPrompt): void;
  /** Ends the agent's process. */
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

/** The user's response to an agent's request: an answer to its question (null dismisses it), whether to trust, or whether to go ahead once. */
export type AgentResponse = { kind: 'question'; answer: Answer | null } | { kind: 'trust'; trusted: boolean } | { kind: 'approval'; approved: boolean };
