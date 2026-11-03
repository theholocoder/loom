// The archive command, shared by the Session header and the Inbox rows, and
// ready for the `e` shortcut: archives a Session, warning first (Discard / Cancel) when its
// worktree has uncommitted changes or unpushed commits.
import { FolderX, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session, UnsavedWork } from '../shared/api';
import { useApi } from './api';

export interface Archiver {
  /** Archives the Session, or opens the warning; rejects with what went wrong. */
  archive: (session: Session) => Promise<void>;
  /** The warning, while one is open; render it anywhere. */
  dialog: ReactNode;
}

export function useArchive(): Archiver {
  const api = useApi();
  const [held, setHeld] = useState<{ session: Session; unsavedWork: UnsavedWork }>();
  const archive = async (session: Session) => {
    const result = await api.invoke('sessions.archive', { id: session.id });
    if (!result.archived) setHeld({ session, unsavedWork: result.unsavedWork });
  };
  const dialog = held && (
    <DiscardWarning
      key={held.session.id}
      unsavedWork={held.unsavedWork}
      onDiscard={async () => {
        await api.invoke('sessions.archive', { id: held.session.id, discard: true });
        setHeld(undefined);
      }}
      onCancel={() => setHeld(undefined)}
    />
  );
  return { archive, dialog };
}

/** The flag on a Session whose worktree was deleted outside Loom. */
export function WorktreeMissing() {
  return (
    <span className="chip flag-missing" role="status" aria-label="Worktree missing">
      <FolderX className="sm" />
      Worktree missing
    </span>
  );
}

/** What archiving would lose, in words. */
export function unsavedWorkText({ uncommitted, unpushedCommits }: UnsavedWork): string {
  const commits = unpushedCommits === 1 ? '1 unpushed commit' : `${unpushedCommits} unpushed commits`;
  const what = uncommitted && unpushedCommits ? `uncommitted changes and ${commits}` : uncommitted ? 'uncommitted changes' : commits;
  const kept = unpushedCommits ? ' Commits stay on its local branch.' : '';
  return `This Session's worktree has ${what}. Archiving removes the worktree${uncommitted ? ' and discards the changes' : ''}.${kept}`;
}

function DiscardWarning({ unsavedWork, onDiscard, onCancel }: { unsavedWork: UnsavedWork; onDiscard: () => Promise<void>; onCancel: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const discard = () => {
    setError(undefined);
    setBusy(true);
    onDiscard()
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="scrim" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="card modal" role="alertdialog" aria-modal="true" aria-labelledby="archive-warning-title" aria-describedby="archive-warning-text">
        <div className="card-head">
          <TriangleAlert className="sm warn-icon" />
          <h3 id="archive-warning-title">Archive with unsaved work?</h3>
        </div>
        <p id="archive-warning-text">{unsavedWorkText(unsavedWork)}</p>
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
        <div className="row modal-actions">
          <button ref={cancel} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" disabled={busy} onClick={discard}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
