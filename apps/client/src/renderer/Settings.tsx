import { Bell, CalendarClock, Check, CircleCheckBig, CircleX, CodeXml, FileDiff, FolderTree, Keyboard, LoaderCircle, MessagesSquare, Palette, Pencil, RotateCcw, RotateCw, Search, SearchX, Server, ShieldAlert, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { APPROVAL_CATEGORIES, APPROVAL_MODES, MAX_AUTO_PROMPTS, OPENCODE_MIN_VERSION, OPENCODE_NAME, type AgentStatus, type HighlightsSettings, type ApprovalCategory, type ApprovalMode, type ApprovalSetting, type EnvironmentState, type EnvironmentStatus, type LoomApi, type NotificationKind } from '../shared/api';
import { assignedBindings, checkShortcut, DEFAULT_KEYBINDINGS, isDefaultKeybindings, MODIFIER_KEYS, REMAPPABLE_SHORTCUTS, sameShortcut, SHORTCUTS, shortcutLabel, takenBy, type Shortcut, type ShortcutName } from '../shared/shortcuts';
import { ACCENTS, accentColours, DENSITIES, FONT_SIZES, isDarkTheme, isLightTheme, MATCH_SYSTEM_LABEL, MONO_FONTS, THEMES, UI_FONTS, type Accent, type Appearance, type Theme, type ThemeChoice } from '../shared/appearance';
import { ErrorText } from './ErrorText';
import { useApi, useTopic } from './api';
import { useSystemLocale } from './dates';
import { DATE_FORMATS, dateSettingsOf, Dates, HOUR_CYCLES, type DateSettings } from '../shared/dates';
import { useTheme } from './appearance';
import { useCheckoutModels } from './checkout';
import { effortsOf, ModelPickers } from './ModelPicker';
import { Select } from './Popover';

/** One setting: its name and what it does on the left, its control on the right, or under them for a wide one. */
interface SettingEntry {
  title: string;
  description?: ReactNode;
  /** Words to find it by, besides its section's, its name and its description. */
  keywords?: string;
  /** The control spans the row, under the name: for a text field that needs the room. */
  wide?: boolean;
  /** The control, saving each change and saying how that went; `label` is the setting's name. */
  Control: ComponentType<{ label: string }>;
}

/** A section of the Settings page: settings about one thing, or for Environments, a table of them. */
interface SettingsSection {
  id: string;
  title: string;
  icon: LucideIcon;
  description?: ReactNode;
  keywords?: string;
  settings: SettingEntry[];
  /** What the section shows besides its settings, found by its title and keywords. */
  Body?: ComponentType;
}

// The prototype has no Settings page; it uses the layout of its other full
// page, the Dashboard, a .dash page of cards, with a list of the sections
// beside them to go to one, and a search over every setting.
/** Checks each Environment's agent again on mount, so what a page shows of them is current. */
export function useAgentCheck() {
  const api = useApi();
  useEffect(() => {
    api.invoke('environments.detect').catch((error: unknown) => console.error('agent detection failed:', error));
  }, [api]);
}

export function Settings() {
  // Opening Settings checks the agents again, so what it shows is current.
  useAgentCheck();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => matching(SECTIONS, query), [query]);
  const page = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(SECTIONS[0]!.id);
  const active = shown.some(({ section }) => section.id === current) ? current : shown[0]?.section.id;

  // A section gone to stays current while it is in sight, though near the bottom the page can't bring it to the top.
  const goneTo = useRef<string>(undefined);
  const go = (event: MouseEvent, id: string) => {
    event.preventDefault();
    const section = document.getElementById(anchorOf(id));
    goneTo.current = id;
    section?.scrollIntoView?.({ block: 'start' });
    section?.focus({ preventScroll: true });
    setCurrent(id);
  };
  // Otherwise the section current in the list is the last whose top has scrolled up to the page's, or the last one once at the bottom.
  const followScroll = () => {
    const element = page.current;
    if (!element || shown.length === 0) return;
    const { top, bottom } = element.getBoundingClientRect();
    const sought = goneTo.current && document.getElementById(anchorOf(goneTo.current))?.getBoundingClientRect();
    if (sought && sought.top >= top - SECTION_TOP_SLACK && sought.top < bottom) return;
    goneTo.current = undefined;
    let at = shown[0]!.section.id;
    for (const { section } of shown) {
      const head = document.getElementById(anchorOf(section.id));
      if (head && head.getBoundingClientRect().top - top <= SECTION_TOP_SLACK) at = section.id;
    }
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 2) at = shown[shown.length - 1]!.section.id;
    setCurrent(at);
  };
  // What the search finds starts at the top of the page.
  useEffect(() => {
    if (page.current) page.current.scrollTop = 0;
  }, [query]);
  const clearOnEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !query) return;
    event.stopPropagation();
    setQuery('');
  };

  return (
    <div className="dash settings" ref={page} onScroll={followScroll}>
      <div className="settings-layout">
        <div className="settings-head">
          <h1>Settings</h1>
          <label className="settings-search">
            <Search className="sm" />
            <input type="search" aria-label="Search settings" placeholder="Search settings" value={query} spellCheck={false} onChange={(event) => setQuery(event.target.value)} onKeyDown={clearOnEscape} />
          </label>
        </div>
        <nav className="settings-nav" aria-label="Settings sections">
          {shown.map(({ section: { id, title, icon: Icon } }) => (
            <a key={id} href={`#${anchorOf(id)}`} aria-current={id === active ? 'true' : undefined} onClick={(event) => go(event, id)}>
              <Icon className="sm" />
              {title}
            </a>
          ))}
        </nav>
        <div className="settings-sections">
          {shown.length === 0 ? (
            <div className="empty">
              <SearchX className="sm" />
              No setting matches “{query.trim()}”.
            </div>
          ) : (
            shown.map(({ section, settings }) => <Section key={section.id} section={section} settings={settings} />)
          )}
        </div>
      </div>
    </div>
  );
}

