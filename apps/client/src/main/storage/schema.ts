// The database's typed schema, as of the latest migration.
import type { Generated } from 'kysely';

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

export interface Schema {
  settings: SettingsTable;
  projects: ProjectsTable;
  checkouts: CheckoutsTable;
}
