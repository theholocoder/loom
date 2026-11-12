// What a Panel reads from the Session's Forge of what the Session links to:
// the Merge request's overview or its diff, or the issue.
import { useEffect, useState } from 'react';
import type { Commands, Session } from '../shared/api';
import { useApi } from './api';

/** The commands that read what the Session links to from its Forge, each taking only the Session. */
type ForgeRead = 'sessions.mergeRequest' | 'sessions.mergeRequestDiff' | 'sessions.issue';

/** What a Panel last read from the Forge, whether it is reading it again, and when it last read it. */
export interface ForgeReadState<T> {
  value?: T;
  error?: string;
  loading: boolean;
  at?: number;
}

/**
 * What `command` last read of Session `sessionId`'s link to `url`: read
 * again on a new link and whenever `again` changes. What was read before
 * stays under why it couldn't be read again; what was read of a link before
 * doesn't. Nothing is read without a link.
 */
export function useForgeRead<C extends ForgeRead>(command: C, sessionId: number, url: string | undefined, again: readonly unknown[]): ForgeReadState<Commands[C]['result']> {
  const api = useApi();
  const [read, setRead] = useState<{ url: string; value?: Commands[C]['result']; error?: string; at?: number }>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url) return void setLoading(false);
    let current = true;
    setLoading(true);
    (api.invoke as (command: ForgeRead, params: { id: number }) => Promise<Commands[C]['result']>).call(api, command, { id: sessionId })
      .then((value) => current && setRead({ url, value, at: Date.now() }))
      .catch((e: unknown) => current && setRead((was) => ({ ...(was?.url === url ? was : { url }), error: (e as Error).message })))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
      // The read that replaces it, if any, says it is loading again.
      setLoading(false);
    };
  }, [api, command, sessionId, url, ...again]);
  const mine = read?.url === url ? read : undefined;
  return { value: mine?.value, error: mine?.error, at: mine?.at, loading };
}

/** What `command` last read of `session`'s Merge request: read again on a new link, after each Babysit poll, and on a new `generation`. */
export function useMergeRequestRead<C extends 'sessions.mergeRequest' | 'sessions.mergeRequestDiff'>(command: C, session: Session, generation: number): ForgeReadState<Commands[C]['result']> {
  return useForgeRead(command, session.id, session.mergeRequest?.url, [session.babysit?.lastPollAt, generation]);
}
