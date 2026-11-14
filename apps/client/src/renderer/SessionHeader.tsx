// The open Session's header and Glance strip (docs/prototypes/side-panels.html,
// layer A). The header is one line: its title (opening Session details), its
// Project, its status, then the Side area and Dock icons and the ⋯ menu. The
// Glance strip under it shows what is changing right now, each chip opening
// its detail: the branch, the Merge request and its checks, the changes, the
// context used and the issue.
import {
  CircleCheck,
  CircleDot,
  CircleMinus,
  CircleX,
  Clock,
  CodeXml,
  Copy,
  Ellipsis,
  FileDiff,
  Gauge,
  GitBranch,
  GitPullRequest,
  GitPullRequestCreate,
  Info,
  MessageSquare,
  PanelBottom,
  PanelRight,
  SquareTerminal,
} from 'lucide-react';
import { useRef, type ReactNode, type RefObject } from 'react';
import { mergeRequestRef, type BabysitCi, type DiffStat, type ForgeLink, type Project, type RemovedProject, type Session } from '../shared/api';
import { useApi } from './api';
import { useDates } from './dates';
import { ProjectRemoved, WorktreeMissing } from './Archive';
import { copyable, copyText, MenuButtonMenu, type ContextMenuSection } from './ContextMenu';
import { formatCost, formatDuration, formatTokens } from './Dashboard';
import { IssueSearch } from './IssuePicker';
import { contextPercent } from './ModelPicker';
import { Popover } from './Popover';
import { projectColor } from './ProjectAvatar';
import { attempt, openable, SessionDetails, workingMs } from './SessionDetails';
import { RenameSession, type SessionMenu } from './SessionMenu';
import { SnoozeMenu } from './Snooze';
import { canActOnForge, CHECK_STATES, checksSummary, countText, ENDED_LOOKS } from './MergeRequestLooks';

/** Where Session details opens from: the title, the branch chip, the context meter or the ⋯ menu. */
export type DetailsAnchor = 'title' | 'branch' | 'context' | 'menu';

/** The header's one popover open at a time, if any. */
export type HeaderPopover =
  | { kind: 'details'; from: DetailsAnchor }
  | { kind: 'checks' }
  | { kind: 'issue' }
  | { kind: 'menu' }
  /** Snooze and Rename, asked from the palette: beside the title. */
  | { kind: 'snooze' }
  | { kind: 'rename' };

/** What the header shows of the Session's status: in words, as an icon and its class. */
export interface StatusLook {
  label: string;
  icon: ReactNode;
  className: string;
}

/**
 * The Session's header and Glance strip. `popover` is the one open, which
 * `onPopover` changes (the palette and shortcuts open them too). `dock`
 * is absent for a Session that can't have Terminals. What goes wrong running
 * an action goes to `onError`; `flags` (a snooze, say) sit after the status.
 */
