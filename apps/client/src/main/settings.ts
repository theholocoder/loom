// Loom's own settings, kept as JSON values in the database's settings table.
import { DEFAULT_APPROVALS, DEFAULT_NOTIFICATIONS, DEFAULT_SETTINGS, isApprovalCategory, isApprovalMode, isNotificationKind, type ApprovalCategory, type ApprovalMode, type ApprovalSetting, type DiffViewSettings, type HighlightsSettings, type NotificationKind, type Settings as SettingsValues } from '../shared/api';
import { clampPanelSize, isPanelArea, isPanelDimension, isPanelKind, isPanelStack, readLayout, withPanelPlace, type LayoutSettings, type PanelArea, type PanelDimension, type PanelKind, type PanelStack } from '../shared/panels';
import { DEFAULT_KEYBINDINGS, readKeybindings, remap, type Shortcut, type ShortcutName } from '../shared/shortcuts';
import { clampInboxWidth, readInbox, type InboxSettings } from '../shared/window';
import { splitCommandLine } from './command-line';
import { isDateFormat, isHourCycle, type DateSettings } from '../shared/dates';
import { isAccent, isDarkTheme, isDensity, isFontSize, isLightTheme, isMonoFont, isThemeChoice, isUiFont, type Appearance } from '../shared/appearance';
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
    // Each kind stands alone: one Loom no longer has is dropped, a new one is off.
    if (typeof stored.notifications === 'object' && stored.notifications !== null) {
      const notifications = { ...DEFAULT_NOTIFICATIONS };
      for (const [kind, on] of Object.entries(stored.notifications)) if (isNotificationKind(kind) && typeof on === 'boolean') notifications[kind] = on;
      current.notifications = notifications;
    }
    // Each Panel kind's area and size stand alone: one Loom no longer has is dropped, one never set takes its kind's own.
    current.layout = readLayout(stored.layout);
    current.inbox = readInbox(stored.inbox);
    // Each remapped shortcut stands alone: one Loom no longer takes goes back to its own.
    current.keybindings = readKeybindings(stored.keybindings);
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
    for (const [key, { valid }] of [...APPEARANCE_FIELDS, ...DATE_FIELDS]) if (valid(stored[key])) Object.assign(current, { [key]: stored[key] });
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

  /** Turns desktop notifications of one kind of news on or off; rejects an unknown kind. */
  async setNotification(kind: NotificationKind, on: boolean): Promise<SettingsValues> {
    if (!isNotificationKind(kind)) throw new Error(`"${String(kind)}" is not a kind of notification`);
    if (typeof on !== 'boolean') throw new Error('Whether a notification is on must be true or false.');
    return this.set('notifications', { ...this.current.notifications, [kind]: on });
  }

  /** Sets an action's shortcut, taking it from any other that had it; rejects one Loom can't run. */
  async setKeybinding(name: ShortcutName, shortcut: Shortcut | null | 'default'): Promise<SettingsValues> {
    return this.set('keybindings', remap(this.current.keybindings, name, shortcut));
  }

  /** Turns the shortcuts without Ctrl on or off. */
  async setSingleKeyShortcuts(on: boolean): Promise<SettingsValues> {
    if (typeof on !== 'boolean') throw new Error('Whether the single-key shortcuts run must be true or false.');
    return this.set('keybindings', { ...this.current.keybindings, singleKeys: on });
  }

  /** Puts every shortcut back to Loom's own. */
  async resetKeybindings(): Promise<SettingsValues> {
    return this.set('keybindings', DEFAULT_KEYBINDINGS);
  }

  /** Sets the parts of the look given; rejects them all if any is not one Loom offers. */
  async setAppearance(appearance: Partial<Appearance>): Promise<SettingsValues> {
    if (typeof appearance !== 'object' || appearance === null) throw new Error('The look must be an object.');
    return this.setFields(APPEARANCE_FIELDS, appearance);
  }

  /** Sets the regional format dates and times follow, or their clock; rejects both if either is not one Loom offers. */
  async setDateFormat(dates: Partial<DateSettings>): Promise<SettingsValues> {
    if (typeof dates !== 'object' || dates === null) throw new Error('How dates are written must be an object.');
    return this.setFields(DATE_FIELDS, dates);
  }

  /** Sets the fields of `values` given, once each is checked against `fields`; sets none if one is wrong. */
  private async setFields<K extends string>(fields: [K, CheckedField][], values: Partial<Record<K, unknown>>): Promise<SettingsValues> {
    const given = fields.filter(([key]) => values[key] !== undefined);
    for (const [key, { valid, what }] of given) if (!valid(values[key])) throw new Error(`"${String(values[key])}" is not ${what}`);
    return this.setAll(Object.fromEntries(given.map(([key]) => [key, values[key]])));
  }

  /** Sets a Panel kind's width or height in the Layout, kept within its minimum and maximum. */
  async setPanelSize(kind: PanelKind, dimension: PanelDimension, size: number): Promise<SettingsValues> {
    if (!isPanelKind(kind)) throw new Error(`"${String(kind)}" is not a Panel.`);
    if (!isPanelDimension(dimension)) throw new Error(`A Panel's size is its width or its height, not "${String(dimension)}".`);
    if (typeof size !== 'number' || !Number.isFinite(size)) throw new Error("A Panel's size must be a number of pixels.");
    return this.changeLayout((layout) => ({ ...layout, [dimension]: { ...layout[dimension], [kind]: clampPanelSize(kind, dimension, size) } }));
  }

  /** Sets the area a Panel kind sits in, in the Layout, the Side area or the Dock, and the stack of it: its first, unless told its second. */
  async setPanelPlace(kind: PanelKind, area: PanelArea, stack: PanelStack = 'first'): Promise<SettingsValues> {
    if (!isPanelKind(kind)) throw new Error(`"${String(kind)}" is not a Panel.`);
    if (!isPanelArea(area)) throw new Error(`A Panel sits in the Side area or the Dock, not "${String(area)}".`);
    if (!isPanelStack(stack)) throw new Error(`A Panel sits in its area's first or second stack, not "${String(stack)}".`);
    return this.changeLayout((layout) => withPanelPlace(layout, kind, { area, stack }));
  }

  /** The Layout changes asked for, one after another. */
  private layoutChanges: Promise<unknown> = Promise.resolve();

  /** Changes the Layout once those asked for before are kept, from the Layout they left, so that two asked for at once both stay. */
  private changeLayout(change: (layout: LayoutSettings) => LayoutSettings): Promise<SettingsValues> {
    const changing = this.layoutChanges.then(() => this.set('layout', change(this.current.layout)));
    this.layoutChanges = changing.catch(() => {});
    return changing;
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
    return this.setAll({ [key]: value });
  }

  /** Keeps every setting given, then tells of the change once, so no one sees only some of them. */
  private async setAll(values: Partial<SettingsValues>): Promise<SettingsValues> {
    const rows = Object.entries(values).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
    if (rows.length === 0) return this.current;
    await this.db
      .insertInto('settings')
      .values(rows)
      .onConflict((c) => c.column('key').doUpdateSet((eb) => ({ value: eb.ref('excluded.value') })))
      .execute();
    this.current = { ...this.current, ...values };
    this.onChange(this.current);
    return this.current;
  }
}