const anchorOf = (id: string) => `settings-${id}`;

/** How far below the page's top, in pixels, a section's top may be and still count as at the top. */
const SECTION_TOP_SLACK = 40;

function Section({ section: { id, title, icon: Icon, description, Body }, settings }: { section: SettingsSection; settings: SettingEntry[] }) {
  return (
    <section id={anchorOf(id)} className="card settings-section" aria-labelledby={`${anchorOf(id)}-title`} tabIndex={-1}>
      <div className="card-head">
        <Icon className="sm" />
        <h2 id={`${anchorOf(id)}-title`}>{title}</h2>
      </div>
      {description && <p className="muted section-description">{description}</p>}
      {settings.map((setting) => (
        <SettingRow key={setting.title} setting={setting} />
      ))}
      {Body && <Body />}
    </section>
  );
}

function SettingRow({ setting: { title, description, wide, Control } }: { setting: SettingEntry }) {
  return (
    <div className={wide ? 'setting wide' : 'setting'}>
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {description && <div className="setting-description">{description}</div>}
      </div>
      <div className="setting-control">
        <Control label={title} />
      </div>
    </div>
  );
}

/**
 * The sections, and the settings in each, that the query finds: every one
 * for no query. Each word of it must be in the section's or the setting's
 * name, description or keywords; a section found by its own shows all of its
 * settings.
 */
