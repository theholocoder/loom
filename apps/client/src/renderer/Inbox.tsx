// The sidebar's Inbox, following docs/prototypes/ui-layout.html (variant B):
// Waiting Sessions grouped by Project, with Working and Archived Sessions in
// collapsed sections below.
import { Archive, ChevronDown, ChevronRight, CircleDot, ExternalLink, GitBranch, GitPullRequest, GitPullRequestCreate, Inbox as InboxIcon, LoaderCircle, Mail, Reply, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { mergeRequestRef, type ForgeKind, type Project, type Session } from '../shared/api';
import { useApi } from './api';
import { useArchive, WorktreeMissing } from './Archive';
import { ProjectAvatar } from './ProjectAvatar';
import { StatusIcon } from './Sessions';

/** How often the rows' times are brought up to date. */
const TICK_MS = 60_000;

export interface InboxProps {
  sessions: Session[];
  projects: Project[];
  /** The Session open in the main pane, if any. */
  selectedId: number | undefined;
  onSelect: (session: Session) => void;
  /** Opens the Session with its composer focused. */
  onReply: (session: Session) => void;
}

export function InboxList({ sessions, projects, selectedId, onSelect, onReply }: InboxProps) {
  const now = useNow();
  const waiting = sessions.filter((s) => s.status === 'waiting');
  const groups = groupByProject(waiting, projects);
  const rows = { selectedId, onSelect };
  return (
    <>
      <div className="section-head" style={{ borderTop: 0, cursor: 'default' }}>
        <InboxIcon className="sm" /> Inbox<span className="grow" />
        {waiting.length}
      </div>
      {groups.length === 0 && <div className="empty">Nothing needs you right now.</div>}
      {groups.map(({ project, sessions }) => (
        <section key={project.id} role="group" aria-label={project.name}>
          <div className="B-group-head">
            <ProjectAvatar project={project} size={26} />
            <b>{project.name}</b>
            {project.forge.kind && (
              <span className="muted">
                <ForgeMark kind={project.forge.kind} />
              </span>
            )}
            <span className="grow" />
            <span className="chip" aria-label="Waiting">
              {sessions.length}
            </span>
          </div>
          <div role="list">
            {sessions.map((session) => (
              <InboxRow key={session.id} session={session} project={project} now={now} selected={session.id === selectedId} onSelect={onSelect} onReply={onReply} />
            ))}
          </div>
        </section>
      ))}
      <Section label="Working" icon={LoaderCircle} sessions={sessions.filter((s) => s.status === 'working')} {...rows} />
      <Section label="Archived" icon={Archive} sessions={sessions.filter((s) => s.status === 'archived')} {...rows} />
    </>
  );
}

/** The Waiting Sessions in the order the Inbox lists them: what `j` and `k` step through, and Ctrl+1 to Ctrl+9 count. */
export function inboxOrder(sessions: Session[], projects: Project[]): Session[] {
  return groupByProject(
    sessions.filter((s) => s.status === 'waiting'),
    projects,
  ).flatMap((group) => group.sessions);
}

/**
 * The Waiting Sessions of each Project that has some, Projects by name and
 * Sessions most recently Waiting first.
 */
function groupByProject(waiting: Session[], projects: Project[]): Array<{ project: Project; sessions: Session[] }> {
  const groups = new Map<number, Session[]>();
  for (const session of [...waiting].sort((a, b) => b.updatedAt - a.updatedAt)) {
    groups.set(session.projectId, [...(groups.get(session.projectId) ?? []), session]);
  }
  return [...groups.entries()]
    .map(([id, sessions]) => ({ project: projects.find((p) => p.id === id) ?? unknownProject(id), sessions }))
    .sort((a, b) => a.project.name.localeCompare(b.project.name));
}

/** Stands in for a Project the projects topic hasn't reported yet. */
function unknownProject(id: number): Project {
  return { id, name: `Project ${id}`, branchPrefix: '', checkout: { environmentId: '', path: '' }, forge: { state: 'unknown', checking: false } };
}

interface InboxRowProps {
  session: Session;
  project: Project;
  now: number;
  selected: boolean;
  onSelect: (session: Session) => void;
  onReply: (session: Session) => void;
}

function InboxRow({ session, project, now, selected, onSelect, onReply }: InboxRowProps) {
  const api = useApi();
  const [error, setError] = useState<string>();
  // A failure is about the Session as it was; once its status changes, it's stale.
  useEffect(() => setError(undefined), [session.updatedAt]);
  const at = new Date(session.updatedAt);
  const { issue, mergeRequest, branch } = session;
  const mergeRequestNumber = mergeRequest && mergeRequestRef(project.forge.kind, mergeRequest.number);
  const archiver = useArchive();
  /** A click handler running a row action, saying in the row why it failed. */
  const withRowError = (action: () => Promise<void>) => () => {
    setError(undefined);
    action().catch((e: unknown) => setError((e as Error).message));
  };
  return (
    <div role="listitem" aria-label={session.title} className={`item B-item${session.unread ? ' unread' : ''}${selected ? ' sel' : ''}`}>
      <button type="button" className="open" aria-label={session.title} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(session)}>
        <div className="l1">
          <StatusIcon session={session} />
          <span className="title grow ellipsis">{session.title}</span>
          {session.worktreeMissing && <WorktreeMissing />}
          {session.unread && <span className="unread-dot" role="img" aria-label="Unread" />}
          <time className="time" dateTime={at.toISOString()} title={at.toLocaleString()}>
            {timeOf(session.updatedAt, now)}
          </time>
        </div>
        {(issue || mergeRequest || branch) && (
          <div className="l2">
            {issue && <Ref title="Issue" icon={CircleDot} text={`#${issue.number}`} />}
            {mergeRequestNumber && <Ref title="Merge request" icon={GitPullRequest} text={mergeRequestNumber} />}
            {branch && <Ref title="Branch" icon={GitBranch} text={branch} />}
          </div>
        )}
      </button>
      {error && (
        <div className="err row-error" role="alert">
          {error}
        </div>
      )}
      <div className="hover-actions">
        {/* A Session whose worktree is missing can only be archived. */}
        {!session.worktreeMissing && <Action label="Reply" icon={Reply} onClick={() => onReply(session)} />}
        {session.worktreeMissing ? null : mergeRequest ? (
          <Action label={`Open Merge request ${mergeRequestNumber}`} icon={ExternalLink} onClick={withRowError(() => api.invoke('links.open', { url: mergeRequest.url }))} />
        ) : (
          project.forge.state === 'available' && <Action label="Create Merge request" icon={GitPullRequestCreate} onClick={withRowError(() => api.invoke('sessions.requestMergeRequest', { id: session.id }))} />
        )}
        <Action label="Archive" icon={Archive} onClick={withRowError(() => archiver.archive(session))} />
        {!session.worktreeMissing && !session.unread && <Action label="Mark unread" icon={Mail} onClick={withRowError(() => api.invoke('sessions.setUnread', { id: session.id, unread: true }))} />}
      </div>
      {archiver.dialog}
    </div>
  );
}

