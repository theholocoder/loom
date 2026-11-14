// What an open Session's Panels share with its conversation, and with each
// other (ADR 0009): the comments going with the next message, the review
// notes, a way to the turn a Panel speaks of, and putting a Highlight to the
// agent. A Panel is asked to show something through `request`, which it
// takes up with `usePanelRequest` once it shows; what a Panel keeps while it
// isn't drawn (another tab shown, its area hidden) it keeps with
// `usePanelState`, the Session's for as long as it stays open.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Highlight } from '../shared/api';
import type { PanelId } from '../shared/panels';
import type { DiffComments } from './Changes';
import type { ReviewNotes } from './ReviewNotes';

/** What each Panel can be asked to show: Changes a file, by its path; the Merge request its link form or its reviews. */
export interface PanelRequests {
  changes: string;
  'merge-request': 'link' | 'reviews';
}

/** What a Panel keeps while it isn't drawn, by name. */
export type PanelState = Readonly<Record<string, unknown>>;

/** What `SessionView` gives its Panels: see the file's head. */
export interface SessionPanelShared {
  /** The comments on a diff to go with the next message. */
  diffComments: DiffComments;
  reviewNotes?: ReviewNotes;
  /** Scrolls the conversation to the turn transcript item `itemId` is in. */
  showTurn(itemId: number): void;
  /** Puts `highlight` to the agent, as a comment in the composer; absent while the composer takes none. */
  askAboutHighlight?: (highlight: Highlight) => void;
}

/** The open Session's Panel context: see the file's head. */
export interface SessionPanelContextValue extends SessionPanelShared {
  request<P extends keyof PanelRequests>(panel: P, what: PanelRequests[P]): void;
  /** The last request made of each Panel; `n` tells one from the next. */
  requests: Partial<Record<PanelId, { what: unknown; n: number }>>;
  /** Marks request `n` of `panel` taken up, saying whether it was already. */
  take(panel: PanelId, n: number): boolean;
  stateOf(panel: PanelId): PanelState;
  setState(panel: PanelId, key: string, value: unknown): void;
}

const SessionPanelContext = createContext<SessionPanelContextValue | undefined>(undefined);

const NO_STATE: PanelState = {};

/** The open Session's Panel context, giving its Panels `shared` and keeping their requests and state, for `SessionPanelProvider`. */
export function useSessionPanelContext(shared: SessionPanelShared): SessionPanelContextValue {
  const [requests, setRequests] = useState<SessionPanelContextValue['requests']>({});
  const taken = useRef(new Map<PanelId, number>());
  const [states, setStates] = useState<Partial<Record<PanelId, PanelState>>>({});
  const request = useCallback((panel: PanelId, what: unknown) => setRequests((all) => ({ ...all, [panel]: { what, n: (all[panel]?.n ?? 0) + 1 } })), []);
  const take = useCallback((panel: PanelId, n: number) => {
    if (taken.current.get(panel) === n) return true;
    taken.current.set(panel, n);
    return false;
  }, []);
  const stateOf = useCallback((panel: PanelId) => states[panel] ?? NO_STATE, [states]);
  const setState = useCallback((panel: PanelId, key: string, value: unknown) => setStates((all) => ({ ...all, [panel]: { ...all[panel], [key]: value } })), []);
  return { ...shared, request, requests, take, stateOf, setState };
}

/** Gives the Panels under it the Session's Panel context. */
export function SessionPanelProvider({ value, children }: { value: SessionPanelContextValue; children: ReactNode }) {
  return <SessionPanelContext.Provider value={value}>{children}</SessionPanelContext.Provider>;
}

/** What the open Session gives its Panels, and asking a Panel to show something. */
export function useSessionPanels(): SessionPanelContextValue {
  const value = useContext(SessionPanelContext);
  if (!value) throw new Error('useSessionPanels needs a SessionPanelProvider');
  return value;
}

/** Runs `handler` on each request made of `panel`: once each, as it comes or, made while the Panel wasn't drawn, once it is. */
export function usePanelRequest<P extends keyof PanelRequests>(panel: P, handler: (what: PanelRequests[P]) => void) {
  const { requests, take } = useSessionPanels();
  const asked = requests[panel];
  const handling = useRef(handler);
  handling.current = handler;
  useEffect(() => {
    if (asked && !take(panel, asked.n)) handling.current(asked.what as PanelRequests[P]);
  }, [asked]);
}

/** A value `panel` keeps while it isn't drawn, `initial` until it is set. */
export function usePanelState<T>(panel: PanelId, key: string, initial: T): [T, (value: T) => void] {
  const { stateOf, setState } = useSessionPanels();
  const value = key in stateOf(panel) ? (stateOf(panel)[key] as T) : initial;
  return [value, useCallback((next: T) => setState(panel, key, next), [setState, panel, key])];
}