function matching(sections: SettingsSection[], query: string): { section: SettingsSection; settings: SettingEntry[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const finds = (...texts: (ReactNode | undefined)[]) => {
    const text = texts.map(textOf).join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  };
  return sections.flatMap((section) => {
    const head = [section.title, section.description, section.keywords];
    if (finds(...head)) return [{ section, settings: section.settings }];
    const settings = section.settings.filter((setting) => finds(...head, setting.title, setting.description, setting.keywords));
    return settings.length > 0 ? [{ section, settings }] : [];
  });
}

/** The text in a description, to search it. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/** How long "Saved" shows after a change is saved. */
const SAVED_FOR_MS = 2000;

/**
 * Saving a setting's changes, and what to show of it: "Saved" for a moment
 * once main has kept one, or why main refused it, until the next change. Only
 * the latest change's outcome shows.
 */
function useSaving() {
  const [outcome, setOutcome] = useState<{ saved?: boolean; error?: string }>({});
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  /** Shows how `sending` went; resolves with its result, or undefined once refused. */
  const save = useCallback(<T,>(sending: Promise<T>): Promise<T | undefined> => {
    const id = ++latest.current;
    clearTimeout(timer.current);
    setOutcome({});
    return sending.then(
      (result) => {
        if (id === latest.current) {
          setOutcome({ saved: true });
          timer.current = setTimeout(() => setOutcome({}), SAVED_FOR_MS);
        }
        return result;
      },
      (error: unknown) => {
        if (id === latest.current) setOutcome({ error: (error as Error).message });
        return undefined;
      },
    );
  }, []);
  /** Forgets how the last change went, as when the value is put back. */
  const clear = useCallback(() => {
    latest.current++;
    clearTimeout(timer.current);
    setOutcome({});
  }, []);
  return { save, clear, ...outcome };
}

/** "Saved", announced, for a moment after a change is saved; why it was refused, if it was. */
function SaveFeedback({ saved, error, errorId }: { saved?: boolean; error?: string; errorId?: string }) {
  return (
    <>
      <span className="saved" role="status">
        {saved && (
          <>
            <Check className="sm" />
            Saved
          </>
        )}
      </span>
      {error && (
        <div className="err" role="alert" id={errorId}>
          <ErrorText text={error} />
        </div>
      )}
    </>
  );
}

const THEME_NAMES = Object.keys(THEMES) as Theme[];
const LIGHT_THEME_OPTIONS = THEME_NAMES.filter(isLightTheme).map((value) => ({ value, label: THEMES[value].label }));
const DARK_THEME_OPTIONS = THEME_NAMES.filter(isDarkTheme).map((value) => ({ value, label: THEMES[value].label }));
const FONT_SIZE_OPTIONS = (Object.keys(FONT_SIZES) as Appearance['fontSize'][]).map((value) => ({ value, label: `${FONT_SIZES[value].label} (${Math.round(FONT_SIZES[value].zoom * 100)}%)` }));
const DENSITY_OPTIONS = (Object.keys(DENSITIES) as Appearance['density'][]).map((value) => ({ value, label: DENSITIES[value].label }));
const UI_FONT_OPTIONS = (Object.keys(UI_FONTS) as Appearance['uiFont'][]).map((value) => ({ value, label: value }));
const MONO_FONT_OPTIONS = (Object.keys(MONO_FONTS) as Appearance['monoFont'][]).map((value) => ({ value, label: value }));

/** A setting picked from a list, saved as soon as an option is picked. */
function SelectSetting<T extends string>({ label, value, options, className, change }: { label: string; value: T; options: { value: T; label: string }[]; className?: string; change: (api: LoomApi, value: T) => Promise<unknown> }) {
  const api = useApi();
  const { save, saved, error } = useSaving();
  return (
    <>
      <Select label={label} className={className} value={value} options={options} onChange={(next) => void save(change(api, next))} />
      <SaveFeedback saved={saved} error={error} />
    </>
  );
}

/** The theme or a font, which the window takes on as soon as it is saved. */
function AppearanceSelect<K extends keyof Appearance>({ label, field, options, className }: { label: string; field: K; options: { value: Appearance[K]; label: string }[]; className?: string }) {
  const settings = useTopic('settings');
  if (!settings) return null;
  return <SelectSetting label={label} className={className} value={settings[field]} options={options} change={(api, value) => api.invoke('settings.setAppearance', { [field]: value })} />;
}

/** The moment each date format option is shown writing: a Monday afternoon. */
const SAMPLE_TIME = new Date(2026, 10, 9, 14, 5).getTime();

/**
 * How dates are written, or their clock, each option saying how it would
 * write the same moment, so the user picks by what they see.
 */
function DateSelect<K extends keyof DateSettings>({ label, field }: { label: string; field: K }) {
  const settings = useTopic('settings');
  const systemLocale = useSystemLocale();
  if (!settings) return null;
  const { choices, sample } = DATE_FIELDS[field];
  const options = (Object.keys(choices) as DateSettings[K][]).map((value) => {
    const dates = new Dates(systemLocale, { ...dateSettingsOf(settings), [field]: value });
    return { value, label: `${(choices as Record<DateSettings[K], { label: string }>)[value].label} (${sample(dates)})` };
  });
  return <SelectSetting label={label} value={settings[field]} options={options} change={(api, value) => api.invoke('settings.setDateFormat', { [field]: value })} />;
}

/** Each date setting's choices, and what its options show of the sample moment: a clock only the time, a format all of it. */
const DATE_FIELDS: { [K in keyof DateSettings]: { choices: Record<DateSettings[K], { label: string }>; sample: (dates: Dates) => string } } = {
  dateFormat: { choices: DATE_FORMATS, sample: (dates) => dates.full(SAMPLE_TIME) },
  hourCycle: { choices: HOUR_CYCLES, sample: (dates) => dates.time(SAMPLE_TIME) },
};

/** A small window drawn in `theme`'s colours, and in `accent`'s shade for it: what the theme looks like. */
function ThemePreview({ theme, accent }: { theme: Theme; accent: Accent }) {
  const colours = accentColours(accent, theme);
  const style = colours && ({ '--accent': colours.accent, '--accent-text': colours.accentText } as CSSProperties);
  return (
    <span className="theme-preview" data-theme={theme} style={style} aria-hidden="true">
      <span className="theme-preview-side">
        <i />
        <i />
        <i />
      </span>
      <span className="theme-preview-main">
        <i className="theme-preview-line" />
        <i className="theme-preview-line short" />
        <i className="theme-preview-button" />
      </span>
    </span>
  );
}

/**
 * The theme, picked from previews of each, or Match system, which shows the
 * light and dark themes it switches between, and offers to change them.
 */
function ThemePicker({ label }: { label: string }) {
  const api = useApi();
  const settings = useTopic('settings');
  const { save, saved, error } = useSaving();
  const name = useId();
  if (!settings) return null;
  const set = (appearance: Partial<Appearance>) => void save(api.invoke('settings.setAppearance', appearance));
  const choices: ThemeChoice[] = ['system', ...THEME_NAMES];
  return (
    <>
      <div role="radiogroup" aria-label={label} className="theme-picker">
        {choices.map((choice) => (
          <label key={choice} className="theme-option">
            <input type="radio" className="sr-only" name={name} checked={settings.theme === choice} onChange={() => set({ theme: choice })} />
            <span className="theme-previews">
              {(choice === 'system' ? [settings.lightTheme, settings.darkTheme] : [choice]).map((theme) => (
                <ThemePreview key={theme} theme={theme} accent={settings.accent} />
              ))}
            </span>
            <span className="theme-name">{choice === 'system' ? MATCH_SYSTEM_LABEL : THEMES[choice].label}</span>
          </label>
        ))}
      </div>
      {settings.theme === 'system' && (
        <div className="theme-system">
          <span className="muted">In light mode</span>
          <Select label="Light theme" value={settings.lightTheme} options={LIGHT_THEME_OPTIONS} onChange={(lightTheme) => set({ lightTheme })} />
          <span className="muted">in dark mode</span>
          <Select label="Dark theme" value={settings.darkTheme} options={DARK_THEME_OPTIONS} onChange={(darkTheme) => set({ darkTheme })} />
        </div>
      )}
      <SaveFeedback saved={saved} error={error} />
    </>
  );
}

const ACCENT_NAMES = Object.keys(ACCENTS) as Accent[];

/** The accent colour, each swatch in its shade for the theme shown. */
function AccentPicker({ label }: { label: string }) {
  const api = useApi();
  const accent = useTopic('settings')?.accent;
  const theme = useTheme();
  const { save, saved, error } = useSaving();
  const name = useId();
  if (!accent) return null;
  return (
    <>
      <div role="radiogroup" aria-label={label} className="accent-picker">
        {ACCENT_NAMES.map((choice) => {
          const colours = accentColours(choice, theme);
          return (
            <label key={choice} className="accent-option">
              <input type="radio" className="sr-only" name={name} checked={accent === choice} onChange={() => void save(api.invoke('settings.setAppearance', { accent: choice }))} />
              {/* The theme's own swatch takes the theme's accent from its own data-theme. */}
              <span className="accent-swatch" aria-hidden="true" data-theme={colours ? undefined : theme} style={colours && { background: colours.accent }} />
              {ACCENTS[choice].label}
            </label>
          );
        })}
      </div>
      <SaveFeedback saved={saved} error={error} />
    </>
  );
}

const APPROVAL_OPTIONS: { value: ApprovalSetting; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
];
const APPROVAL_MODE_OPTIONS = (Object.keys(APPROVAL_MODES) as ApprovalMode[]).map((mode) => ({ value: mode, label: APPROVAL_MODES[mode].label }));

/** The Approval mode new Sessions start in. */
function ApprovalModeDefault() {
  const mode = useTopic('settings')?.approvalModeDefault;
  if (!mode) return null;
  return <SelectSetting label="Default Approval mode" value={mode} options={APPROVAL_MODE_OPTIONS} change={(api, next) => api.invoke('settings.setApprovalModeDefault', { mode: next })} />;
}

/** Whether the agent asks before one category of action beyond its working copy. */
function ApprovalCategorySetting({ label, category }: { label: string; category: ApprovalCategory }) {
  const setting = useTopic('settings')?.approvals[category];
  if (!setting) return null;
  return <SelectSetting label={label} value={setting} options={APPROVAL_OPTIONS} change={(api, next) => api.invoke('settings.setApproval', { category, setting: next })} />;
}

/** How long a Working Session's agent may say nothing before the Session is stuck. */
function StuckAfter({ label }: { label: string }) {
  const stored = useTopic('settings')?.stuckAfterMinutes;
  return (
    <TextSetting
      label={label}
      stored={stored === undefined ? '' : String(stored)}
      width="8ch"
      inputMode="numeric"
      save={(api, value) => api.invoke('settings.setStuckAfterMinutes', { minutes: Number(value.trim()) }).then((s) => String(s.stuckAfterMinutes))}
    />
  );
}

/** A checkbox setting, saved as soon as it is ticked or unticked. */
function Toggle({ label, on, disabled, change }: { label: string; on: boolean; disabled?: boolean; change: (api: LoomApi, on: boolean) => Promise<unknown> }) {
  const api = useApi();
  const { save, saved, error } = useSaving();
  return (
    <>
      <input type="checkbox" className="toggle" aria-label={label} checked={on} disabled={disabled} onChange={(event) => void save(change(api, event.target.checked))} />
      <SaveFeedback saved={saved} error={error} />
    </>
  );
}

/** Whether new Sessions send their Merge request's feedback straight to the agent. */
function AutoPromptDefault({ label }: { label: string }) {
  const on = useTopic('settings')?.autoPromptDefault ?? false;
  return <Toggle label={label} on={on} change={(api, next) => api.invoke('settings.setAutoPromptDefault', { on: next })} />;
}

/** Whether one kind of news shows a desktop notification. */
function NotificationToggle({ label, kind }: { label: string; kind: NotificationKind }) {
  const on = useTopic('settings')?.notifications[kind] ?? false;
  return <Toggle label={label} on={on} change={(api, next) => api.invoke('settings.setNotification', { kind, on: next })} />;
}

/** Each kind of desktop notification, as Settings lists it. */
const NOTIFICATION_SETTINGS: { kind: NotificationKind; title: string; description: string; keywords?: string }[] = [
  { kind: 'finished', title: 'When a Session finishes', description: "Its agent's run ended, or failed on an error.", keywords: 'done error' },
  { kind: 'question', title: 'When the agent asks a question', description: 'It waits for your answer, or for you to trust the Project.', keywords: 'trust' },
  { kind: 'approval', title: 'When the agent asks for approval', description: 'It is held on an Approval request.', keywords: 'approval request permission' },
  {
    kind: 'feedback',
    title: 'When a Merge request has new feedback',
    description: "Babysit saw new review comments, failed checks or a conflict, or the Merge request was merged or closed with unsaved work in the Session's worktree. Feedback that auto-prompt sends straight to the agent doesn't notify.",
    keywords: 'babysit review ci merged closed',
  },
  { kind: 'stuck', title: 'When a Session is stuck', description: 'Its agent has said nothing for the minutes set in Stuck after.', keywords: 'timeout idle' },
];

/** Whether the shortcuts without Ctrl run. */
function SingleKeyShortcuts({ label }: { label: string }) {
  const on = useTopic('settings')?.keybindings.singleKeys ?? DEFAULT_KEYBINDINGS.singleKeys;
  return <Toggle label={label} on={on} change={(api, next) => api.invoke('settings.setSingleKeyShortcuts', { on: next })} />;
}

/**
 * One action's shortcut: its keys, Change to press new ones, Remove, and
 * Reset to Loom's own once remapped. Says which action a shortcut was taken
 * from.
 */
function KeybindingSetting({ label, name }: { label: string; name: ShortcutName }) {
  const api = useApi();
  const keybindings = useTopic('settings')?.keybindings;
  const { save, saved, error } = useSaving();
  const [recording, setRecording] = useState(false);
  /** Which actions the last shortcut set was taken from, said under it. */
  const [takenNote, setTakenNote] = useState<string>();
  const change = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  if (!keybindings) return null;
  const shortcut = assignedBindings(keybindings)[name];
  const own = SHORTCUTS[name].shortcut;
  const off = !!shortcut && !shortcut.ctrl && !keybindings.singleKeys;
  const setShortcut = (next: Shortcut | null | 'default') => {
    const from = next ? takenBy(keybindings, name, next === 'default' ? own : next) : [];
    setTakenNote(undefined);
    change.current?.focus();
    void save(api.invoke('settings.setKeybinding', { name, shortcut: next })).then((kept) => {
      if (kept && from.length) setTakenNote(`Taken from “${from.map((other) => SHORTCUTS[other].label).join('”, “')}”, now with none.`);
    });
  };
  const refuse = (why: string) => {
    setTakenNote(undefined);
    void save(Promise.reject(new Error(why)));
  };
  const stop = () => {
    setRecording(false);
    change.current?.focus();
  };
  const record = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;
    // Tab still moves on, leaving the shortcut as it was.
    if (key === 'tab' && !ctrl && !event.altKey) return setRecording(false);
    // Nothing else reaches the window's shortcuts or the page, Escape included.
    event.preventDefault();
    event.stopPropagation();
    if (MODIFIER_KEYS.has(key)) return;
    if (key === 'escape' && !ctrl && !event.shiftKey && !event.altKey) return stop();
    if (event.altKey) return refuse("Loom's shortcuts don't take Alt: try Ctrl, or Ctrl Shift.");
    // By where the key sits, as Ctrl 1…9 are: AZERTY's 1 types &.
    if (ctrl && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) return refuse('Ctrl 1…9 open the Waiting Sessions in the Inbox.');
    let next: Shortcut;
    try {
      next = checkShortcut(name, { key, ...(ctrl ? { ctrl } : {}), ...(event.shiftKey ? { shift: true } : {}) });
    } catch (refusal) {
      return refuse((refusal as Error).message);
    }
    stop();
    if (!shortcut || !sameShortcut(next, shortcut)) setShortcut(next);
  };
  return (
    <>
      <div className="keybinding">
        {recording ? (
          <button
            type="button"
            className="keybinding-record"
            autoFocus
            aria-label={`New shortcut for ${label}: press it`}
            aria-describedby={error ? errorId : undefined}
            onKeyDown={record}
            onBlur={() => setRecording(false)}
          >
            Press the keys…
          </button>
        ) : shortcut ? (
          <kbd className={off ? 'off' : undefined} title={off ? 'Off, as the single-key shortcuts are' : undefined} aria-label={off ? `${shortcutLabel(shortcut)}, off` : undefined}>
            {shortcutLabel(shortcut)}
          </kbd>
        ) : (
          <span className="muted">None</span>
        )}
        <button ref={change} className="icon-btn sm" type="button" title="Change" aria-label={`Change the shortcut for ${label}`} onClick={() => setRecording(true)}>
          <Pencil />
        </button>
        {shortcut && (
          <button className="icon-btn sm" type="button" title="Remove" aria-label={`Remove the shortcut for ${label}`} onClick={() => setShortcut(null)}>
            <X />
          </button>
        )}
        {name in keybindings.remapped && (
          <button className="icon-btn sm" type="button" title={`Reset to ${shortcutLabel(own)}`} aria-label={`Reset the shortcut for ${label} to ${shortcutLabel(own)}`} onClick={() => setShortcut('default')}>
            <RotateCcw />
          </button>
        )}
      </div>
      <SaveFeedback saved={saved} error={error} errorId={errorId} />
      {takenNote && <div className="muted keybinding-taken">{takenNote}</div>}
    </>
  );
}

