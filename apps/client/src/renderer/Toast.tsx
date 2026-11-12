// The toast at the foot of the window: a word on what an action just did,
// with Undo for the ones that can be taken back (Archive, Mark unread), which
// Ctrl+Z runs too outside text fields. One at a time: a new one takes the
// place of the last.
import { Undo2, X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** How long a toast stays. */
export const TOAST_MS = 8000;

export interface ToastContent {
  message: string;
  /** Takes the action back; rejects with why it couldn't. */
  undo?: () => Promise<unknown>;
}

interface Toaster {
  /** Shows `toast`, in place of any showing. */
  show: (toast: ToastContent) => void;
  /** Runs the Undo of the toast showing, if it has one; false if there was none. */
  undo: () => boolean;
}

const ToastContext = createContext<Toaster>({ show: () => {}, undo: () => false });

/** Shows toasts; outside a ToastHost, they go nowhere. */
export function useToast(): Toaster {
  return useContext(ToastContext);
}

/** Holds the toast showing, at the foot of `children`. */
export function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastContent & { key: number }>();
  const next = useRef(0);
  const current = useRef(toast);
  current.current = toast;
  const show = (content: ToastContent) => setToast({ ...content, key: next.current++ });
  const close = () => setToast(undefined);
  const undo = () => {
    const shown = current.current;
    if (!shown?.undo) return false;
    // Taken once: a second Ctrl+Z or click doesn't run it again.
    current.current = undefined;
    setToast(undefined);
    shown.undo().catch((error: unknown) => show({ message: `Couldn’t undo: ${(error as Error).message}` }));
    return true;
  };
  const toaster = useRef<Toaster>({ show, undo });
  toaster.current.show = show;
  toaster.current.undo = undo;
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(close, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast?.key]);
  return (
    <ToastContext.Provider value={toaster.current}>
      {children}
      {/* Always there, so that screen readers hear what is put in it. */}
      <div className="toast-region" role="status" aria-label="Notifications" aria-live="polite">
        {toast && (
          <div key={toast.key} className="toast" role="group" aria-label="Notification">
            <span className="grow">{toast.message}</span>
            {toast.undo && (
              <button type="button" className="link" title="Undo (Ctrl Z)" onClick={undo}>
                <Undo2 className="sm" />
                Undo
              </button>
            )}
            <button type="button" className="icon-btn sm" title="Dismiss" aria-label="Dismiss" onClick={close}>
              <X className="sm" />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
