// The database's typed schema, as of the latest migration.
import type { Generated } from 'kysely';
import type { SessionStatus, TranscriptItem, WaitingReason, WorkingCopyKind } from '../../shared/api';

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

export interface Schema {
  settings: SettingsTable;
  projects: ProjectsTable;
  checkouts: CheckoutsTable;
  sessions: SessionsTable;
  events: EventsTable;
  queued_messages: QueuedMessagesTable;
}
