// Loom's own contract with an agent (ADR 0005). The Session service drives
// every agent through it; how an agent is spoken to (ACP for OpenCode) stays
// behind it. Adapters report facts as events; the Session service derives
// Session status from them.
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
  /** The run ended normally. */
  | { type: 'run-settled' }
  /** The run ended in an error, such as a provider's (no credit, exhausted quota). */
  | { type: 'run-failed'; error: string }
  /** The agent's process ended; the session can't be used any more. */
  | { type: 'closed'; error?: string };

export interface OpenOptions {
  environment: AgentEnvironment;
  /** The Session's working copy, where the agent works. */
  workingCopy: string;
  onEvent: (event: AgentEvent) => void;
}

export interface AgentAdapter {
  /** The agent's name, as the UI shows it. */
  readonly name: string;
  /** Starts the agent for a new conversation in the working copy. */
  open(options: OpenOptions): Promise<AgentSession>;
}

/** One conversation with an agent, in its own process. */
export interface AgentSession {
  /** The agent's own id for the conversation. */
  readonly id: string;
  /** Starts a run; its progress and outcome arrive as events. */
  prompt(text: string): void;
  /** Ends the agent's process. */
  close(): Promise<void>;
}
