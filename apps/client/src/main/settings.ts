// Loom's own settings, kept as JSON values in the database's settings table.
import { DEFAULT_SETTINGS, type Settings as SettingsValues } from '../shared/api';
import type { LoomDatabase } from './storage/database';

export class Settings {
  private constructor(
    private readonly db: LoomDatabase,
    private current: SettingsValues,
    private readonly onChange: (settings: SettingsValues) => void,
  ) {}

  /** The settings in the database, defaults for those never set. */
  static async load(db: LoomDatabase, onChange: (settings: SettingsValues) => void): Promise<Settings> {
    const rows = await db.selectFrom('settings').selectAll().execute();
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
    const current = { ...DEFAULT_SETTINGS };
    if (typeof stored.worktreeRoot === 'string') current.worktreeRoot = stored.worktreeRoot;
    return new Settings(db, current, onChange);
  }

  get value(): SettingsValues {
    return this.current;
  }

  async setWorktreeRoot(worktreeRoot: string): Promise<SettingsValues> {
    return this.set('worktreeRoot', checkWorktreeRoot(worktreeRoot));
  }

  private async set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]): Promise<SettingsValues> {
    const json = JSON.stringify(value);
    await this.db
      .insertInto('settings')
      .values({ key, value: json })
      .onConflict((c) => c.column('key').doUpdateSet({ value: json }))
      .execute();
    this.current = { ...this.current, [key]: value };
    this.onChange(this.current);
    return this.current;
  }
}

/** Rejects unless a worktree root is absolute or starts with `~`. */
export function checkWorktreeRoot(root: string): string {
  const trimmed = root.trim();
  if (!isAbsolute(trimmed) && trimmed !== '~' && !/^~[/\\]/.test(trimmed)) {
    throw new Error(`"${root}" can't be the worktree root: it must be an absolute path or start with ~`);
  }
  return trimmed;
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path);
}
