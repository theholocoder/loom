// Every keyboard shortcut, in one place, and the user's Keybindings over
// them: the palette shows them next to their actions, the window's key
// handler runs them, Ctrl+? lists them all, the composer's own Enter and
// Shift+Enter too, and Settings remaps them. Main keeps the Keybindings and
// refuses one that can't be run; the renderer matches keys (see
// renderer/shortcuts.ts). (Reloading and the developer tools in development
// are the main process's: see main/window-menu.ts.)

/**
 * A key and the modifiers held with it. A Ctrl shortcut (Cmd works too) runs
 * anywhere, even in a text field, but in a terminal only if it says so; one
 * without Ctrl only outside them, and not just after typing.
 */
export interface Shortcut {
  /** `KeyboardEvent.key`, lower-cased: `n`, `enter`, `?`. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  /**
   * Matched against `KeyboardEvent.code` instead, for keys that type
   * different characters on other layouts: Ctrl+` is Ctrl+² on AZERTY.
   */
  code?: string;
}

/** A key that is a punctuation character, which the layout may need Shift for (`?`). */
export function isSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

/** Names for keys whose `KeyboardEvent.key` doesn't read well. */
const KEY_NAMES: Record<string, string> = { arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', pageup: 'PageUp', pagedown: 'PageDown', ' ': 'Space' };

/** How a shortcut reads in a `<kbd>`: `Ctrl Shift N`, `J`, `Ctrl Shift Enter`, `Ctrl ?`. */
export function shortcutLabel({ key, ctrl, shift }: Shortcut): string {
  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  return [ctrl && 'Ctrl', shift && !isSymbol(key) && 'Shift', name].filter(Boolean).join(' ');
}

/** Whether two shortcuts take the same keys: Shift counts for no symbol, as typing one may need it. */
export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return a.key === b.key && !!a.ctrl === !!b.ctrl && (isSymbol(a.key) || !!a.shift === !!b.shift);
}

export interface ShortcutEntry {
  /** What it does: the palette's name for it too, unless it says it more precisely. */
  label: string;
  /** Loom's own shortcut for it, until the user remaps it. */
  shortcut: Shortcut;
  /** How the list shows it, when that isn't shortcutLabel's. */
  display?: string;
  /** Typed in the prompt box, which handles it itself: no window shortcut, only listed. */
  composer?: boolean;
  /** A Ctrl shortcut that a terminal with the focus lets through to the window, rather than to its shell. */
  inTerminal?: boolean;
  /** A Ctrl shortcut that runs only outside text fields, where the key has a meaning of its own. */
  outsideTextFields?: boolean;
  /** Kept as it is: Settings can't remap it. */
  fixed?: boolean;
}

/** The shortcuts, in the order Ctrl+? and Settings list them. */
export const SHORTCUTS = {
  palette: { label: 'Open the command palette', shortcut: { key: 'k', ctrl: true }, inTerminal: true },
  help: { label: 'Show keyboard shortcuts', shortcut: { key: '?', ctrl: true }, inTerminal: true },
  newSession: { label: 'New Session', shortcut: { key: 'n', ctrl: true } },
  newSessionFromIssue: { label: 'New Session from an issue…', shortcut: { key: 'n', ctrl: true, shift: true } },
  addProject: { label: 'Add a Project…', shortcut: { key: 'o', ctrl: true } },
  nextWaiting: { label: 'Go to next Waiting Session', shortcut: { key: 'j' } },
  previousWaiting: { label: 'Go to previous Waiting Session', shortcut: { key: 'k' } },
  // The App reads the digit itself: Ctrl+1 to Ctrl+9, by physical key (AZERTY's 1 types &).
  inboxPosition: { label: 'Open the nth Waiting Session in the Inbox', shortcut: { key: '1', ctrl: true, code: 'Digit1' }, display: 'Ctrl 1…9', fixed: true },
  reply: { label: 'Reply to this Session', shortcut: { key: 'r' } },
  retry: { label: 'Retry the last prompt', shortcut: { key: 'enter', ctrl: true, shift: true } },
  mergeRequest: { label: 'Show or create the Merge request', shortcut: { key: 'm', ctrl: true, shift: true } },
  openInEditor: { label: 'Open in editor', shortcut: { key: 'e', ctrl: true, shift: true } },
  toggleTerminal: { label: 'Toggle terminal', shortcut: { key: '`', ctrl: true, code: 'Backquote' }, inTerminal: true },
  toggleInbox: { label: 'Toggle the Inbox', shortcut: { key: 'b', ctrl: true, shift: true } },
  toggleSideArea: { label: 'Toggle the Side area', shortcut: { key: 'b', ctrl: true } },
  toggleDiff: { label: 'Toggle diff', shortcut: { key: 'd' } },
  reviewChanges: { label: 'Toggle Review mode for Changes', shortcut: { key: 'd', ctrl: true, shift: true } },
  sessionDetails: { label: 'Show Session details', shortcut: { key: 'i', ctrl: true } },
  markUnread: { label: 'Mark this Session unread', shortcut: { key: 'u' } },
  archive: { label: 'Archive this Session', shortcut: { key: 'e' } },
  // A text field's Ctrl+Z is its own undo.
  undo: { label: 'Undo the last action', shortcut: { key: 'z', ctrl: true }, outsideTextFields: true },
  settings: { label: 'Open Settings', shortcut: { key: ',', ctrl: true } },
  send: { label: 'Send the message', shortcut: { key: 'enter' }, composer: true, fixed: true },
  newline: { label: 'Add a line to the message', shortcut: { key: 'enter', shift: true }, composer: true, fixed: true },
} satisfies Record<string, ShortcutEntry>;