/** Puts every shortcut back to Loom's own. */
function ResetKeybindings({ label }: { label: string }) {
  const api = useApi();
  const keybindings = useTopic('settings')?.keybindings;
  const { save, saved, error } = useSaving();
  return (
    <>
      <button type="button" disabled={!keybindings || isDefaultKeybindings(keybindings)} onClick={() => void save(api.invoke('settings.resetKeybindings'))}>
        <RotateCcw className="sm" />
        {label}
      </button>
      <SaveFeedback saved={saved} error={error} />
    </>
  );
}

/** Loom's own shortcuts without Ctrl, as the single-key setting names them. */
const SINGLE_KEYS = REMAPPABLE_SHORTCUTS.map((name) => SHORTCUTS[name].shortcut as Shortcut)
  .filter((shortcut) => !shortcut.ctrl)
  .map(shortcutLabel);

/** Whether a model checks each turn for Session highlights; only once one is picked. */
function HighlightsOn({ label }: { label: string }) {
  const highlights = useTopic('settings')?.highlights;
  if (!highlights) return null;
  return (
    <Toggle
      label={label}
      on={highlights.on}
      disabled={!highlights.on && !highlights.model}
      change={(api, on) => api.invoke('settings.setHighlights', withoutUndefined({ ...highlights, on }))}
    />
  );
}

