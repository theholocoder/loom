// What was typed for a message and not sent yet, kept for as long as Loom
// runs: one draft per Session and one for New Session, so that going to
// another Session, or to a Page and from there to a Session, loses none of
// it. A draft lives in the renderer only, gone with the window.
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';

/** The drafts kept, by whose they are (`session:7`, `new-session`), each in parts: its text, its files… */
type Drafts = Map<string, Map<string, unknown>>;

const DraftsContext = createContext<Drafts | undefined>(undefined);

/** Keeps the drafts of what it holds. */
export function DraftsProvider({ children }: { children: ReactNode }) {
  const [drafts] = useState<Drafts>(() => new Map());
  return <DraftsContext.Provider value={drafts}>{children}</DraftsContext.Provider>;
}

/**
 * `useState`, but kept as `part` of the draft of `owner` across unmounts:
 * the next component to ask for it starts from what was left there. Kept as
 * it is set, so that what is set as the component goes, such as a sent
 * draft cleared, sticks. Without an owner, or outside a DraftsProvider, it
 * is plain state.
 */
export function useKeptState<T>(owner: string | undefined, part: string, initial: T): [T, (next: T | ((was: T) => T)) => void] {
  const drafts = useContext(DraftsContext);
  const draft = () => (owner === undefined || !drafts ? undefined : drafts.get(owner) ?? drafts.set(owner, new Map()).get(owner)!);
  const [value, setValue] = useState<T>(() => {
    const parts = draft();
    return parts?.has(part) ? (parts.get(part) as T) : initial;
  });
  // What was last set, for an update from a closure older than the last render.
  const latest = useRef(value);
  latest.current = value;
  /** Worked out at once, kept or not: what the setter makes is there to read as soon as it returns. */
  const set = (next: T | ((was: T) => T)) => {
    const parts = draft();
    const was = parts?.has(part) ? (parts.get(part) as T) : latest.current;
    const now = typeof next === 'function' ? (next as (was: T) => T)(was) : next;
    parts?.set(part, now);
    latest.current = now;
    setValue(now);
  };
  return [value, set];
}

/** Throws away the draft of an owner. */
export function useForgetDraft(): (owner: string) => void {
  const drafts = useContext(DraftsContext);
  return (owner) => void drafts?.delete(owner);
}