/** One of a row's issue, Merge request and branch. */
function Ref({ title, icon: Icon, text }: { title: string; icon: LucideIcon; text: string }) {
  return (
    <span className="row ellipsis" title={title}>
      <Icon className="sm" />
      <span className="tech ellipsis">{text}</span>
    </span>
  );
}

function Action({ label, icon: Icon, onClick }: { label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button className="icon-btn sm" type="button" title={label} aria-label={label} onClick={onClick}>
      <Icon />
    </button>
  );
}

/**
 * When a row's Session last changed status: "now" within the minute, the
 * time today, "Yesterday", then the date.
 */
function timeOf(at: number, now: number): string {
  if (now - at < 60_000) return 'now';
  const day = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const FORGE_MARK: Record<ForgeKind, { name: string; path: string }> = {
  github: {
    name: 'GitHub',
    path: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z',
  },
  gitlab: { name: 'GitLab', path: 'M8 15.2 1 10.1l1.6-8.3 2.2 5.4h6.4l2.2-5.4 1.6 8.3z' },
};

/** The Forge's logo; Lucide has no brand icons. */
function ForgeMark({ kind }: { kind: ForgeKind }) {
  const { name, path } = FORGE_MARK[kind];
  return (
    <svg className="lucide sm" viewBox="0 0 16 16" role="img" aria-label={name}>
      <title>{name}</title>
      <path d={path} fill="currentColor" />
    </svg>
  );
}

interface SessionListProps {
  sessions: Session[];
  selectedId: number | undefined;
  onSelect: (session: Session) => void;
}

/** A collapsible sidebar section (Working, Archived) below the Inbox. */
function Section({ label, icon: Icon, ...list }: { label: string; icon: LucideIcon } & SessionListProps) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <button className="section-head" type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron className="sm" />
        <Icon className="sm" />
        {label}
        <span className="grow" />
        {list.sessions.length}
      </button>
      {open && <SessionRows {...list} />}
    </>
  );
}

/** Sessions as one-line rows: status and title. */
function SessionRows({ sessions, selectedId, onSelect }: SessionListProps) {
  return sessions.map((session) => (
    <button key={session.id} type="button" className={`mini${session.id === selectedId ? ' sel' : ''}`} aria-label={session.title} aria-current={session.id === selectedId ? 'true' : undefined} onClick={() => onSelect(session)}>
      <StatusIcon session={session} />
      <span className="grow ellipsis">{session.title}</span>
    </button>
  ));
}
