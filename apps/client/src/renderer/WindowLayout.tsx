// How the window is shared out between the Inbox, the conversation and the
// Side area, as it is now (see shared/window.ts), and the Inbox's own width
// and whether it is shown, kept in settings.
import { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_INBOX, type InboxSettings, type WindowLayout } from '../shared/window';
import { useApi, useTopic } from './api';

/** The window's size, as it changes. */
export function useWindowSize(): { width: number; height: number } {
  const current = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [size, setSize] = useState(current);
  useEffect(() => {
    const onResize = () => setSize(current());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/** The Inbox as settings have it, or as the user is dragging it to, and what changes it. */
export interface InboxControl {
  /** Its width and whether it is shown. */
  value: InboxSettings;
  /** Sets its width while dragging; `done` keeps it in settings. */
  resize(width: number, done: boolean): void;
  /** Shows it, or collapses it to a rail. */
  toggle(): void;
}

/** The Inbox: settings', or what the user changed it to until settings hold the same. */
export function useInbox(): InboxControl {
  const api = useApi();
  const stored = useTopic('settings')?.inbox;
  const [local, setLocal] = useState<InboxSettings>();
  useEffect(() => {
    if (stored) setLocal((pending) => (pending && pending.width === stored.width && pending.open === stored.open ? undefined : pending));
  }, [stored]);
  const value = local ?? stored ?? DEFAULT_INBOX;
  const keep = (next: InboxSettings, change: Partial<InboxSettings>) => {
    setLocal(next);
    api.invoke('settings.setInbox', change).catch((e: unknown) => {
      console.error('could not keep the Inbox:', e);
      setLocal((pending) => (pending === next ? undefined : pending));
    });
  };
  return {
    value,
    resize: (width, done) => {
      const next = { ...value, width };
      if (done) keep(next, { width });
      else setLocal(next);
    },
    toggle: () => keep({ ...value, open: !value.open }, { open: !value.open }),
  };
}

/** How the window is shared out now, and its height, which bounds the Dock. */
export interface WindowPanes extends WindowLayout {
  height: number;
}

const WindowLayoutContext = createContext<WindowPanes | undefined>(undefined);

/** Gives the window's layout to the panes within. */
export const WindowLayoutProvider = WindowLayoutContext.Provider;

/** How the window is shared out now, as the App works it out. */
export function useWindowLayout(): WindowPanes {
  const layout = useContext(WindowLayoutContext);
  if (!layout) throw new Error('useWindowLayout needs a WindowLayoutProvider: the App gives one.');
  return layout;
}
