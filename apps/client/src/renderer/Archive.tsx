// The archive command, shared by the Session header, the Inbox rows, the
// palette and the `e` shortcut: archives a Session, warning first when its
// worktree has uncommitted changes or unpushed commits (keep them as a commit,
// or discard them), then says so in a toast with Undo. Also the dialog that
// Delete shares, and the flags of archived and removed Sessions.
import { FolderX, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CloseSessionParams, RemovedProject, Session, UnsavedWork } from '../shared/api';
import { ErrorText } from './ErrorText';
import { useApi, useTopic } from './api';
import { useToast } from './Toast';

export interface Archiver {
  /** Archives the Session, or opens the warning; rejects with what went wrong. */
  archive: (session: Session) => Promise<void>;
  /** The warning, while one is open; render it anywhere. */
  dialog: ReactNode;
}

export function useArchive(): Archiver {
  const api = useApi();
  const toast = useToast();
  const [held, setHeld] = useState<{ session: Session; unsavedWork: UnsavedWork }>();
  const archive = async (session: Session) => {
    const result = await api.invoke('sessions.archive', { id: session.id });
    if (!result.archived) return setHeld({ session, unsavedWork: result.unsavedWork });
    archived(session);
  };
  /** Says the Session was archived, in a toast whose Undo reopens it. */
  const archived = (session: Session) => {
    const queued = session.queue?.length ?? 0;
    const kept = queued === 0 ? '' : queued === 1 ? '; its queued message is kept for when it reopens' : `; its ${queued} queued messages are kept for when it reopens`;
    toast.show({ message: `Archived “${session.title}”${kept}`, undo: () => api.invoke('sessions.unarchive', { id: session.id }) });
  };
  const dialog = held && (
    <CloseSessionDialog
      key={held.session.id}
      id="archive-warning"
      title="Archive with unsaved work?"
      icon={<TriangleAlert className="sm warn-icon" />}
      verb="archive"
      branch={held.session.branch}
      unsavedWork={held.unsavedWork}
      onClose={async (choice) => {
        const result = await api.invoke('sessions.archive', { id: held.session.id, ...choice });
        // More came meanwhile, to ask about again.
        if (!result.archived) return setHeld({ session: held.session, unsavedWork: result.unsavedWork });
        setHeld(undefined);
        // Kept, the work comes back with Undo; discarded, it wouldn't.
        if (choice.commitWork) archived(held.session);
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

/** The removed Project `projectId` is, if the user removed it. */
export function useRemovedProject(projectId: number): RemovedProject | undefined {
  return useTopic('removedProjects')?.find((p) => p.id === projectId);
}

/** Which Projects the user removed, by id. */
export function useRemovedProjectIds(): Set<number> {
  const removed = useTopic('removedProjects');
  return useMemo(() => new Set((removed ?? []).map((p) => p.id)), [removed]);
}

/** The flag on an archived Session whose Project the user removed. */
export function ProjectRemoved() {
  return (
    <span className="chip" role="status">
      Project removed
    </span>
  );
}

/** The muted tag on a removed Project's name, where its history shows. */
export function RemovedTag() {
  return <span className="chip removed-tag">removed</span>;
}

/** What a worktree has unsaved: "uncommitted changes and 2 unpushed commits". */
export function unsavedWorkSummary({ uncommitted, unpushedCommits }: UnsavedWork): string {
  const commits = unpushedCommits === 1 ? '1 unpushed commit' : `${unpushedCommits} unpushed commits`;
  return uncommitted && unpushedCommits ? `uncommitted changes and ${commits}` : uncommitted ? 'uncommitted changes' : commits;
}

/** How the user closes a Session whose worktree has unsaved work: keeping it as a commit on its branch, or discarding it. */
export type CloseChoice = Pick<CloseSessionParams, 'discard' | 'commitWork'>;

/** Which way the dialog closes the Session: for now, or for good. */
type CloseVerb = 'archive' | 'delete';

/** What the worktree's unsaved work is, and what happens to it either way, in words; `reopens`, whether the Session can come back to it. */
export function unsavedWorkText(work: UnsavedWork, branch: string | undefined, reopens: boolean): string {
  const { uncommitted, unpushedCommits, detached } = work;
  const has = `This Session's worktree has ${unsavedWorkSummary(work)}.`;
  if (detached) return `${has} Its HEAD is on no branch, so nothing can keep it: removing the worktree loses it all.`;
  const on = branch ? `its branch ${branch}` : 'its branch';
  if (!uncommitted) return `${has} ${unpushedCommits === 1 ? 'It stays' : 'They stay'} on ${on} when the worktree is removed.`;
  return `${has} Commit them to keep them on ${on} as a WIP commit${reopens ? ', there when the Session reopens,' : ','} or discard them with the worktree.${unpushedCommits ? ` Its commits stay on ${on}.` : ''}`;
}

/** The buttons closing a Session with unsaved work offers, for `verb` ("archive", "delete"): keep it if it can be, else discard it. */
function unsavedChoices(work: UnsavedWork, verb: CloseVerb): Array<{ label: string; className: string; choice: CloseChoice }> {
  const Verb = verb.charAt(0).toUpperCase() + verb.slice(1);
  // On no branch, nothing can keep it; with only commits, on a branch, nothing is lost. Committing whatever came meanwhile loses nothing either.
  if (work.detached) return [{ label: `Discard and ${verb}`, className: 'danger', choice: { discard: true } }];
  if (!work.uncommitted) return [{ label: Verb, className: 'primary', choice: { commitWork: true } }];
  return [
    { label: `Commit and ${verb}`, className: 'primary', choice: { commitWork: true } },
    { label: `Discard and ${verb}`, className: 'danger', choice: { discard: true } },
  ];
}

/**
 * A dialog closing a Session for good or for now: `text` says what happens,
 * and with `unsavedWork`, what the worktree has and the ways to deal with it;
 * without, `plain` is the one button.
 */
export function CloseSessionDialog({
  id,
  title,
  icon,
  text,
  verb,
  plain,
  branch,
  unsavedWork,
  onClose,
  onCancel,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  text?: string;
  verb: CloseVerb;
  plain?: string;
  branch: string | undefined;
  unsavedWork?: UnsavedWork;
  onClose: (choice: CloseChoice) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const close = (choice: CloseChoice) => {
    setError(undefined);
    setBusy(true);
    onClose(choice)
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const choices = unsavedWork ? unsavedChoices(unsavedWork, verb) : plain ? [{ label: plain, className: 'danger', choice: {} }] : [];
  return (
    <div className="scrim" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="card modal" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}>
        <div className="card-head">
          {unsavedWork ? <TriangleAlert className="sm warn-icon" /> : icon}
          <h3 id={`${id}-title`}>{title}</h3>
        </div>
        <div id={`${id}-text`}>
          {text && <p>{text}</p>}
          {unsavedWork && <p>{unsavedWorkText(unsavedWork, branch, verb === 'archive')}</p>}
        </div>
        {error && (
          <div className="err" role="alert">
            <ErrorText text={error} />
          </div>
        )}
        <div className="row modal-actions">
          <button ref={cancel} type="button" onClick={onCancel}>
            Cancel
          </button>
          {choices.map(({ label, className, choice }) => (
            <button key={label} type="button" className={className} disabled={busy} onClick={() => close(choice)}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
