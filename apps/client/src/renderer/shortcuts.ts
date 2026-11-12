// Every keyboard shortcut, in one place: the palette shows them next to their
// actions, the window's key handler runs them, and Ctrl+? lists them all,
// the composer's own Enter and Shift+Enter too. (Reloading and the developer
// tools in development are the main process's: see main/window-menu.ts.)

/**
 * A key and the modifiers held with it. A Ctrl shortcut (Cmd works too) runs
 * anywhere, even in a text field, but in a terminal only if it says so; one
 * without Ctrl only outside them, and not just after typing (see
 * `typingGuard`).
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
function isSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

export function matchesShortcut(shortcut: Shortcut, event: KeyboardEvent): boolean {
  if (event.altKey || !!shortcut.ctrl !== (event.ctrlKey || event.metaKey)) return false;
  // Shift is part of typing a symbol, wherever the layout puts it.
  if (!isSymbol(shortcut.key) && !!shortcut.shift !== event.shiftKey) return false;
  return shortcut.code ? event.code === shortcut.code : event.key.toLowerCase() === shortcut.key;
}

/** How a shortcut reads in a `<kbd>`: `Ctrl Shift N`, `J`, `Ctrl Shift Enter`, `Ctrl ?`. */
export function shortcutLabel({ key, ctrl, shift }: Shortcut): string {
  const name = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  return [ctrl && 'Ctrl', shift && !isSymbol(key) && 'Shift', name].filter(Boolean).join(' ');
}

export interface ShortcutEntry {
  /** What it does: the palette's name for it too, unless it says it more precisely. */
  label: string;
  shortcut: Shortcut;
  /** How the list shows it, when that isn't shortcutLabel's. */
  display?: string;
  /** Typed in the prompt box, which handles it itself: no window shortcut, only listed. */
  composer?: boolean;
  /** A Ctrl shortcut that a terminal with the focus lets through to the window, rather than to its shell. */
  inTerminal?: boolean;
  /** A Ctrl shortcut that runs only outside text fields, where the key has a meaning of its own. */
  outsideTextFields?: boolean;
}

/** The shortcuts, in the order Ctrl+? lists them. */
export const SHORTCUTS = {
  palette: { label: 'Open the command palette', shortcut: { key: 'k', ctrl: true }, inTerminal: true },
  help: { label: 'Show keyboard shortcuts', shortcut: { key: '?', ctrl: true }, inTerminal: true },
  newSession: { label: 'New Session', shortcut: { key: 'n', ctrl: true } },
  newSessionFromIssue: { label: 'New Session from an issue…', shortcut: { key: 'n', ctrl: true, shift: true } },
  addProject: { label: 'Add a Project…', shortcut: { key: 'o', ctrl: true } },
  nextWaiting: { label: 'Go to next Waiting Session', shortcut: { key: 'j' } },
  previousWaiting: { label: 'Go to previous Waiting Session', shortcut: { key: 'k' } },
  // The App reads the digit itself: Ctrl+1 to Ctrl+9, by physical key (AZERTY's 1 types &).
  inboxPosition: { label: 'Open the nth Waiting Session in the Inbox', shortcut: { key: '1', ctrl: true, code: 'Digit1' }, display: 'Ctrl 1…9' },
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
  send: { label: 'Send the message', shortcut: { key: 'enter' }, composer: true },
  newline: { label: 'Add a line to the message', shortcut: { key: 'enter', shift: true }, composer: true },
} satisfies Record<string, ShortcutEntry>;

export type ShortcutName = keyof typeof SHORTCUTS;

/** Whether a terminal with the focus hands `event` to the window, as one of the shortcuts that work there. */
export function isTerminalShortcut(event: KeyboardEvent): boolean {
  return Object.values(SHORTCUTS as Record<string, ShortcutEntry>).some((entry) => entry.inTerminal && matchesShortcut(entry.shortcut, event));
}

/** How long after the last key typed in a text field the keys without Ctrl still count as typing. */
export const TYPING_PAUSE_MS = 1000;

/**
 * Keeps the shortcuts without Ctrl from running on keys meant as text: when
 * the focus drops out of a text field mid-word (the field disabled, a dialog
 * closing), what is typed next is still typing. Each key typed in a text
 * field, and each such key it holds back, starts the pause again; a
 * deliberate move away, Escape or a click, ends it.
 */
export function typingGuard(now: () => number = Date.now) {
  let typedAt: number | undefined;
  return {
    /** A key went to a text field: a character typed, or Escape leaving it. */
    typed(event: KeyboardEvent): void {
      if (event.key === 'Escape') typedAt = undefined;
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) typedAt = now();
    },
    /** The user moved on deliberately: a click. */
    reset(): void {
      typedAt = undefined;
    },
    /** Whether a shortcut without Ctrl is held back, still part of the typing; holding it back keeps the typing going. */
    holds(): boolean {
      if (typedAt === undefined || now() - typedAt >= TYPING_PAUSE_MS) return false;
      typedAt = now();
      return true;
    },
  };
}
