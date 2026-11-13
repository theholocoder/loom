// The sidebar's Inbox, following docs/prototypes/ui-layout.html (variant B):
// Waiting Sessions grouped by Project, with Snoozed, Working and Archived
// Sessions in collapsed sections together at the bottom, as
// docs/prototypes/side-panels.html draws it. Every section shows the same cards.
import { AlarmClock, AlarmClockOff, Archive, ChevronDown, ChevronRight, CircleDot, ExternalLink, GitBranch, GitPullRequest, GitPullRequestCreate, Inbox as InboxIcon, LoaderCircle, Mail, Reply, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { mergeRequestRef, type ForgeKind, type Project, type Session } from '../shared/api';
import { PROJECT_COLOR_NAMES } from '../shared/projects';
import { useApi, useTopic } from './api';
import { useDates } from './dates';
import { useNow } from './now';
import { ProjectRemoved, useArchive, useRemovedProjectIds, WorktreeMissing } from './Archive';
import { ProjectAvatar, projectColor } from './ProjectAvatar';
import { StatusIcon } from './Sessions';
import { isSnoozed, SnoozeButton } from './Snooze';
import { useSessionMenu } from './SessionMenu';
import { copyable } from './ContextMenu';

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
  const removed = useTopic('removedProjects');
  const removedIds = useRemovedProjectIds();
  // Projects by id, the removed ones too: their archived Sessions' cards still show their name.
  const named = [...projects, ...(removed ?? []).map((p) => ({ ...unknownProject(p.id), name: p.name, color: p.color }))];
  const waiting = sessions.filter(inInbox);
  const groups = groupByProject(waiting, named);
  const snoozed = [...sessions.filter(isSnoozed)].sort((a, b) => a.snoozedUntil! - b.snoozedUntil!);
  const working = sessions.filter((s) => s.status === 'working');
  const archived = [...sessions.filter((s) => s.status === 'archived')].sort((a, b) => b.updatedAt - a.updatedAt);
  const cards = { now, selectedId, onSelect, onReply };
  /** A section's cards, each saying its Project since they aren't grouped by one. */
  const sectionCards = (label: string, list: Session[]) => (
    <div role="list" aria-label={label}>
      {list.map((session) => (
        <SessionCard key={session.id} session={session} project={projectOf(session.projectId, named)} showProject projectRemoved={removedIds.has(session.projectId)} now={now} selected={session.id === selectedId} onSelect={onSelect} onReply={onReply} />
      ))}
    </div>
  );
  const holdsViewed = (list: Session[]) => list.some((s) => s.id === selectedId);
  return (
    <>
      {/* The Inbox scrolls in the space between the search box and the sections below. */}
      <div className="side-list">
        <div className="section-head">
          <InboxIcon className="sm" /> Inbox<span className="grow" />
          {waiting.length}
        </div>
        {groups.length === 0 && <div className="empty">Nothing needs you right now.</div>}
        <ProjectGroups groups={groups} {...cards} />
      </div>
      <div className="side-bottom">
        <Section label="Snoozed" icon={AlarmClock} sessions={snoozed} holdsSelected={holdsViewed(snoozed)}>
          {sectionCards('Snoozed', snoozed)}
        </Section>
        <Section label="Working" icon={LoaderCircle} sessions={working} holdsSelected={holdsViewed(working)}>
          {sectionCards('Working', working)}
        </Section>
        <Section label="Archived" icon={Archive} sessions={archived} holdsSelected={holdsViewed(archived)}>
          {sectionCards('Archived', archived)}
        </Section>
      </div>
    </>
  );
}

