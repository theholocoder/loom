// Running the keyboard shortcuts: matching a key to the user's Keybindings,
// and holding back the ones without Ctrl while the user is typing. What the
// shortcuts are, and how the user remaps them, is shared/shortcuts.ts.
import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import { bindingsOf, DEFAULT_KEYBINDINGS, isSymbol, SHORTCUTS, type Bindings, type Shortcut, type ShortcutEntry } from '../shared/shortcuts';
import { useTopic } from './api';

export { SHORTCUTS, shortcutLabel, type Bindings, type Shortcut, type ShortcutEntry, type ShortcutName } from '../shared/shortcuts';

/** Whether `event` is `shortcut`'s keys; never for none. */
export function matchesShortcut(shortcut: Shortcut | undefined, event: KeyboardEvent): boolean {
  if (!shortcut || event.altKey || !!shortcut.ctrl !== (event.ctrlKey || event.metaKey)) return false;
  // Shift is part of typing a symbol, wherever the layout puts it.
  if (!isSymbol(shortcut.key) && !!shortcut.shift !== event.shiftKey) return false;
  return shortcut.code ? event.code === shortcut.code : event.key.toLowerCase() === shortcut.key;
}

/** Loom's own shortcuts, for a view with no BindingsProvider above it. */
const DEFAULT_BINDINGS = bindingsOf(DEFAULT_KEYBINDINGS);
/** The user's shortcuts, as BindingsProvider gives them. */
const BindingsContext = createContext<Bindings>(DEFAULT_BINDINGS);

/** Gives the window the user's shortcuts, from the settings: one subscription for every view that shows or runs them. */
export function BindingsProvider({ children }: { children: ReactNode }) {
  const keybindings = useTopic('settings')?.keybindings ?? DEFAULT_KEYBINDINGS;
  const bindings = useMemo(() => bindingsOf(keybindings), [keybindings]);
  return createElement(BindingsContext.Provider, { value: bindings }, children);
}

/** Each action's shortcut, as the user has them: Loom's own until the settings come. */
export function useBindings(): Bindings {
  return useContext(BindingsContext);
}

/**
 * Whether a terminal with the focus hands `event` to the window, as one of
 * the shortcuts that work there: only a Ctrl one, as the shell takes the
 * keys it types.
 */
export function isTerminalShortcut(event: KeyboardEvent, bindings: Bindings): boolean {
  return (Object.keys(SHORTCUTS) as (keyof Bindings)[]).some((name) => {
    const shortcut = bindings[name];
    return (SHORTCUTS[name] as ShortcutEntry).inTerminal && !!shortcut?.ctrl && matchesShortcut(shortcut, event);
  });
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
