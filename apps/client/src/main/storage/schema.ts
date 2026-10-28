// The database's typed schema, as of the latest migration.

export interface SettingsTable {
  key: string;
  /** JSON-encoded value. */
  value: string;
}

export interface Schema {
  settings: SettingsTable;
}