/** A setting picked from Loom's list: whether a value is one Loom offers, and what it should have been when it isn't. */
interface CheckedField {
  valid: (value: unknown) => boolean;
  what: string;
}

/** Each part of the look, and how to check it. */
const APPEARANCE_FIELDS = Object.entries({
  theme: { valid: isThemeChoice, what: 'a theme' },
  lightTheme: { valid: isLightTheme, what: 'a light theme' },
  darkTheme: { valid: isDarkTheme, what: 'a dark theme' },
  uiFont: { valid: isUiFont, what: 'a UI font Loom offers' },
  monoFont: { valid: isMonoFont, what: 'a monospace font Loom offers' },
  fontSize: { valid: isFontSize, what: 'a font size' },
  density: { valid: isDensity, what: 'a density' },
  accent: { valid: isAccent, what: 'an accent colour' },
} satisfies Record<keyof Appearance, CheckedField>) as [keyof Appearance, CheckedField][];

/** How dates and times are written, and how to check it. */
const DATE_FIELDS = Object.entries({
  dateFormat: { valid: isDateFormat, what: 'a regional format Loom offers' },
  hourCycle: { valid: isHourCycle, what: 'a clock: 12-hour, 24-hour or the format’s own' },
} satisfies Record<keyof DateSettings, CheckedField>) as [keyof DateSettings, CheckedField][];

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
