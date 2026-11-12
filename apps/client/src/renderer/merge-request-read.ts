// What the Merge request Panel reads of the Session's Merge request from its
// Forge: its overview, or its diff.
import { useEffect, useState } from 'react';
import type { Commands, Session } from '../shared/api';
import { useApi } from './api';

/** The commands that read the Session's Merge request from its Forge. */
type MergeRequestRead = 'sessions.mergeRequest' | 'sessions.mergeRequestDiff';

/**
 * What `command` last read of `session`'s Merge request: read again on a new
 * link, after each Babysit poll, and on a new `generation`. What was read
 * before stays under why it couldn't be read again; what was read of a
 * Merge request linked before doesn't.
 */
export function useMergeRequestRead<C extends MergeRequestRead>(command: C, session: Session, generation: number): { value?: Commands[C]['result']; error?: string; loading: boolean; at?: number } {
  const api = useApi();
  const url = session.mergeRequest?.url;
  const [read, setRead] = useState<{ url: string; value?: Commands[C]['result']; error?: string; at?: number }>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url) return void setLoading(false);
    let current = true;
    setLoading(true);
    (api.invoke as (command: MergeRequestRead, params: { id: number }) => Promise<Commands[C]['result']>).call(api, command, { id: session.id })
      .then((value) => current && setRead({ url, value, at: Date.now() }))
      .catch((e: unknown) => current && setRead((was) => ({ ...(was?.url === url ? was : { url }), error: (e as Error).message })))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
      // The read that replaces it, if any, says it is loading again.
      setLoading(false);
    };
  }, [api, command, session.id, url, session.babysit?.lastPollAt, generation]);
  const mine = read?.url === url ? read : undefined;
  return { value: mine?.value, error: mine?.error, at: mine?.at, loading };
}