export function SessionHeader({
  session,
  project,
  removedProject,
  status,
  flags,
  popover,
  onPopover,
  side,
  dock,
  menu,
  onShowChanges,
  onShowMergeRequest,
  onShowIssue,
  onError,
  children,
}: {
  session: Session;
  project: Project | undefined;
  removedProject: RemovedProject | undefined;
  status: StatusLook;
  flags?: ReactNode;
  popover: HeaderPopover | undefined;
  onPopover: (popover: HeaderPopover | undefined) => void;
  side: { shown: boolean; onToggle: () => void };
  dock?: { shown: boolean; onToggle: () => void };
  menu: SessionMenu;
  onShowChanges: () => void;
  /** Shows the Merge request Panel, at its reviews and comments when asked. */
  onShowMergeRequest: (at?: 'reviews') => void;
  /** Shows the Issue Panel. */
  onShowIssue: () => void;
  onError: (message: string | undefined) => void;
  /** Rendered in the header: the dialogs its actions open. */
  children?: ReactNode;
}) {
  const api = useApi();
  const anchors: Record<DetailsAnchor, RefObject<HTMLButtonElement | null>> = {
    title: useRef<HTMLButtonElement>(null),
    branch: useRef<HTMLButtonElement>(null),
    context: useRef<HTMLButtonElement>(null),
    menu: useRef<HTMLButtonElement>(null),
  };
  const close = () => onPopover(undefined);
  const details = popover?.kind === 'details' ? popover.from : undefined;
  const toggleDetails = (from: DetailsAnchor) => onPopover(details === from ? undefined : { kind: 'details', from });
  const canOpen = openable(session);
  const run = (command: 'sessions.openInEditor' | 'sessions.openInTerminal') => attempt(onError, () => api.invoke(command, { id: session.id }));
  const menuSections = (): ContextMenuSection[] => [
    [
      { label: 'Session details…', icon: Info, run: () => onPopover({ kind: 'details', from: 'menu' }) },
      { label: 'Open in editor', icon: CodeXml, disabled: !canOpen, run: () => run('sessions.openInEditor') },
      { label: 'Open in terminal', icon: SquareTerminal, disabled: !canOpen, run: () => run('sessions.openInTerminal') },
      { label: 'Copy branch name', icon: Copy, disabled: !session.branch, run: () => session.branch && copyText(session.branch) },
    ],
    ...menu.sections(),
  ];
  // A removed Project keeps its name and colour in the header.
  const shownProject = project ?? removedProject;

  return (
    <>
      <div className="main-head session-head" role="region" aria-label="Session header" onContextMenu={menu.onContextMenu}>
        <div className="head-line">
          <h1 className="ellipsis">
            <button
              ref={anchors.title}
              type="button"
              className="title-btn ellipsis"
              title={`${session.title} · Session details`}
              aria-haspopup="dialog"
              aria-expanded={details === 'title'}
              onClick={() => toggleDetails('title')}
            >
              {session.title}
            </button>
          </h1>
          {shownProject && (
            <span className="proj-tag" title="Project" style={{ background: `color-mix(in srgb, ${projectColor(shownProject)} 16%, transparent)` }}>
              <span className="proj-dot" aria-hidden style={{ background: projectColor(shownProject) }} />
              {shownProject.name}
            </span>
          )}
          {removedProject && <ProjectRemoved />}
          <span className={`${status.className} chip`} role="status" aria-label="Session status" title={status.label}>
            {status.icon}
            {status.label}
          </span>
          {session.worktreeMissing && <WorktreeMissing />}
          {flags}
        </div>
        <button
          className="icon-btn"
          type="button"
          title={side.shown ? 'Hide the Side area' : 'Show the Side area'}
          aria-label={side.shown ? 'Hide the Side area' : 'Show the Side area'}
          aria-expanded={side.shown}
          aria-controls="session-side"
          onClick={side.onToggle}
        >
          <PanelRight />
        </button>
        {dock && (
          <button
            className="icon-btn"
            type="button"
            title={dock.shown ? 'Hide the Dock' : 'Show the Dock'}
            aria-label={dock.shown ? 'Hide the Dock' : 'Show the Dock'}
            aria-expanded={dock.shown}
            aria-controls="session-dock"
            onClick={dock.onToggle}
          >
            <PanelBottom />
          </button>
        )}
        <button
          ref={anchors.menu}
          className="icon-btn"
          type="button"
          title="More actions"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={popover?.kind === 'menu'}
          onClick={() => onPopover(popover?.kind === 'menu' ? undefined : { kind: 'menu' })}
        >
          <Ellipsis />
        </button>
        {popover?.kind === 'menu' && <MenuButtonMenu anchor={anchors.menu} label="Session actions" sections={menuSections()} onClose={close} />}
        {details && <SessionDetails session={session} project={project} anchor={anchors[details]} onClose={close} onError={onError} />}
        {popover?.kind === 'snooze' && <SnoozeMenu anchor={anchors.title} session={session} onClose={close} onError={onError} />}
        {popover?.kind === 'rename' && <RenameSession anchor={anchors.title} session={session} onClose={close} onError={onError} />}
        {children}
      </div>
      <div className="glance" role="group" aria-label="Session at a glance" onContextMenu={menu.onContextMenu}>
        <span className="g-chip">
          <button
            ref={anchors.branch}
            type="button"
            title={session.branch ? `${session.branch} · Session details` : 'Session details'}
            aria-haspopup="dialog"
            aria-expanded={details === 'branch'}
            onClick={() => toggleDetails('branch')}
            {...copyable('branch name', session.branch)}
          >
            <GitBranch className="sm" />
            {session.branch ? <span className="tech branch">{session.branch}</span> : <span className="muted">No branch yet</span>}
          </button>
        </span>
        <MergeRequestChip session={session} project={project} popover={popover} onPopover={onPopover} onShow={onShowMergeRequest} onError={onError} />
        <span className={session.diffStat?.files === 0 ? 'g-chip quiet' : 'g-chip'}>
          <button type="button" title="Show Changes" aria-label={session.diffStat ? `Show changes: ${diffStatLabel(session.diffStat)}` : 'Show changes'} onClick={onShowChanges}>
            {session.diffStat?.files === 0 ? (
              <>
                <FileDiff className="sm" />
                No changes
              </>
            ) : session.diffStat ? (
              <span className="diff-stat">
                <FileDiff className="sm" />
                <span className="files">{filesText(session.diffStat)}</span>
                <span className="add">+{session.diffStat.added}</span>
                <span className="del">−{session.diffStat.removed}</span>
              </span>
            ) : (
              <>
                <FileDiff className="sm" />
                Changes
              </>
            )}
          </button>
        </span>
        <ContextChip session={session} anchor={anchors.context} expanded={details === 'context'} onClick={() => toggleDetails('context')} />
        <IssueChip session={session} project={project} open={popover?.kind === 'issue'} onPopover={onPopover} onShow={onShowIssue} onError={onError} />
      </div>
    </>
  );
}

