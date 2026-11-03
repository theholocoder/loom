// The Session header's "Open in editor" and "Open in terminal" actions, which
// run the user's own commands in the Session's Environment.
import { CodeXml, SquareTerminal } from 'lucide-react';
import type { Session } from '../shared/api';
import { useApi } from './api';

/** None on an archived Session, whose working copy may be gone. */
export function OpenActions({ session, onError }: { session: Session; onError: (message: string | undefined) => void }) {
  const api = useApi();
  if (session.status === 'archived') return null;
  const run = (command: 'sessions.openInEditor' | 'sessions.openInTerminal') => {
    onError(undefined);
    api.invoke(command, { id: session.id }).catch((e: unknown) => onError((e as Error).message));
  };
  return (
    <>
      <button className="icon-btn" type="button" title="Open in editor" aria-label="Open in editor" onClick={() => run('sessions.openInEditor')}>
        <CodeXml />
      </button>
      <button className="icon-btn" type="button" title="Open in terminal" aria-label="Open in terminal" onClick={() => run('sessions.openInTerminal')}>
        <SquareTerminal />
      </button>
    </>
  );
}
