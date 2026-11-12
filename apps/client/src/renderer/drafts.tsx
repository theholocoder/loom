// What was typed for a message and not sent yet, kept for as long as Loom
// runs: one draft per Session and one for New Session, so that going to
// another Session, or to a Page and from there to a Session, loses none of
// it. A draft lives in the renderer only, gone with the window.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** The drafts kept, each part of one by its own key: `session:7:text`, `new-session:files`. */
type Drafts = Map<string, unknown>;

const DraftsContext = createContext<Drafts | undefined>(undefined);

/** Keeps the drafts of what it holds. */
export function DraftsProvider({ children }: { children: ReactNode }) {
  const [drafts] = useState<Drafts>(() => new Map());
  return <DraftsContext.Provider value={drafts}>{children}</DraftsContext.Provider>;
}

/**
 * `useState`, but kept under `key` across unmounts: the next component to
 * ask for `key` starts from what was left there. Without a key, or outside
 * a DraftsProvider, it is plain state.
 */
export function useKeptState<T>(key: string | undefined, initial: T): [T, (next: T | ((was: T) => T)) => void] {
  const drafts = useContext(DraftsContext);
  const kept = key !== undefined && drafts !== undefined;
  const [value, setValue] = useState<T>(() => (kept && drafts.has(key) ? (drafts.get(key) as T) : initial));
  useEffect(() => {
    if (kept) drafts.set(key, value);
  }, [kept, key, value]);
  return [value, setValue];
}

/** Throws away the drafts kept under keys starting with `prefix`. */
export function useForgetDrafts(): (prefix: string) => void {
  const drafts = useContext(DraftsContext);
  return (prefix) => {
    for (const key of [...(drafts?.keys() ?? [])]) if (key.startsWith(prefix)) drafts!.delete(key);
  };
}
