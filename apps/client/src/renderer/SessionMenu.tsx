// A Session's right-click menu, on its sidebar card and its header: a new
// Session on the same working copy, Snooze, Rename, Mark unread, Archive and
// Delete.
import { AlarmClock, AlarmClockOff, Archive, Mail, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { createContext, useContext, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import type { Session } from '../shared/api';
import { useApi, useTopic } from './api';
import { useArchive } from './Archive';
import { addToContextMenu, type ContextMenuItem } from './ContextMenu';
import { useDelete } from './Delete';
import { Popover } from './Popover';
import type { NewSessionWorkingCopy } from './Sessions';
import { isSnoozed, SnoozeMenu } from './Snooze';

/** Opens New Session on a Project and working copy; given by the window, which shows it. */
export const NewSessionContext = createContext<(projectId: number, workingCopy: NewSessionWorkingCopy) => void>(() => {});

/**
 * What a new Session on the same working copy as `session` starts on, and
 * how the menu says it: its checkout; its worktree while one is there, its
 * own or one a Session sharing it still works in; else its branch, in a new
 * worktree. None for a worktree Session on no branch with no worktree left.
 */
export function sameWorkingCopy(session: Session, sessions: Session[]): { label: string; start: NewSessionWorkingCopy } | undefined {
  const { workingCopy, branch } = session;
  if (workingCopy.kind === 'checkout') return { label: 'New Session in the checkout', start: { workingCopy: 'checkout' } };
  const there = (s: Session) => s.status !== 'archived' && !s.worktreeMissing && s.workingCopy.kind === 'worktree' && s.workingCopy.path === workingCopy.path;
  if (sessions.some(there) || there(session)) {
    return { label: 'New Session in this worktree', start: { workingCopy: 'existing', existing: { worktree: { path: workingCopy.path, ...(branch ? { branch } : {}) } } } };
  }
  if (!branch) return undefined;
  return { label: 'New Session on this branch', start: { workingCopy: 'existing', existing: { branch: { name: branch, remote: false } } } };
}

export interface SessionMenu {
  /** Adds the Session's items to a right-click's menu; give it as `onContextMenu`. */
  onContextMenu: (event: ReactMouseEvent) => void;
  /** The Archive and Delete dialogs, while one is open; render it anywhere. */
  dialogs: ReactNode;
}

/** The Session's right-click menu; `onError` says why an item failed. */
export function useSessionMenu(session: Session, onError: (message: string) => void): SessionMenu {
  const api = useApi();
  const sessions = useTopic('sessions') ?? [];
  const project = useTopic('projects')?.find((p) => p.id === session.projectId);
  const newSession = useContext(NewSessionContext);
  const archiver = useArchive();
  const deleter = useDelete();
  const fail = (e: unknown) => onError((e as Error).message);
  const onContextMenu = (event: ReactMouseEvent) => {
    // Its dialogs are rendered inside the card or header, but aren't part of them.
    if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
    const same = project ? sameWorkingCopy(session, sessions) : undefined;
    const waiting = session.status === 'waiting' && !session.worktreeMissing;
    const snooze: ContextMenuItem = isSnoozed(session)
      ? { label: 'Wake', icon: AlarmClockOff, run: () => void api.invoke('sessions.snooze', { id: session.id, until: null }).catch(fail) }
      : {
          label: 'Snooze…',
          icon: AlarmClock,
          disabled: !waiting,
          open: (anchor, close) => <SnoozeMenu anchor={anchor} session={session} onClose={close} onError={onError} />,
        };
    addToContextMenu(
      event,
      [{ label: same?.label ?? 'New Session here', icon: MessageSquarePlus, disabled: !same, run: () => same && newSession(session.projectId, same.start) }, snooze],
      [
        { label: 'Rename…', icon: Pencil, open: (anchor, close) => <RenameSession anchor={anchor} session={session} onClose={close} onError={onError} /> },
        { label: 'Mark unread', icon: Mail, disabled: session.unread, run: () => void api.invoke('sessions.setUnread', { id: session.id, unread: true }).catch(fail) },
      ],
      [
        { label: 'Archive', icon: Archive, disabled: session.status === 'archived', run: () => void archiver.archive(session).catch(fail) },
        { label: 'Delete…', icon: Trash2, run: () => deleter.delete(session) },
      ],
    );
  };
  return {
    onContextMenu,
    dialogs: (
      <>
        {archiver.dialog}
        {deleter.dialog}
      </>
    ),
  };
}

/** The Session's title to edit, beside `anchor`: Enter renames it, Escape leaves it be. */
function RenameSession({ anchor, session, onClose, onError }: { anchor: RefObject<HTMLElement | null>; session: Session; onClose: () => void; onError: (message: string) => void }) {
  const api = useApi();
  const [title, setTitle] = useState(session.title);
  const valid = title.trim() !== '';
  return (
    <Popover anchor={anchor} role="dialog" label="Rename Session" className="rename-session" onClose={onClose}>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onClose();
          if (title.trim() !== session.title) api.invoke('sessions.rename', { id: session.id, title }).catch((e: unknown) => onError((e as Error).message));
        }}
      >
        <input data-autofocus aria-label="Title" className="grow" value={title} onChange={(event) => setTitle(event.target.value)} onFocus={(event) => event.target.select()} />
        <button type="submit" className="primary" disabled={!valid}>
          Rename
        </button>
      </form>
    </Popover>
  );
}
