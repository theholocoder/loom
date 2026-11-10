// The database's typed schema, as of the latest migration.
import type { Generated } from 'kysely';
import type { MergeRequestState, SessionStatus, TranscriptItem, WaitingReason, WorkingCopyKind } from '../../shared/api';

export interface SettingsTable {
  key: string;
  /** JSON-encoded value. */
  value: string;
}

export interface ProjectsTable {
  id: Generated<number>;
  name: string;
  branch_prefix: string;
  /** Whether the agent may trust the checkout's local files, as the user said once: 1 or 0, null until asked. */
  trusted: number | null;
  /** Clock time the Project was added. */
  created_at: number;
}

/** Where a Project's checkout is: one per Project. */
export interface CheckoutsTable {
  project_id: number;
  environment_id: string;
  path: string;
}

export interface SessionsTable {
  id: Generated<number>;
  project_id: number;
  title: string;
  working_copy_kind: WorkingCopyKind;
  working_copy_path: string;
  /** The agent's name, e.g. `OpenCode`. */
  agent: string;
  /** The agent's own id for the conversation (OpenCode's `ses_…`). */
  agent_session_id: string | null;
  status: SessionStatus;
  waiting_reason: WaitingReason | null;
  error: string | null;
  /** 1 when the user has stopped Babysit watching its Merge request, else 0. */
  babysit_off: number;
  /** 1 when its Merge request's feedback goes straight to the agent, else 0. */
  auto_prompt: number;
  /** How many auto-prompts have gone since the user's last message. */
  auto_prompts_in_a_row: number;
  /** 1 while the Session has news the user hasn't opened, else 0. */
  unread: number;
  /** The branch its working copy had checked out when last looked at. */
  branch: string | null;
  /** The linked issue: both set, or both null. */
  issue_number: number | null;
  issue_url: string | null;
  /** The linked Merge request: both set, or both null. */
  merge_request_number: number | null;
  merge_request_url: string | null;
  /** The Session's branch when its Merge request was linked: the link stays while the branch does. */
  merge_request_branch: string | null;
  /** 1 when the Merge request was linked by hand (the user, or the agent's tool) rather than found on the branch, else 0. */
  merge_request_by_hand: number;
  /** The model the user picked, `provider/model`, and its Effort level; null for the agent's own. */
  model: string | null;
  effort: string | null;
  /** How full the agent's context was after its last run that said: both set, or both null. */
  context_used: number | null;
  context_size: number | null;
  /** Clock times. */
  created_at: number;
  updated_at: number;
  /** The cost the agent last reported for its conversation, in USD, which more cost is counted from; null until known. */
  reported_cost: number | null;
  /** How long the wait for the user it is in had lasted when Loom last closed, in ms: it goes on as the same wait. */
  wait_carried_ms: number;
  /** Clock time it was archived; null while it isn't. */
  archived_at: number | null;
  /** How many times it went Waiting as stuck. */
  stuck_count: number;
  /** Its Merge request's state as Loom last saw it; null with none linked. */
  merge_request_state: MergeRequestState | null;
}

/** The usage of one Session's turns on one day with one model: what they add up to. */
export interface UsageBucketsTable {
  session_id: number;
  /** The day the turns ended, `YYYY-MM-DD` in local time. */
  day: string;
  /** The model Loom ran them with, `provider/model`. */
  model: string;
  project_id: number;
  /** The Project's name when they were recorded, so usage outlives the Project. */
  project_name: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  /** In USD, as the agent reported it. */
  cost: number;
}

/**
 * A stretch of a Session's time: a `run` (Working until it went Waiting or
 * was archived) or a `wait` for the user (Waiting on a question or Approval
 * request, or finished, while Loom ran).
 */
export interface SessionSpansTable {
  session_id: number;
  kind: 'run' | 'wait';
  started_at: number;
  ended_at: number;
}

/** A Session's transcript: its normalized events, in order. */
export interface EventsTable {
  session_id: number;
  /** The event's position in its Session's transcript, from 0. */
  seq: number;
  kind: TranscriptItem['kind'];
  /** The event's fields but its kind, JSON-encoded. */
  data: string;
}

/** The messages queued for Sessions while Working, sent in `id` order. */
export interface QueuedMessagesTable {
  id: number;
  session_id: number;
  text: string;
  /** What is attached to it (Attachment[], JSON-encoded); null when nothing is. */
  attachments: string | null;
  /** Clock time it was queued. */
  created_at: number;
}

/** What Babysit remembers of the Merge request a Session has linked. */
export interface BabysitTable {
  session_id: number;
  /** The Merge request's URL, its seen items, what is waiting to be told and its last poll, JSON-encoded. */
  state: string;
}

export interface Schema {
  settings: SettingsTable;
  projects: ProjectsTable;
  checkouts: CheckoutsTable;
  sessions: SessionsTable;
  events: EventsTable;
  queued_messages: QueuedMessagesTable;
  usage_buckets: UsageBucketsTable;
  session_spans: SessionSpansTable;
  babysit: BabysitTable;
}
