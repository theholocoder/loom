// The toast at the foot of the window: a word on what an action just did,
// with Undo for the ones that can be taken back (Archive, Mark unread), which
// its shortcut (Ctrl+Z, unless remapped) runs too outside text fields, or why
// an action failed, in view wherever the action was. One at a time: a new
// one takes the place of the last, but an Undo it hides is kept: undoing the
// one showing brings back the one before, to undo in turn, until the toast
// closes or one without Undo comes between.
import { OctagonX, Undo2, X } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ErrorText } from './ErrorText';
import { shortcutLabel, useBindings } from './shortcuts';

/** How long a toast stays, unless it says why an action failed. */
export const TOAST_MS = 8000;

export interface ToastContent {
  message: string;
  /** Takes the action back; rejects with why it couldn't. */
  undo?: () => Promise<unknown>;
  /** The message is why an action failed, rather than what it did: it stays until dismissed or replaced, so as not to be missed. */
  failed?: boolean;
}

interface Toaster {
  /** Shows `toast`, in place of any showing. */
  show: (toast: ToastContent) => void;
  /** Runs the Undo of the toast showing, if it has one, and shows the one before with an Undo still to take; false if there was none. */
  undo: () => boolean;
}

const ToastContext = createContext<Toaster>({ show: () => {}, undo: () => false });

/** Shows toasts; outside a ToastHost, they go nowhere. */
export function useToast(): Toaster {
  return useContext(ToastContext);
}

/** Holds the toast showing, at the foot of `children`. */
export function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastContent & { key: number; returnFocus: HTMLElement | null }>();
  /** Whether the pointer or the focus is on it, which keeps it there. */
  const [held, setHeld] = useState({ pointer: false, focus: false });
  const element = useRef<HTMLDivElement>(null);
  const shown = useRef(toast);
  shown.current = toast;
  const next = useRef(0);
  /** The toasts with an Undo not yet taken, the latest last: the one showing, if it has one, and those it took the place of. */
  const undoable = useRef<ToastContent[]>([]);
  const toaster = useMemo<Toaster & { close: () => void }>(() => {
    const display = (content: ToastContent) => {
      const focused = document.activeElement instanceof HTMLElement && !element.current?.contains(document.activeElement) ? document.activeElement : (shown.current?.returnFocus ?? null);
      setHeld({ pointer: false, focus: false });
      const toast = { ...content, key: next.current++, returnFocus: focused };
      shown.current = toast;
      setToast(toast);
    };
    const show = (content: ToastContent) => {
      // One without Undo says something else happened since: what came before can't be reached from it.
      if (content.undo) undoable.current.push(content);
      else undoable.current = [];
      display(content);
    };
    const hide = () => {
      // Closing under the focus, it goes back where it was, rather than to the page, where keys would run shortcuts.
      if (element.current?.contains(document.activeElement) && shown.current?.returnFocus?.isConnected) shown.current.returnFocus.focus();
      shown.current = undefined;
      setToast(undefined);
    };
    /** Closed, by the user or after a while: the Undos it kept go with it. */
    const close = () => {
      undoable.current = [];
      hide();
    };
    const undo = () => {
      const taken = shown.current;
      if (!taken?.undo) return false;
      // Taken once: a second Ctrl+Z or click doesn't run it again.
      undoable.current = undoable.current.filter((content) => content.undo !== taken.undo);
      const before = undoable.current.at(-1);
      if (before) display(before);
      else hide();
      // What came before may hang on what couldn't be undone: it goes too.
      taken.undo().catch((error: unknown) => show({ message: `Couldn’t undo: ${(error as Error).message}` }));
      return true;
    };
    return { show, undo, close };
  }, []);
  const holding = held.pointer || held.focus;
  const undoBinding = useBindings().undo;
  const undoKeys = undoBinding && shortcutLabel(undoBinding);
  useEffect(() => {
    if (!toast || holding || toast.failed) return;
    const timer = setTimeout(toaster.close, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast?.key, holding]);
  return (
    <ToastContext.Provider value={toaster}>
      {children}
      {/* Always there, so that screen readers hear what is put in it. */}
      <div ref={element} className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div
            key={toast.key}
            className={toast.failed ? 'toast failed' : 'toast'}
            role="group"
            aria-label={toast.failed ? 'What went wrong' : 'What was done'}
            onMouseEnter={() => setHeld((h) => ({ ...h, pointer: true }))}
            onMouseLeave={() => setHeld((h) => ({ ...h, pointer: false }))}
            onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
            onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setHeld((h) => ({ ...h, focus: false }))}
          >
            {toast.failed && <OctagonX className="sm" />}
            <div className="grow" role={toast.failed ? 'alert' : undefined}>
              <ErrorText text={toast.message} />
            </div>
            {toast.undo && (
              <button type="button" className="link" title={undoKeys ? `Undo (${undoKeys})` : 'Undo'} onClick={toaster.undo}>
                <Undo2 className="sm" />
                Undo
              </button>
            )}
            <button type="button" className="icon-btn sm" title="Dismiss" aria-label="Dismiss" onClick={toaster.close}>
              <X className="sm" />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
