// The delete command, shared by the Session menus and the palette: deletes a
// Session for good, asking first in one dialog, which also says what unsaved
// work its worktree has and offers to keep it as a commit, or discard it.
import { Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { Session, UnsavedWork } from '../shared/api';
import { useApi } from './api';
import { CloseSessionDialog } from './Archive';

export interface Deleter {
  /** Opens the dialog asking whether to delete the Session. */
  delete: (session: Session) => void;
  /** The dialog, while one is open; render it anywhere. */
  dialog: ReactNode;
}

export function useDelete(): Deleter {
  const api = useApi();
  const [asked, setAsked] = useState<{ session: Session; unsavedWork?: UnsavedWork }>();
  const close = () => setAsked(undefined);
  const session = asked?.session;
  // Asked once, up front; Delete pressed before the answer is safe, as the deletion looks again and says what it found.
  useEffect(() => {
    if (!session) return;
    let current = true;
    api
      .invoke('sessions.unsavedWork', { id: session.id })
      // Not known, the deletion itself asks.
      .catch(() => null)
      .then((work) => {
        if (current && work) setAsked((was) => (was?.session.id === session.id ? { ...was, unsavedWork: was.unsavedWork ?? work } : was));
      });
    return () => {
      current = false;
    };
  }, [api, session]);
  const dialog = asked && (
    <CloseSessionDialog
      key={asked.session.id}
      id="delete-session"
      title={`Delete “${asked.session.title}”?`}
      icon={<Trash2 className="sm warn-icon" />}
      text={`Its conversation and attachments are deleted, which can't be undone.${workingCopyText(asked.session)} Its usage still counts on the Dashboard.`}
      verb="delete"
      plain="Delete"
      branch={asked.session.branch}
      unsavedWork={asked.unsavedWork}
      onClose={async (choice) => {
        const result = await api.invoke('sessions.delete', { id: asked.session.id, ...choice });
        if (result.deleted) close();
        else setAsked({ session: asked.session, unsavedWork: result.unsavedWork });
      }}
      onCancel={close}
    />
  );
  return { delete: (session) => setAsked({ session }), dialog };
}

/** What deleting the Session does to its working copy, in words. */
function workingCopyText(session: Session): string {
  if (session.workingCopy.kind === 'checkout') return " The Project's checkout is left as it is.";
  const branch = session.branch ? `its branch ${session.branch}` : 'its branch';
  // An archived Session's worktree is gone already; a missing one, gone outside Loom.
  if (session.status === 'archived' || session.worktreeMissing) return ` ${capitalized(branch)} stays.`;
  return ` Its worktree is removed; ${branch} stays.`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