/** A diff stat's file count: "1 file", "4 files". */
function filesText(stat: DiffStat): string {
  return `${stat.files} ${stat.files === 1 ? 'file' : 'files'}`;
}

/** The spoken form of a diff stat, e.g. "4 files, 1210 added, 3 removed", or "no changes". */
function diffStatLabel(stat: DiffStat): string {
  if (stat.files === 0) return 'no changes';
  return `${filesText(stat)}, ${stat.added} added, ${stat.removed} removed`;
}

/** The context meter, its tokens, Reported cost and Working time in its tooltip; it opens Session details. */
function ContextChip({ session, anchor, expanded, onClick }: { session: Session; anchor: RefObject<HTMLButtonElement | null>; expanded: boolean; onClick: () => void }) {
  const { context, usage } = session;
  const percent = context ? contextPercent(context) : undefined;
  const tip = [
    context ? `Context ${percent}%: ${formatTokens(context.used)} of ${formatTokens(context.size)} tokens` : 'Context not reported yet',
    `${formatTokens(usage?.tokens ?? 0)} tokens · ${formatCost(usage?.reportedCost ?? 0)} so far · ${formatDuration(workingMs(session, Date.now()))} working`,
  ].join('\n');
  return (
    <span className="g-chip">
      <button ref={anchor} type="button" title={tip} aria-label={context ? `Context ${percent}% used` : 'Context not reported yet'} aria-description={tip} aria-haspopup="dialog" aria-expanded={expanded} onClick={onClick}>
        <Gauge className="sm" />
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${percent ?? 0}%` }} />
        </span>
        <span className="tech">{percent === undefined ? '–' : `${percent}%`}</span>
      </button>
    </span>
  );
}

/** The linked issue, showing its Panel; or, while one can be linked, Link issue. */
function IssueChip({
  session,
  project,
  open,
  onPopover,
  onShow,
  onError,
}: {
  session: Session;
  project: Project | undefined;
  open: boolean;
  onPopover: (popover: HeaderPopover | undefined) => void;
  onShow: () => void;
  onError: (message: string | undefined) => void;
}) {
  const api = useApi();
  const trigger = useRef<HTMLButtonElement>(null);
  const { issue } = session;
  if (issue) {
    return (
      <span className="g-chip">
        <button type="button" title={`Issue #${issue.number}`} aria-controls="session-side" onClick={onShow}>
          <CircleDot className="sm" />
          <span className="tech">#{issue.number}</span>
        </button>
      </span>
    );
  }
  if (!project || !canActOnForge(session, project)) return null;
  const link = ({ number, url }: ForgeLink) => attempt(onError, () => api.invoke('sessions.linkIssue', { id: session.id, issue: { number, url } }));
  return (
    <span className="g-chip quiet">
      <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => onPopover(open ? undefined : { kind: 'issue' })}>
        <CircleDot className="sm" />
        Link issue
      </button>
      {open && <IssueSearch project={project} anchor={trigger} onPick={link} onClose={() => onPopover(undefined)} />}
    </span>
  );
}

/** How the Merge request's CI is going, in a word or two, as an icon and its tone. */
const CI_LOOKS: Record<BabysitCi, { label: string; icon: ReactNode; tone: string }> = {
  passed: { label: 'CI passed', icon: <CircleCheck className="sm" />, tone: 'tone-passed' },
  failed: { label: 'CI failed', icon: <CircleX className="sm" />, tone: 'tone-failed' },
  pending: { label: 'CI running', icon: <Clock className="sm" />, tone: 'tone-pending' },
};

const CI_HEADINGS: Record<BabysitCi, string> = { passed: 'All checks have passed', failed: 'Some checks failed', pending: 'Checks are running' };

/**
 * The Merge request chip: its number (and state once merged or closed),
 * showing the Merge request Panel, then how its CI is going, opening its
 * checks, then how many reviews or comments others left, showing them in the
 * Panel. With none linked, it shows the Panel to create or link one, where
 * the Session can act on its Forge.
 */