export type ShortcutName = keyof typeof SHORTCUTS;

/** The catalog, each entry read as a ShortcutEntry, whatever fields its own literal has. */
const ENTRIES = SHORTCUTS as Record<ShortcutName, ShortcutEntry>;
/** Every action with a shortcut, in the catalog's order. */
const NAMES = Object.keys(SHORTCUTS) as ShortcutName[];

/** The shortcuts Settings remaps, in the order it lists them: all but the composer's and Ctrl 1…9. */
export const REMAPPABLE_SHORTCUTS = NAMES.filter((name) => !ENTRIES[name].fixed);

/** Whether `value` names an action whose shortcut Settings can remap. */
export function isRemappable(value: unknown): value is ShortcutName {
  return typeof value === 'string' && (REMAPPABLE_SHORTCUTS as string[]).includes(value);
}

/** The user's changes to the shortcuts, kept in settings. */
export interface KeybindingSettings {
  /** Each shortcut the user remapped, by its action: null for one taken off it. Those not here are Loom's own. */
  remapped: Partial<Record<ShortcutName, Shortcut | null>>;
  /** Whether the shortcuts without Ctrl (`j k r d u e` until remapped) run; off, they don't. */
  singleKeys: boolean;
}

/** Loom's own shortcuts, the single-key ones on: the Keybindings until the user changes them. */
export const DEFAULT_KEYBINDINGS: KeybindingSettings = { remapped: {}, singleKeys: true };

/** Whether the user's Keybindings are still Loom's own. */
export function isDefaultKeybindings(keybindings: KeybindingSettings): boolean {
  return keybindings.singleKeys === DEFAULT_KEYBINDINGS.singleKeys && Object.keys(keybindings.remapped).length === 0;
}

/** Each action's shortcut as the user has it: undefined for none, or for one without Ctrl while those are off. */
export type Bindings = Record<ShortcutName, Shortcut | undefined>;

/** Each action's shortcut, as the user remapped it, whether or not the single-key ones are on: what Settings shows. */
export function assignedBindings({ remapped }: KeybindingSettings): Bindings {
  return Object.fromEntries(NAMES.map((name) => [name, name in remapped ? (remapped[name] ?? undefined) : ENTRIES[name].shortcut])) as Bindings;
}

/** Each action's shortcut, as the user has them. */
export function bindingsOf(keybindings: KeybindingSettings): Bindings {
  const bindings = assignedBindings(keybindings);
  if (!keybindings.singleKeys) for (const name of NAMES) if (!bindings[name]?.ctrl && !ENTRIES[name].composer) bindings[name] = undefined;
  return bindings;
}

/** Keys that are no key of their own, only held with one, which a shortcut being pressed waits past. */
export const MODIFIER_KEYS: ReadonlySet<string> = new Set(['control', 'shift', 'alt', 'altgraph', 'meta', 'os', 'super', 'hyper', 'fn', 'capslock', 'numlock', 'scrolllock', 'dead', 'unidentified', 'process', 'compose']);
/** Ctrl shortcuts that a text field keeps for itself: select all, copy, cut, paste, undo and redo. */
const TEXT_FIELD_KEYS = new Set(['a', 'c', 'v', 'x', 'y', 'z']);
/** Keys that, with Ctrl (and Shift to select), move or delete a word at a time in a text field. */
const TEXT_EDITING_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'backspace', 'delete', 'home', 'end']);
/** Ctrl Shift keys a terminal keeps for copying and pasting. */
const TERMINAL_KEYS = new Set(['c', 'v']);

