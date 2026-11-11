// The delete command, shared by the Session menus and the palette: deletes a
// Session for good, asking first, then warning (Discard and delete / Cancel)
// when its worktree has uncommitted changes or unpushed commits.
import { Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session, UnsavedWork } from '../shared/api';
import { useApi } from './api';
import { unsavedWorkText } from './Archive';

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
  const dialog = asked && (
    <DeleteDialog
      key={`${asked.session.id}:${asked.unsavedWork ? 'unsaved' : 'confirm'}`}
      session={asked.session}
      unsavedWork={asked.unsavedWork}
      onDelete={async () => {
        const discard = !!asked.unsavedWork;
        const result = await api.invoke('sessions.delete', discard ? { id: asked.session.id, discard } : { id: asked.session.id });
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

function DeleteDialog({ session, unsavedWork, onDelete, onCancel }: { session: Session; unsavedWork?: UnsavedWork; onDelete: () => Promise<void>; onCancel: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const confirm = () => {
    setError(undefined);
    setBusy(true);
    onDelete()
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const title = unsavedWork ? 'Delete with unsaved work?' : `Delete “${session.title}”?`;
  const text = unsavedWork
    ? unsavedWorkText(unsavedWork, 'Deleting')
    : `Its conversation and attachments are deleted, which can't be undone.${workingCopyText(session)} Its usage still counts on the Dashboard.`;
  return (
    <div className="scrim" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="card modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title" aria-describedby="delete-session-text">
        <div className="card-head">
          {unsavedWork ? <TriangleAlert className="sm warn-icon" /> : <Trash2 className="sm warn-icon" />}
          <h3 id="delete-session-title">{title}</h3>
        </div>
        <p id="delete-session-text">{text}</p>
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
        <div className="row modal-actions">
          <button ref={cancel} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" disabled={busy} onClick={confirm}>
            {unsavedWork ? 'Discard and delete' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