/** The model that checks for Session highlights, picked from those the agent offers in the first Project's checkout. */
function HighlightsModel() {
  const api = useApi();
  const highlights = useTopic('settings')?.highlights;
  const projectId = useTopic('projects')?.[0]?.id;
  const models = useCheckoutModels(projectId);
  const { save, saved, error } = useSaving();
  if (!highlights) return null;
  if (projectId === undefined) return <span className="muted">Add a Project to pick one from {OPENCODE_NAME}'s models.</span>;
  const change = (change: Partial<HighlightsSettings>) => void save(api.invoke('settings.setHighlights', withoutUndefined({ ...highlights, ...change })));
  return (
    <>
      <div className="row">
        <ModelPickers
          agent={OPENCODE_NAME}
          models={models.listed}
          model={highlights.model}
          efforts={effortsOf(models.listed, highlights.model)}
          effort={highlights.effort}
          // A model is needed to check: none is no default.
          placeholder="Pick a model"
          onOpen={models.refresh}
          onModel={(model) => change({ model, effort: undefined })}
          onEffort={(effort) => change({ effort })}
        />
      </div>
      <SaveFeedback saved={saved} error={error} />
    </>
  );
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Where new worktrees go; `~` is the home in each Project's Environment. */
function WorktreeRoot({ label }: { label: string }) {
  const stored = useTopic('settings')?.worktreeRoot ?? '';
  return <TextSetting label={label} stored={stored} placeholder="~/loom/worktrees" save={(api, worktreeRoot) => api.invoke('settings.setWorktreeRoot', { worktreeRoot }).then((s) => s.worktreeRoot)} />;
}

/** How Loom runs the user's editor, in each Session's Environment. */
function EditorCommand({ label }: { label: string }) {
  const stored = useTopic('settings')?.editorCommand ?? '';
  return <TextSetting label={label} stored={stored} placeholder="code" save={(api, editorCommand) => api.invoke('settings.setEditorCommand', { editorCommand }).then((s) => s.editorCommand)} />;
}

/** A terminal command to start from, for the native Environment's system. */
const TERMINAL_EXAMPLES: Record<string, string> = { windows: 'wt -d {path}', darwin: 'open -a Terminal {path}' };

/** How Loom runs the user's terminal, in each Session's Environment. */
function TerminalCommand({ label }: { label: string }) {
  const stored = useTopic('settings')?.terminalCommand ?? '';
  const os = useTopic('environments')?.find((e) => e.id === 'native')?.bridge?.os;
  return (
    <TextSetting
      label={label}
      stored={stored}
      placeholder={`For example: ${(os && TERMINAL_EXAMPLES[os]) ?? 'kitty --directory {path}'}`}
      save={(api, terminalCommand) => api.invoke('settings.setTerminalCommand', { terminalCommand }).then((s) => s.terminalCommand)}
    />
  );
}

/** The patterns of files the Changes view starts collapsed, one a line. */
function DiffCollapsedPatterns({ label }: { label: string }) {
  const stored = (useTopic('settings')?.diffCollapsedPatterns ?? []).join('\n');
  return (
    <TextSetting
      label={label}
      stored={stored}
      multiline
      placeholder="*.lock"
      save={(api, value) => api.invoke('settings.setDiffCollapsedPatterns', { patterns: value.split(/[\n,]/) }).then((s) => s.diffCollapsedPatterns.join('\n'))}
    />
  );
}

/**
 * One text setting, saved on Enter (Ctrl+Enter in a multi-line one) or on
 * leaving the field; Escape puts back the saved value. Says when it's saved,
 * or why main refused it until the field holds a value main takes, or the
 * saved one again.
 */
function TextSetting({
  label,
  stored,
  width,
  placeholder,
  multiline = false,
  inputMode,
  save: send,
}: {
  label: string;
  /** The value main has kept. */
  stored: string;
  /** A narrow field's width; without it, the field takes the row's. */
  width?: string;
  placeholder?: string;
  multiline?: boolean;
  inputMode?: 'numeric';
  /** Sends the new value to main; resolves with the value as main kept it. */
  save: (api: LoomApi, value: string) => Promise<string>;
}) {
  const api = useApi();
  const [value, setValue] = useState(stored);
  const { save, clear, saved, error } = useSaving();
  const errorId = useId();
  useEffect(() => setValue(stored), [stored]);

  // Enter submits, then leaving the field blurs it: save each value once.
  const sent = useRef<string>(undefined);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (value === stored) {
      // Back to the saved value: a refusal of another no longer holds.
      if (error) clear();
      return;
    }
    if (value === sent.current) return;
    sent.current = value;
    void save(send(api, value))
      .then((kept) => kept !== undefined && setValue(kept))
      .finally(() => (sent.current = undefined));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && (value !== stored || error)) {
      event.stopPropagation();
      setValue(stored);
      clear();
    } else if (multiline && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };
  const field = {
    className: 'tech text-setting',
    style: width ? { width } : undefined,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
    value,
    placeholder,
    spellCheck: false,
    onKeyDown,
    onBlur: () => submit(),
  };
  return (
    <form className="setting-form" onSubmit={submit}>
      {multiline ? (
        <textarea {...field} rows={3} onChange={(event) => setValue(event.target.value)} />
      ) : (
        <input {...field} inputMode={inputMode} onChange={(event) => setValue(event.target.value)} />
      )}
      <SaveFeedback saved={saved} error={error} errorId={errorId} />
    </form>
  );
}

