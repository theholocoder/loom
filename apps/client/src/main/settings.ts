// Loom's own settings, kept as JSON values in the database's settings table.
import { clampSidebarWidth, DEFAULT_APPROVALS, DEFAULT_SETTINGS, isApprovalCategory, isApprovalMode, isSidebarView, type ApprovalCategory, type ApprovalMode, type ApprovalSetting, type DiffViewSettings, type Settings as SettingsValues, type SidebarSettings } from '../shared/api';
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
    if (isStuckAfterMinutes(stored.stuckAfterMinutes)) current.stuckAfterMinutes = stored.stuckAfterMinutes;
    if (typeof stored.autoPromptDefault === 'boolean') current.autoPromptDefault = stored.autoPromptDefault;
    if (isApprovalMode(stored.approvalModeDefault)) current.approvalModeDefault = stored.approvalModeDefault;
    // Categories stored are kept; one Loom no longer has is dropped, and a new one gets its default.
    if (typeof stored.approvals === 'object' && stored.approvals !== null) {
      const approvals = { ...DEFAULT_APPROVALS };
      for (const [category, setting] of Object.entries(stored.approvals)) if (isApprovalCategory(category) && isApprovalSetting(setting)) approvals[category] = setting;
      current.approvals = approvals;
    }
    // Each part of the sidebar's state stands alone: one Loom no longer takes falls back to its default.
    if (typeof stored.sidebar === 'object' && stored.sidebar !== null) {
      const { open, view, width } = stored.sidebar as Record<string, unknown>;
      current.sidebar = {
        open: typeof open === 'boolean' ? open : current.sidebar.open,
        view: isSidebarView(view) ? view : current.sidebar.view,
        width: typeof width === 'number' && Number.isFinite(width) ? clampSidebarWidth(width) : current.sidebar.width,
      };
    }
    // Likewise each part of the Changes view's layout.
    if (typeof stored.diffView === 'object' && stored.diffView !== null) {
      const { fileList, wrap, sideBySide } = stored.diffView as Record<string, unknown>;
      current.diffView = {
        fileList: typeof fileList === 'boolean' ? fileList : current.diffView.fileList,
        wrap: typeof wrap === 'boolean' ? wrap : current.diffView.wrap,
        sideBySide: typeof sideBySide === 'boolean' ? sideBySide : current.diffView.sideBySide,
      };
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

  async setStuckAfterMinutes(minutes: number): Promise<SettingsValues> {
    if (!isStuckAfterMinutes(minutes)) throw new Error('A Session is stuck after a whole number of minutes, at least 1.');
    return this.set('stuckAfterMinutes', minutes);
  }

  async setAutoPromptDefault(on: boolean): Promise<SettingsValues> {
    if (typeof on !== 'boolean') throw new Error('Whether auto-prompt is on must be true or false.');
    return this.set('autoPromptDefault', on);
  }

  async setApprovalModeDefault(mode: ApprovalMode): Promise<SettingsValues> {
    if (!isApprovalMode(mode)) throw new Error(`"${String(mode)}" is not an Approval mode`);
    return this.set('approvalModeDefault', mode);
  }

  /** Sets whether the agent asks before actions of `category`; rejects an unknown category or setting. */
  async setApproval(category: ApprovalCategory, setting: ApprovalSetting): Promise<SettingsValues> {
    if (!isApprovalCategory(category)) throw new Error(`"${String(category)}" is not an approval category`);
    if (!isApprovalSetting(setting)) throw new Error(`An approval setting is "allow" or "ask", not "${String(setting)}"`);
    return this.set('approvals', { ...this.current.approvals, [category]: setting });
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

  /** Sets what is given of the sidebar's state, keeping the width within bounds; rejects a view Loom has not. */
  async setSidebar(sidebar: Partial<SidebarSettings>): Promise<SettingsValues> {
    const { open, view, width } = sidebar;
    if (open !== undefined && typeof open !== 'boolean') throw new Error('Whether the sidebar is open must be true or false.');
    if (view !== undefined && !isSidebarView(view)) throw new Error(`"${String(view)}" is not a sidebar view.`);
    if (width !== undefined && (typeof width !== 'number' || !Number.isFinite(width))) throw new Error("The sidebar's width must be a number of pixels.");
    return this.set('sidebar', {
      open: open ?? this.current.sidebar.open,
      view: view ?? this.current.sidebar.view,
      width: width === undefined ? this.current.sidebar.width : clampSidebarWidth(width),
    });
  }

  /** Sets the Changes view's layout, all of it, so that quick changes can't undo each other. */
  async setDiffView(diffView: DiffViewSettings): Promise<SettingsValues> {
    const { fileList, wrap, sideBySide } = diffView;
    if (typeof fileList !== 'boolean' || typeof wrap !== 'boolean' || typeof sideBySide !== 'boolean') throw new Error("Each part of the Changes view's layout must be true or false.");
    return this.set('diffView', { fileList, wrap, sideBySide });
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

/** Whether `value` is a whole number of minutes, at least 1. */
function isStuckAfterMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Whether `value` is Allow or Ask. */
function isApprovalSetting(value: unknown): value is ApprovalSetting {
  return value === 'allow' || value === 'ask';
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
