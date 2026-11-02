// The database's typed schema, as of the latest migration.
import type { Generated } from 'kysely';
import type { SessionStatus, WaitingReason, WorkingCopyKind } from '../../shared/api';

export interface SettingsTable {
  key: string;
  /** JSON-encoded value. */
  value: string;
}

export interface ProjectsTable {
  id: Generated<number>;
  name: string;
  branch_prefix: string;
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
  /** Clock times. */
  created_at: number;
  updated_at: number;
}

export interface Schema {
  settings: SettingsTable;
  projects: ProjectsTable;
  checkouts: CheckoutsTable;
  sessions: SessionsTable;
}
