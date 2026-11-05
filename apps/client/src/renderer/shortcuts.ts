// Every keyboard shortcut, in one place: the palette shows them next to their
// actions, the window's key handler runs them, and Ctrl+? lists them all.

/**
 * A key and the modifiers held with it. A Ctrl shortcut (Cmd works too) runs
 * anywhere, even in a text field; one without Ctrl only outside one.
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
  /** What it does, in general: the palette may say it more precisely. */
  label: string;
  shortcut: Shortcut;
  /** How the list shows it, when that isn't shortcutLabel's. */
  display?: string;
}

/** The shortcuts, in the order Ctrl+? lists them. */
export const SHORTCUTS = {
  palette: { label: 'Open the command palette', shortcut: { key: 'k', ctrl: true } },
  help: { label: 'Show keyboard shortcuts', shortcut: { key: '?', ctrl: true } },
  newSession: { label: 'New Session', shortcut: { key: 'n', ctrl: true } },
  newSessionFromIssue: { label: 'New Session from an issue', shortcut: { key: 'n', ctrl: true, shift: true } },
  addExistingClone: { label: 'Add Project from existing clone', shortcut: { key: 'o', ctrl: true } },
  nextWaiting: { label: 'Go to next Waiting Session', shortcut: { key: 'j' } },
  previousWaiting: { label: 'Go to previous Waiting Session', shortcut: { key: 'k' } },
  // The App reads the digit itself: Ctrl+1 to Ctrl+9, by physical key (AZERTY's 1 types &).
  inboxPosition: { label: 'Open the nth Waiting Session in the Inbox', shortcut: { key: '1', ctrl: true, code: 'Digit1' }, display: 'Ctrl 1…9' },
  reply: { label: 'Reply to the open Session', shortcut: { key: 'r' } },
  retry: { label: 'Retry the last prompt', shortcut: { key: 'enter', ctrl: true, shift: true } },
  mergeRequest: { label: 'Create or open the Merge request', shortcut: { key: 'm', ctrl: true, shift: true } },
  openInEditor: { label: 'Open in editor', shortcut: { key: 'e', ctrl: true, shift: true } },
  openInTerminal: { label: 'Open in terminal', shortcut: { key: '`', ctrl: true, code: 'Backquote' } },
  toggleDiff: { label: 'Toggle changes panel', shortcut: { key: 'd' } },
  markUnread: { label: 'Mark the open Session unread', shortcut: { key: 'u' } },
  archive: { label: 'Archive the open Session', shortcut: { key: 'e' } },
  settings: { label: 'Open Settings', shortcut: { key: ',', ctrl: true } },
} satisfies Record<string, ShortcutEntry>;

export type ShortcutName = keyof typeof SHORTCUTS;
