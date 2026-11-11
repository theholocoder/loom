// How the window is shared out between the Inbox, the conversation and the
// Side area, as it is now (see shared/window.ts), and the Inbox's own width
// and whether it is shown, kept in settings.
import { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_INBOX, windowLayout, type InboxSettings, type WindowLayout } from '../shared/window';
import { useApi, useTopic } from './api';

/** The window's width, as it changes. */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** The Inbox as settings have it, or as the user is dragging it to, and what changes it. */
export interface InboxControl {
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

const WindowLayoutContext = createContext<WindowLayout | undefined>(undefined);

/** Gives the window's layout to the panes within. */
export const WindowLayoutProvider = WindowLayoutContext.Provider;

/** How the window is shared out now: the App's, or, outside it, a window this wide with the Inbox as it starts. */
export function useWindowLayout(): WindowLayout {
  return useContext(WindowLayoutContext) ?? windowLayout(window.innerWidth, DEFAULT_INBOX);
}