/** Rejects, saying why, a shortcut Loom can't run for `name`; one it can, cleaned up. */
export function checkShortcut(name: ShortcutName, shortcut: unknown): Shortcut {
  if (typeof shortcut !== 'object' || shortcut === null) throw new Error(`${JSON.stringify(shortcut)} is not a key and its modifiers.`);
  const { key, ctrl, shift, code } = shortcut as Record<string, unknown>;
  if (typeof key !== 'string' || !key || key !== key.toLowerCase()) throw new Error(`${JSON.stringify(key)} is not a key, lower-cased.`);
  if ((ctrl !== undefined && typeof ctrl !== 'boolean') || (shift !== undefined && typeof shift !== 'boolean')) throw new Error('Whether Ctrl or Shift is held must be true or false.');
  if (code !== undefined && typeof code !== 'string') throw new Error("A key's place must be text.");
  if (MODIFIER_KEYS.has(key)) throw new Error('A shortcut needs a key besides Ctrl, Shift, Alt or Cmd.');
  if (key === 'escape') throw new Error('Escape closes what is open: it is no shortcut.');
  if (key === 'tab') throw new Error('Tab moves the focus: it is no shortcut.');
  if (!ctrl && !(key.length === 1 && key !== ' ') && !/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    throw new Error(`Without Ctrl, a shortcut is one character or a function key: ${shortcutLabel({ key, shift: !!shift })} would get in the way of typing and of the buttons.`);
  }
  if (ctrl && !shift && (/^[1-9]$/.test(key) || /^Digit[1-9]$/.test(code ?? ''))) throw new Error('Ctrl 1…9 open the Waiting Sessions in the Inbox.');
  if (ctrl && !shift && TEXT_FIELD_KEYS.has(key) && !(name === 'undo' && key === 'z')) throw new Error(`Text fields keep ${shortcutLabel({ key, ctrl: true })} for themselves.`);
  if (ctrl && TEXT_EDITING_KEYS.has(key)) throw new Error(`Text fields keep ${shortcutLabel({ key, ctrl: true, shift: !!shift })} for moving and deleting by the word.`);
  if (ctrl && shift && TERMINAL_KEYS.has(key)) throw new Error(`Terminals keep ${shortcutLabel({ key, ctrl: true, shift: true })} for copying and pasting.`);
  return { key, ...(ctrl ? { ctrl: true } : {}), ...(shift && !isSymbol(key) ? { shift: true } : {}), ...(code ? { code } : {}) };
}

/**
 * The Keybindings with `name`'s shortcut set: to `shortcut`, to none for
 * null, or back to Loom's own for 'default'. A shortcut set is taken from any
 * other action that had it, which is left with none. Rejects an action
 * Settings can't remap, or a shortcut Loom can't run.
 */
export function remap(keybindings: KeybindingSettings, name: ShortcutName, shortcut: Shortcut | null | 'default'): KeybindingSettings {
  if (!isRemappable(name)) throw new Error(`"${String(name)}" is not a shortcut Settings can remap.`);
  const remapped = { ...keybindings.remapped };
  const own = ENTRIES[name].shortcut;
  const next = shortcut === 'default' ? own : shortcut === null ? null : checkShortcut(name, shortcut);
  if (next && sameShortcut(next, own)) delete remapped[name];
  else remapped[name] = next;
  if (next) for (const other of takenBy(keybindings, name, next)) remapped[other] = null;
  return { ...keybindings, remapped };
}

/** The actions whose shortcut setting `name`'s to `shortcut` would take. */
export function takenBy(keybindings: KeybindingSettings, name: ShortcutName, shortcut: Shortcut): ShortcutName[] {
  const bindings = assignedBindings(keybindings);
  return REMAPPABLE_SHORTCUTS.filter((other) => other !== name && !!bindings[other] && sameShortcut(bindings[other], shortcut));
}

/** Keybindings as stored: what Loom no longer takes is dropped, and the single-key shortcuts are on unless turned off. */
export function readKeybindings(stored: unknown): KeybindingSettings {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_KEYBINDINGS;
  const { remapped, singleKeys } = stored as Record<string, unknown>;
  const kept: KeybindingSettings['remapped'] = {};
  if (typeof remapped === 'object' && remapped !== null) {
    for (const [name, shortcut] of Object.entries(remapped)) {
      if (!isRemappable(name)) continue;
      if (shortcut === null) kept[name] = null;
      else {
        try {
          kept[name] = checkShortcut(name, shortcut);
        } catch {
          // One Loom can no longer run: back to its own.
        }
      }
    }
  }
  return { remapped: kept, singleKeys: typeof singleKeys === 'boolean' ? singleKeys : true };
}
