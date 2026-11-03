// Loom's own settings, kept as JSON values in the database's settings table.
import { DEFAULT_SETTINGS, type Settings as SettingsValues } from '../shared/api';
import { splitCommandLine } from './command-line';
import { isMonoFont, isTheme, isUiFont, type Appearance } from '../shared/appearance';
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
    if (typeof stored.editorCommand === 'string') current.editorCommand = stored.editorCommand;
    if (typeof stored.terminalCommand === 'string') current.terminalCommand = stored.terminalCommand;
    if (Array.isArray(stored.diffCollapsedPatterns) && stored.diffCollapsedPatterns.every((p) => typeof p === 'string')) {
      current.diffCollapsedPatterns = stored.diffCollapsedPatterns as string[];
    }
    // A value Loom no longer offers falls back to the default.
    if (isTheme(stored.theme)) current.theme = stored.theme;
    if (isUiFont(stored.uiFont)) current.uiFont = stored.uiFont;
    if (isMonoFont(stored.monoFont)) current.monoFont = stored.monoFont;
    return new Settings(db, current, onChange);
  }

  get value(): SettingsValues {
    return this.current;
  }

  async setWorktreeRoot(worktreeRoot: string): Promise<SettingsValues> {
    return this.set('worktreeRoot', checkWorktreeRoot(worktreeRoot));
  }

  async setEditorCommand(editorCommand: string): Promise<SettingsValues> {
    const command = checkCommand(editorCommand);
    if (!command) throw new Error('The editor command is empty: Loom needs it to open the editor.');
    return this.set('editorCommand', command);
  }

  async setTerminalCommand(terminalCommand: string): Promise<SettingsValues> {
    return this.set('terminalCommand', checkCommand(terminalCommand));
  }

  async setDiffCollapsedPatterns(patterns: string[]): Promise<SettingsValues> {
    if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) throw new Error('The collapsed-file patterns must be a list of text.');
    return this.set('diffCollapsedPatterns', patterns.map((p) => p.trim()).filter(Boolean));
  }

  /** Sets the theme or fonts given; rejects any not in Loom's lists. */
  async setAppearance(appearance: Partial<Appearance>): Promise<SettingsValues> {
    const { theme, uiFont, monoFont } = appearance;
    if (theme !== undefined && !isTheme(theme)) throw new Error(`"${String(theme)}" is not a theme`);
    if (uiFont !== undefined && !isUiFont(uiFont)) throw new Error(`"${String(uiFont)}" is not a UI font Loom offers`);
    if (monoFont !== undefined && !isMonoFont(monoFont)) throw new Error(`"${String(monoFont)}" is not a monospace font Loom offers`);
    if (theme !== undefined) await this.set('theme', theme);
    if (uiFont !== undefined) await this.set('uiFont', uiFont);
    if (monoFont !== undefined) await this.set('monoFont', monoFont);
    return this.current;
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

/** An editor or terminal command, trimmed; rejects one that can't be split into words. */
function checkCommand(command: string): string {
  splitCommandLine(command);
  return command.trim();
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
