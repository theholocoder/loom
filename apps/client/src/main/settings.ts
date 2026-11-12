// Loom's own settings, kept as JSON values in the database's settings table.
import { DEFAULT_APPROVALS, DEFAULT_SETTINGS, isApprovalCategory, isApprovalMode, type ApprovalCategory, type ApprovalMode, type ApprovalSetting, type DiffViewSettings, type HighlightsSettings, type Settings as SettingsValues } from '../shared/api';
import { clampPanelSize, isPanelArea, isPanelDimension, isPanelKind, readLayout, type PanelArea, type PanelDimension, type PanelKind } from '../shared/panels';
import { clampInboxWidth, readInbox, type InboxSettings } from '../shared/window';
import { splitCommandLine } from './command-line';
import { isMonoFont, isTheme, isUiFont, type Appearance } from '../shared/appearance';
import type { LoomDatabase } from './storage/database';

export interface SettingsOptions {
  /** Rejects, saying why, a worktree root no worktree could go under. */
  checkWorktreeRootFolder?: (root: string) => Promise<void>;
}

export class Settings {
  private constructor(
    private readonly db: LoomDatabase,
    private current: SettingsValues,
    private readonly onChange: (settings: SettingsValues) => void,
    private readonly options: SettingsOptions,
  ) {}

  /** The settings in the database, defaults for those never set. */
  static async load(db: LoomDatabase, onChange: (settings: SettingsValues) => void, options: SettingsOptions = {}): Promise<Settings> {
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
    // Each Panel kind's area and size stand alone: one Loom no longer has is dropped, one never set takes its kind's own.
    current.layout = readLayout(stored.layout);
    current.inbox = readInbox(stored.inbox);
    // Each part of the Changes view's layout stands alone: one Loom no longer takes falls back to its default.
    if (typeof stored.diffView === 'object' && stored.diffView !== null) {
      const { fileList, wrap, sideBySide } = stored.diffView as Record<string, unknown>;
      current.diffView = {
        fileList: typeof fileList === 'boolean' ? fileList : current.diffView.fileList,
        wrap: typeof wrap === 'boolean' ? wrap : current.diffView.wrap,
        sideBySide: typeof sideBySide === 'boolean' ? sideBySide : current.diffView.sideBySide,
      };
    }
    // Kept only as it can be set: a model while on.
    try {
      current.highlights = checkHighlights(stored.highlights as HighlightsSettings);
    } catch {
      // Never set, or not as Loom takes it: off.
    }
    // A value Loom no longer offers falls back to the default.
    if (isTheme(stored.theme)) current.theme = stored.theme;
    if (isUiFont(stored.uiFont)) current.uiFont = stored.uiFont;
    if (isMonoFont(stored.monoFont)) current.monoFont = stored.monoFont;
    return new Settings(db, current, onChange, options);
  }

  get value(): SettingsValues {
    return this.current;
  }

  async setWorktreeRoot(worktreeRoot: string): Promise<SettingsValues> {
    const root = checkWorktreeRoot(worktreeRoot);
    await this.options.checkWorktreeRootFolder?.(root);
    return this.set('worktreeRoot', root);
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

  /** Sets a Panel kind's width or height in the Layout, kept within its minimum and maximum. */
  async setPanelSize(kind: PanelKind, dimension: PanelDimension, size: number): Promise<SettingsValues> {
    if (!isPanelKind(kind)) throw new Error(`"${String(kind)}" is not a Panel.`);
    if (!isPanelDimension(dimension)) throw new Error(`A Panel's size is its width or its height, not "${String(dimension)}".`);
    if (typeof size !== 'number' || !Number.isFinite(size)) throw new Error("A Panel's size must be a number of pixels.");
    const { layout } = this.current;
    return this.set('layout', { ...layout, [dimension]: { ...layout[dimension], [kind]: clampPanelSize(kind, dimension, size) } });
  }

  /** Sets the area a Panel kind sits in, in the Layout: the Side area or the Dock. */
  async setPanelArea(kind: PanelKind, area: PanelArea): Promise<SettingsValues> {
    if (!isPanelKind(kind)) throw new Error(`"${String(kind)}" is not a Panel.`);
    if (!isPanelArea(area)) throw new Error(`A Panel sits in the Side area or the Dock, not "${String(area)}".`);
    const { layout } = this.current;
    return this.set('layout', { ...layout, area: { ...layout.area, [kind]: area } });
  }

  /** Sets the Inbox's width, kept within its least and most, whether it is shown, or both. */
  async setInbox(inbox: Partial<InboxSettings>): Promise<SettingsValues> {
    if (typeof inbox !== 'object' || inbox === null) throw new Error("The Inbox's settings must be an object.");
    const { width, open } = inbox;
    if (width !== undefined && (typeof width !== 'number' || !Number.isFinite(width))) throw new Error("The Inbox's width must be a number of pixels.");
    if (open !== undefined && typeof open !== 'boolean') throw new Error('Whether the Inbox is shown must be true or false.');
    const current = this.current.inbox;
    return this.set('inbox', { width: width === undefined ? current.width : clampInboxWidth(width), open: open ?? current.open });
  }

  /** Sets the Changes view's layout, all of it, so that quick changes can't undo each other. */
  async setDiffView(diffView: DiffViewSettings): Promise<SettingsValues> {
    const { fileList, wrap, sideBySide } = diffView;
    if (typeof fileList !== 'boolean' || typeof wrap !== 'boolean' || typeof sideBySide !== 'boolean') throw new Error("Each part of the Changes view's layout must be true or false.");
    return this.set('diffView', { fileList, wrap, sideBySide });
  }

  /** Sets Session highlights, all of it; rejects turning it on without a model. */
  async setHighlights(highlights: HighlightsSettings): Promise<SettingsValues> {
    return this.set('highlights', checkHighlights(highlights));
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

/** Session highlights as Loom keeps them: the model and Effort trimmed, a blank one left out. */
function checkHighlights(highlights: HighlightsSettings): HighlightsSettings {
  if (typeof highlights !== 'object' || highlights === null) throw new Error('Session highlights must be an object.');
  const { on, model, effort } = highlights;
  if (typeof on !== 'boolean') throw new Error('Whether Session highlights is on must be true or false.');
  if ((model !== undefined && typeof model !== 'string') || (effort !== undefined && typeof effort !== 'string')) throw new Error("Session highlights' model and Effort must be text.");
  const picked = model?.trim();
  const level = effort?.trim();
  if (on && !picked) throw new Error('Pick the model that checks Sessions for highlights before turning it on.');
  return { on, ...(picked ? { model: picked } : {}), ...(picked && level ? { effort: level } : {}) };
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