/** Waiting Sessions as Inbox cards, under their Project's head saying how many there are. */
function ProjectGroups({ groups, now, selectedId, onSelect, onReply }: { groups: ProjectGroup[]; now: number } & Omit<InboxProps, 'sessions' | 'projects'>) {
  return (
    <>
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
              <SessionCard key={session.id} session={session} project={project} now={now} selected={session.id === selectedId} onSelect={onSelect} onReply={onReply} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** Whether the Session is in the Inbox: Waiting, and not Snoozed. */
function inInbox(session: Session): boolean {
  return session.status === 'waiting' && !isSnoozed(session);
}

/** The Waiting Sessions in the order the Inbox lists them: what `j` and `k` step through, and Ctrl+1 to Ctrl+9 count. */
export function inboxOrder(sessions: Session[], projects: Project[]): Session[] {
  return groupByProject(
    sessions.filter(inInbox),
    projects,
  ).flatMap((group) => group.sessions);
}

/** A Project's Sessions, as the sidebar groups them. */
type ProjectGroup = { project: Project; sessions: Session[] };

/**
 * The Waiting Sessions of each Project that has some, Projects by name and
 * Sessions most recently Waiting first.
 */
function groupByProject(waiting: Session[], projects: Project[]): ProjectGroup[] {
  const groups = new Map<number, Session[]>();
  for (const session of [...waiting].sort((a, b) => b.updatedAt - a.updatedAt)) {
    groups.set(session.projectId, [...(groups.get(session.projectId) ?? []), session]);
  }
  return [...groups.entries()]
    .map(([id, sessions]) => ({ project: projectOf(id, projects), sessions }))
    .sort((a, b) => a.project.name.localeCompare(b.project.name));
}

/** The Project with this id, or a stand-in until the projects topic reports it. */
function projectOf(id: number, projects: Project[]): Project {
  return projects.find((p) => p.id === id) ?? unknownProject(id);
}

/** Stands in for a Project the projects topic hasn't reported yet. */
function unknownProject(id: number): Project {
  return { id, name: `Project ${id}`, color: PROJECT_COLOR_NAMES[id % PROJECT_COLOR_NAMES.length]!, branchPrefix: '', checkout: { environmentId: '', path: '' }, forge: { state: 'unknown', checking: false } };
}

interface SessionCardProps {
  session: Session;
  project: Project;
  /** Whether the card starts its second line with the Project's name: outside the Inbox, where cards aren't grouped by Project. */
  showProject?: boolean;
  /** Whether the user removed its Project. */
  projectRemoved?: boolean;
  now: number;
  selected: boolean;
  onSelect: (session: Session) => void;
  onReply: (session: Session) => void;
}

/** Waiting reasons the agent can't go on from without the user (an Approval request, a question), which their cards make stand out. */
const NEEDS_YOU = new Set<Session['waitingReason']>(['question', 'approval']);

/** A Session's card, the same in every section: status, title, unread and time, then its Project (outside the Inbox), issue, Merge request and branch. */
function SessionCard({ session, project, showProject = false, projectRemoved = false, now, selected, onSelect, onReply }: SessionCardProps) {
  const api = useApi();
  const [error, setError] = useState<string>();
  // A failure is about the Session as it was; once its status changes, it's stale.
  useEffect(() => setError(undefined), [session.updatedAt]);
  const card = useRef<HTMLDivElement>(null);
  // The Session being viewed stays in sight, wherever its card moves.
  useEffect(() => {
    if (selected) card.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, session.status, session.snoozedUntil]);
  const snoozed = isSnoozed(session);
  const waiting = session.status === 'waiting';
  const { issue, mergeRequest, branch } = session;
  const mergeRequestNumber = mergeRequest && mergeRequestRef(project.forge.kind, mergeRequest.number);
  const archiver = useArchive();
  const menu = useSessionMenu(session, setError);
  const [snoozing, setSnoozing] = useState(false);
  /** A click handler running a card action, saying on the card why it failed. */
  const withRowError = (action: () => Promise<void>) => () => {
    setError(undefined);
    action().catch((e: unknown) => setError((e as Error).message));
  };
  // Only a Waiting Session's card has actions; the others have their right-click menu.
  const actions = !waiting
    ? []
    : [
        // A Session whose worktree is missing can only be archived.
        !session.worktreeMissing && <Action key="reply" label="Reply" icon={Reply} onClick={() => onReply(session)} />,
        session.worktreeMissing
          ? null
          : mergeRequest
            ? <Action key="mr" label={`Open Merge request ${mergeRequestNumber}`} icon={ExternalLink} onClick={withRowError(() => api.invoke('links.open', { url: mergeRequest.url }))} />
            : project.forge.state === 'available' && <Action key="mr" label="Create Merge request" icon={GitPullRequestCreate} onClick={withRowError(() => api.invoke('sessions.requestMergeRequest', { id: session.id }))} />,
        snoozed ? (
          <Action key="snooze" label="Wake" icon={AlarmClockOff} onClick={withRowError(() => api.invoke('sessions.snooze', { id: session.id, until: null }))} />
        ) : (
          !session.worktreeMissing && <SnoozeButton key="snooze" session={session} onOpenChange={setSnoozing} onError={setError} />
        ),
        <Action key="archive" label="Archive" icon={Archive} onClick={withRowError(() => archiver.archive(session))} />,
        !session.worktreeMissing && !session.unread && <Action key="unread" label="Mark unread" icon={Mail} onClick={withRowError(() => api.invoke('sessions.setUnread', { id: session.id, unread: true }))} />,
      ].filter(Boolean);
  const needsYou = waiting && !snoozed && NEEDS_YOU.has(session.waitingReason);
  const className = ['item', 'B-item', session.unread && 'unread', selected && 'sel', snoozing && 'menu-open', needsYou && 'needs-you'].filter(Boolean).join(' ');
  return (
    <div ref={card} role="listitem" aria-label={session.title} className={className} style={{ '--actions': actions.length } as CSSProperties} onContextMenu={menu.onContextMenu}>
      <button type="button" className="open" aria-label={session.title} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(session)}>
        <div className="l1">
          <StatusIcon session={session} />
          <span className="title grow ellipsis">{session.title}</span>
          {session.worktreeMissing && <WorktreeMissing />}
          {session.unread && <UnreadDot />}
          <CardTime session={session} now={now} />
        </div>
        {(showProject || issue || mergeRequest || branch) && (
          <div className="l2">
            {showProject && (
              <span className="proj ellipsis" title="Project">
                <span className="proj-dot" aria-hidden style={{ background: projectColor(project) }} />
                {project.name}
              </span>
            )}
            {projectRemoved && <ProjectRemoved />}
            {issue && <Ref title="Issue" icon={CircleDot} text={`#${issue.number}`} />}
            {mergeRequestNumber && <Ref title="Merge request" icon={GitPullRequest} text={mergeRequestNumber} />}
            {branch && <Ref title="Branch" icon={GitBranch} text={branch} copy={copyable('branch name', branch)} branch />}
          </div>
        )}
      </button>
      {error && (
        <div className="err row-error" role="alert">
          {error}
        </div>
      )}
      {actions.length > 0 && <div className="hover-actions">{actions}</div>}
      {archiver.dialog}
      {menu.dialogs}
    </div>
  );
}

/**
 * When the card's Session wakes (Snoozed), how long it has run (Working),
 * when it was archived (Archived), or how long it has been Waiting.
 */
function CardTime({ session, now }: { session: Session; now: number }) {
  const dates = useDates();
  const snoozed = isSnoozed(session);
  const at = snoozed ? session.snoozedUntil! : session.updatedAt;
  const full = dates.full(at);
  const { text, title, className } = snoozed
    ? { text: `until ${dates.upcoming(at, now)}`, title: `Comes back ${full}`, className: 'time' }
    : session.status === 'working'
      ? { text: elapsed(now - at), title: `Working since ${full}`, className: 'time elapsed' }
      : session.status === 'archived'
        ? { text: dates.day(at, now), title: `Archived ${full}`, className: 'time' }
        : { text: dates.agoShort(at, now), title: `Waiting since ${full}`, className: 'time' };
  return (
    <time className={className} dateTime={new Date(at).toISOString()} title={title}>
      {text}
    </time>
  );
}

/** One of a card's issue, Merge request and branch. */
function Ref({ title, icon: Icon, text, copy, branch = false }: { title: string; icon: LucideIcon; text: string; copy?: ReturnType<typeof copyable>; branch?: boolean }) {
  // The branch gives way, cut short with an ellipsis; the numbers keep their room.
  return (
    <span className={branch ? 'row ellipsis' : 'row ref'} title={title} {...copy}>
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

const MINUTE = 60_000;

/** How long a Working Session has run: "<1m", "4m", "1h 12m". */
function elapsed(ms: number): string {
  if (ms < MINUTE) return '<1m';
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

/** The mark of news the user hasn't opened yet. */
function UnreadDot() {
  return <span className="unread-dot" role="img" aria-label="Unread" />;
}

/** A collapsible sidebar section (Snoozed, Working, Archived) below the Inbox, showing `children` when open. */
function Section({ label, icon: Icon, sessions, holdsSelected, children }: { label: string; icon: LucideIcon; sessions: Session[]; holdsSelected: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // The Session being viewed stays visible: its section opens when its card moves in.
  useEffect(() => {
    if (holdsSelected) setOpen(true);
  }, [holdsSelected]);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <button className="section-head" type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron className="sm" />
        <Icon className="sm" />
        {label}
        <span className="grow" />
        {sessions.some((s) => s.unread) && <UnreadDot />}
        {sessions.length}
      </button>
      {open && children}
    </>
  );
}