/** Each Environment, its bridge and agent, and a way to read the shell's environment again. */
function EnvironmentsTable() {
  const environments = useTopic('environments') ?? [];
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Environment</th>
            <th>Status</th>
            <th>Agent</th>
            <th>Bridge</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {environments.map((env) => (
            <EnvironmentRow key={env.id} env={env} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SECTIONS: SettingsSection[] = [
  {
    id: 'appearance',
    title: 'Appearance',
    icon: Palette,
    keywords: 'look',
    settings: [
      {
        title: 'Theme',
        description: 'The colours of the whole window. Match system follows your system’s light or dark mode, with a theme for each.',
        keywords: 'color dark light mode system preview',
        wide: true,
        Control: ThemePicker,
      },
      {
        title: 'Accent colour',
        description: 'The colour of links, focus rings, what is current or picked, and primary buttons, in a shade that reads on the theme shown.',
        keywords: 'color highlight',
        wide: true,
        Control: AccentPicker,
      },
      { title: 'UI font', description: 'The font of the text around the code.', keywords: 'typeface', Control: ({ label }) => <AppearanceSelect label={label} field="uiFont" options={UI_FONT_OPTIONS} /> },
      {
        title: 'Monospace font',
        description: 'The font of code, diffs, paths and the Terminal.',
        keywords: 'typeface mono',
        Control: ({ label }) => <AppearanceSelect label={label} field="monoFont" options={MONO_FONT_OPTIONS} className="tech" />,
      },
      {
        title: 'Font size',
        description: 'Scales the whole window, text with its icons and spacing, so nothing crowds.',
        keywords: 'text zoom scale larger smaller',
        Control: ({ label }) => <AppearanceSelect label={label} field="fontSize" options={FONT_SIZE_OPTIONS} />,
      },
      {
        title: 'Density',
        description: 'How much room the Inbox, the conversation, Panels and pages leave around what they show.',
        keywords: 'compact comfortable spacing padding',
        Control: ({ label }) => <AppearanceSelect label={label} field="density" options={DENSITY_OPTIONS} />,
      },
    ],
  },
  {
    id: 'dates',
    title: 'Dates and times',
    icon: CalendarClock,
    keywords: 'locale region language time clock',
    settings: [
      {
        title: 'Regional format',
        description: 'The order of the day, month and year, and how times are written. Match system follows your system’s regional format. The words stay in English.',
        keywords: 'locale country date',
        Control: ({ label }) => <DateSelect label={label} field="dateFormat" />,
      },
      {
        title: 'Clock',
        description: 'Times on a 12-hour or a 24-hour clock, or as the regional format writes them.',
        keywords: '12-hour 24-hour am pm hour',
        Control: ({ label }) => <DateSelect label={label} field="hourCycle" />,
      },
    ],
  },
  {
    id: 'sessions',
    title: 'Sessions',
    icon: MessagesSquare,
    settings: [
      {
        title: 'Stuck after (minutes)',
        description: 'A Working Session whose agent says nothing for this long goes Waiting as stuck. Waiting on your answer or approval never counts.',
        keywords: 'timeout idle',
        Control: StuckAfter,
      },
      {
        title: 'Auto-prompt new Sessions',
        description: `New feedback on a Session's Merge request goes straight to its agent, up to ${MAX_AUTO_PROMPTS} attempts in a row without a message from you. Each Session can change this from its Merge request, in the Glance strip.`,
        keywords: 'merge request feedback review ci babysit',
        Control: AutoPromptDefault,
      },
      {
        title: 'Note highlights after each turn',
        description:
          "After each turn, a model reads what the turn said and did and notes, in the Session's Highlights Panel, what you should know: what's left for you, what wasn't done, risks, assumptions and decisions. It turns on once its model is picked.",
        keywords: 'session highlights',
        Control: HighlightsOn,
      },
      {
        title: 'Highlights model',
        description: "It runs as a conversation of its own, with every tool refused, so a cheap model does. Its tokens count on the dashboard under its model, but not in the Session's own usage.",
        keywords: 'session highlights effort',
        Control: HighlightsModel,
      },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: Bell,
    description: 'A desktop notification when a Session goes Waiting, which opens it when clicked. None while Loom has the focus on that Session, nor when you stop it yourself.',
    keywords: 'desktop alert waiting inbox',
    settings: NOTIFICATION_SETTINGS.map(
      ({ kind, title, description, keywords }): SettingEntry => ({ title, description, keywords, Control: ({ label }) => <NotificationToggle label={label} kind={kind} /> }),
    ),
  },
  {
    id: 'approvals',
    title: 'Approvals',
    icon: ShieldAlert,
    description:
      'The agent reads, edits and runs commands in its working copy and the temp directory freely. For the rest, Ask pauses it with an Approval request. Rules match commands and paths on a best-effort basis: a guardrail, not a security boundary. Agents started from now on get the changes.',
    keywords: 'permissions',
    settings: [
      {
        title: 'New Sessions start in',
        description: `${APPROVAL_MODES.supervised.label} follows the settings below. ${APPROVAL_MODES.full.label} approves everything the agent asks, a push to the default branch included. Each Session picks its own in the New Session composer, for good.`,
        keywords: 'approval mode default',
        Control: ApprovalModeDefault,
      },
      ...(Object.keys(APPROVAL_CATEGORIES) as ApprovalCategory[]).map(
        (category): SettingEntry => ({
          title: APPROVAL_CATEGORIES[category].label,
          description: APPROVAL_CATEGORIES[category].description,
          keywords: 'allow ask',
          Control: ({ label }) => <ApprovalCategorySetting label={label} category={category} />,
        }),
      ),
    ],
  },
  {
    id: 'worktrees',
    title: 'Worktrees',
    icon: FolderTree,
    settings: [
      {
        title: 'Worktree root',
        description: (
          <>
            Each worktree Session gets a folder named after its branch: <span className="tech">{'<root>/<project>/<session>'}</span>. <span className="tech">~</span> is your
            home in the Project's Environment. The folder is made when a worktree first goes there.
          </>
        ),
        keywords: 'folder directory path git',
        wide: true,
        Control: WorktreeRoot,
      },
    ],
  },
  {
    id: 'editor',
    title: 'Editor and terminal',
    icon: CodeXml,
    keywords: 'open in',
    settings: [
      {
        title: 'Editor command',
        description: (
          <>
            Run in the Session's Environment with your shell's full PATH. <span className="tech">{'{path}'}</span> is the folder or file to open; without it, the path goes last.
          </>
        ),
        wide: true,
        Control: EditorCommand,
      },
      {
        title: 'Terminal command',
        description: (
          <>
            Runs in the working copy's folder, which it also gets wherever you write <span className="tech">{'{path}'}</span>, as in <span className="tech">{'wt -d {path}'}</span> or{' '}
            <span className="tech">{'kitty --directory {path}'}</span>.
          </>
        ),
        wide: true,
        Control: TerminalCommand,
      },
    ],
  },
  {
    id: 'changes',
    title: 'Changes',
    icon: FileDiff,
    keywords: 'diff review',
    settings: [
      {
        title: 'Collapsed in the diff',
        description: (
          <>
            Files the Changes view starts collapsed, besides binaries and very large changes: one pattern a line, on a file name, or on its path when it has a{' '}
            <span className="tech">/</span>, as in <span className="tech">*.lock</span>.
          </>
        ),
        keywords: 'patterns files lockfiles generated',
        wide: true,
        Control: DiffCollapsedPatterns,
      },
    ],
  },
  {
    id: 'keybindings',
    title: 'Keybindings',
    icon: Keyboard,
    description:
      'Change an action’s shortcut, then press its new keys; Escape leaves it as it was. One with Ctrl runs even while you type, one without only outside text fields. A shortcut given to one action is taken from any other that had it. The keyboard shortcuts list, and the palette, show them as you have them.',
    keywords: 'keyboard shortcuts keys hotkeys remap',
    settings: [
      {
        title: 'Single-key shortcuts',
        description: `Loom’s own ${SINGLE_KEYS.join(', ')}, and any shortcut you give a key without Ctrl. Off, those keys run nothing.`,
        keywords: 'letters bare',
        Control: SingleKeyShortcuts,
      },
      ...REMAPPABLE_SHORTCUTS.map(
        (name): SettingEntry => ({
          title: SHORTCUTS[name].label,
          keywords: `shortcut ${shortcutLabel(SHORTCUTS[name].shortcut)}`,
          Control: ({ label }) => <KeybindingSetting label={label} name={name} />,
        }),
      ),
      { title: 'Reset all shortcuts', description: 'Back to Loom’s own shortcuts, the single-key ones on.', keywords: 'default', Control: ResetKeybindings },
    ],
  },
  {
    id: 'environments',
    title: 'Environments',
    icon: Server,
    keywords: `bridge agent ${OPENCODE_NAME} reload shell`,
    settings: [],
    Body: EnvironmentsTable,
  },
];

function EnvironmentRow({ env }: { env: EnvironmentStatus }) {
  const api = useApi();
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string>();
  const reload = () => {
    setReloading(true);
    setReloadError(undefined);
    api
      .invoke('environments.reload', { id: env.id })
      .catch((error: unknown) => setReloadError((error as Error).message))
      .finally(() => setReloading(false));
  };
  return (
    <tr>
      <td>{env.label}</td>
      <td>
        <EnvironmentState env={env} />
        {env.error && <div className="err"><ErrorText text={env.error} /></div>}
      </td>
      <td>
        {env.agent ? <AgentCell agent={env.agent} /> : <span className="muted">—</span>}
        <EnvironmentWarnings env={env} />
      </td>
      <td>{env.bridge ? <span className="tech">{`loom-bridge ${env.bridge.version}`}</span> : <span className="muted">—</span>}</td>
      <td>
        <button
          type="button"
          title="Re-read your shell environment, for tools installed since Loom started"
          disabled={reloading || env.state !== 'connected'}
          onClick={reload}
        >
          <span className={reloading ? 'spin' : undefined}>
            <RotateCw className="sm" />
          </span>
          Reload
        </button>
        {reloadError && <div className="err"><ErrorText text={reloadError} /></div>}
      </td>
    </tr>
  );
}

/**
 * The welcome's short check: each Environment, its state and its agent's,
 * and what to fix; the full table, with Reload, is in Settings.
 */
export function EnvironmentCheck() {
  const environments = useTopic('environments');
  if (!environments?.length) return <div className="muted">Starting your Environments…</div>;
  return (
    <ul className="environment-check" aria-label="Environments">
      {environments.map((env) => (
        <li key={env.id}>
          <div className="row">
            <b>{env.label}</b>
            <EnvironmentState env={env} />
            {env.agent && (
              <>
                <span className="muted">·</span>
                <AgentCell agent={env.agent} inline />
              </>
            )}
          </div>
          {env.error && <div className="err"><ErrorText text={env.error} /></div>}
          <EnvironmentWarnings env={env} />
        </li>
      ))}
    </ul>
  );
}

function EnvironmentState({ env }: { env: EnvironmentStatus }) {
  return (
    <span className={`row st-${env.state}`}>
      <StateIcon state={env.state} />
      <span>{env.state}</span>
    </span>
  );
}

/** What to fix in the Environment, its shell or its agent, before Sessions can run there. */
function EnvironmentWarnings({ env }: { env: EnvironmentStatus }) {
  const warnings = [shellWarning(env), env.agent && agentWarning(env.agent)].filter((w): w is string => !!w);
  return warnings.map((warning) => (
    <div key={warning} className="warn" role="alert">
      {warning}
    </div>
  ));
}

/** The agent's name, version and state: on two lines, or `inline` on one. */
function AgentCell({ agent, inline }: { agent: AgentStatus; inline?: boolean }) {
  const label = agent.checking ? 'checking' : agent.state;
  const Name = inline ? 'span' : 'div';
  return (
    <>
      <Name className="tech" title={agent.path}>
        {agent.version ? `${agent.name} ${agent.version}` : agent.name}
      </Name>
      <span className={`row ag-${agent.checking ? 'checking' : agent.state}`}>
        <AgentIcon agent={agent} />
        <span>{label}</span>
      </span>
    </>
  );
}

function AgentIcon({ agent }: { agent: AgentStatus }) {
  if (agent.checking) {
    return (
      <span className="spin">
        <LoaderCircle className="sm" />
      </span>
    );
  }
  switch (agent.state) {
    case 'ready':
      return <CircleCheckBig className="sm" />;
    case 'unknown':
      return null;
    case 'signed-out':
    case 'unsupported':
      return <TriangleAlert className="sm" />;
    case 'missing':
    case 'error':
      return <CircleX className="sm" />;
  }
}

/** What to fix before the agent can run Sessions, if anything. */
function agentWarning(agent: AgentStatus): string | undefined {
  const install = `Install OpenCode ${OPENCODE_MIN_VERSION} or later, then Reload.`;
  switch (agent.state) {
    case 'missing':
      return `OpenCode isn't installed in this Environment, or isn't on your shell's PATH. ${install}`;
    case 'unsupported':
      return agent.version?.startsWith('1.')
        ? `OpenCode ${agent.version} is V1 OpenCode (opencode-ai), which is not supported. ${install}`
        : `OpenCode ${agent.version} is too old. ${install}`;
    case 'signed-out':
      return "OpenCode isn't signed in to any model provider. Sign in from OpenCode; Loom checks again whenever Settings opens.";
    case 'error':
      return `Loom couldn't check OpenCode: ${agent.error}`;
    default:
      return undefined;
  }
}

/** Native Windows has no login shell, so only other Environments warn. */
function shellWarning(env: EnvironmentStatus): string | undefined {
  if (env.shellEnvironment !== 'bridge' || env.bridge?.os === 'windows') return undefined;
  return "Loom couldn't read your login shell's environment, so tools set up in your shell profile (mise, asdf, ~/.local/bin) may not be found.";
}

function StateIcon({ state }: { state: EnvironmentState }) {
  switch (state) {
    case 'connected':
      return <CircleCheckBig className="sm" />;
    case 'starting':
      return (
        <span className="spin">
          <LoaderCircle className="sm" />
        </span>
      );
    case 'unresponsive':
      return <TriangleAlert className="sm" />;
    case 'disconnected':
    case 'failed':
      return <CircleX className="sm" />;
  }
}