function MergeRequestChip({
  session,
  project,
  popover,
  onPopover,
  onShow,
  onError,
}: {
  session: Session;
  project: Project | undefined;
  popover: HeaderPopover | undefined;
  onPopover: (popover: HeaderPopover | undefined) => void;
  onShow: (at?: 'reviews') => void;
  onError: (message: string | undefined) => void;
}) {
  const ciTrigger = useRef<HTMLButtonElement>(null);
  const { mergeRequest, mergeRequestState: state } = session;
  if (!mergeRequest && !canActOnForge(session, project)) return null;
  const ref = mergeRequest && mergeRequestRef(project?.forge.kind, mergeRequest.number);
  const ended = state === 'merged' || state === 'closed' ? ENDED_LOOKS[state] : undefined;
  const { ci, checks = [], reviews } = session.babysit ?? {};
  const showsCi = mergeRequest && !ended && (ci !== undefined || checks.length > 0);
  const ciLook = ci ? CI_LOOKS[ci] : { label: 'Checks', icon: <CircleMinus className="sm" />, tone: 'muted' };
  const discussed = mergeRequest && !ended && reviews && (reviews.reviews || reviews.comments) ? reviews : undefined;
  const discussion = discussed && (discussed.reviews ? countText(discussed.reviews, 'review') : countText(discussed.comments, 'comment'));
  return (
    <span className={mergeRequest ? 'g-chip' : 'g-chip quiet'}>
      <button type="button" title={ref ? `Merge request ${ref}` : 'No Merge request yet'} aria-label={ref ? `Merge request ${ref}` : 'No Merge request yet'} aria-controls="session-side" onClick={() => onShow()}>
        {mergeRequest ? (
          <>
            {ended ? <span className={ended.tone}>{ended.icon}</span> : <GitPullRequest className="sm" />}
            <span className="tech">{ref}</span>
            {ended && <span className={ended.tone}>{ended.label}</span>}
          </>
        ) : (
          <>
            <GitPullRequestCreate className="sm" />
            Merge request
          </>
        )}
      </button>
      {showsCi && (
        <button ref={ciTrigger} type="button" title={session.babysit?.stale ? `${ciLook.label} (may be out of date)` : ciLook.label} aria-haspopup="dialog" aria-expanded={popover?.kind === 'checks'} onClick={() => onPopover(popover?.kind === 'checks' ? undefined : { kind: 'checks' })}>
          <span className={`row ${ciLook.tone}`}>
            {ciLook.icon}
            {ciLook.label}
          </span>
        </button>
      )}
      {discussed && (
        <button type="button" title={discussed.changesRequested ? `${discussion}, changes requested` : discussion} aria-label={`${discussion}${discussed.changesRequested ? ', changes requested' : ''}: show them`} aria-controls="session-side" onClick={() => onShow('reviews')}>
          <span className={discussed.changesRequested ? 'row tone-pending' : 'row'}>
            <MessageSquare className="sm" />
            {discussion}
          </span>
        </button>
      )}
      {popover?.kind === 'checks' && showsCi && <ChecksPopover session={session} anchor={ciTrigger} onClose={() => onPopover(undefined)} onError={onError} />}
    </span>
  );
}

/** The Merge request's checks, as Babysit last saw them. */
function ChecksPopover({ session, anchor, onClose, onError }: { session: Session; anchor: RefObject<HTMLElement | null>; onClose: () => void; onError: (message: string | undefined) => void }) {
  const api = useApi();
  const dates = useDates();
  const { ci, checks = [], lastPollAt } = session.babysit ?? {};
  const heading = ci ? CI_HEADINGS[ci] : 'No CI checks';
  const empty = session.babysitOff ? "Loom isn't watching this Merge request, so it can't say how its CI is going." : "Loom hasn't seen any checks on this Merge request.";
  const open = (url: string) => attempt(onError, () => api.invoke('links.open', { url }));
  return (
    <Popover anchor={anchor} role="dialog" label="CI checks" className="ci-checks" onClose={onClose}>
      <h4 tabIndex={-1} data-autofocus>
        {heading}
      </h4>
      <p className="muted">{checks.length ? checksSummary(checks) : empty}</p>
      {checks.length > 0 && (
        <ul>
          {checks.map((check, at) => (
            <li key={at}>
              {CHECK_STATES[check.state].icon}
              <span className="name tech">{check.name}</span>
              <span className="muted">{CHECK_STATES[check.state].label}</span>
              {check.url && (
                <button type="button" className="link" onClick={() => open(check.url!)}>
                  Details
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {lastPollAt !== undefined && <p className="muted checked">{`Checked ${dates.time(lastPollAt)}`}</p>}
    </Popover>
  );
}
