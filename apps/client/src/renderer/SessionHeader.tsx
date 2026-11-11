// The open Session's header and Glance strip (docs/prototypes/side-panels.html,
// layer A). The header is one line: its title (opening Session details), its
// Project, its status, then the Side area and Dock icons and the ⋯ menu. The
// Glance strip under it shows what is changing right now, each chip opening
// its detail: the branch, the Merge request and its checks, the changes, the
// context used and the issue.
import {
  Bot,
  CircleCheck,
  CircleDot,
  CircleMinus,
  CircleX,
  Clock,
  CodeXml,
  Copy,
  Ellipsis,
  ExternalLink,
  Eye,
  FileDiff,
  Gauge,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestCreate,
  Info,
  Link,
  PanelBottom,
  PanelRight,
  SquareTerminal,
} from 'lucide-react';
import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { mergeRequestRef, type BabysitCheck, type BabysitCheckState, type BabysitCi, type DiffStat, type MergeRequestState, type Project, type RemovedProject, type Session } from '../shared/api';
import { useApi } from './api';
import { ProjectRemoved, WorktreeMissing } from './Archive';
import { copyable, copyText, MenuButtonMenu, type ContextMenuSection } from './ContextMenu';
import { formatCost, formatDuration, formatTokens } from './Dashboard';
import { IssueSearch } from './IssuePicker';
import { Popover } from './Popover';
import { projectColor } from './ProjectAvatar';
import { contextPercent, SessionDetails, workingMs } from './SessionDetails';
import type { SessionMenu } from './SessionMenu';

/** Where Session details opens from: the title, the branch chip, the context meter or the ⋯ menu. */
export type DetailsAnchor = 'title' | 'branch' | 'context' | 'menu';

/** The header's one popover open at a time, if any. */
export type HeaderPopover =
  | { kind: 'details'; from: DetailsAnchor }
  | { kind: 'merge-request'; linking?: boolean }
  | { kind: 'checks' }
  | { kind: 'issue' }
  | { kind: 'menu' };

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
  // A missing worktree has no folder to open.
  const openable = session.status !== 'archived' && !session.worktreeMissing;
  const run = (command: 'sessions.openInEditor' | 'sessions.openInTerminal') => {
    onError(undefined);
    api.invoke(command, { id: session.id }).catch((e: unknown) => onError((e as Error).message));
  };
  const menuSections = (): ContextMenuSection[] => [
    [
      { label: 'Session details…', icon: Info, run: () => onPopover({ kind: 'details', from: 'menu' }) },
      { label: 'Open in editor', icon: CodeXml, disabled: !openable, run: () => run('sessions.openInEditor') },
      { label: 'Open in terminal', icon: SquareTerminal, disabled: !openable, run: () => run('sessions.openInTerminal') },
      { label: 'Copy branch name', icon: Copy, disabled: !session.branch, run: () => session.branch && copyText(session.branch) },
    ],
    ...menu.sections(),
  ];
  const projectName = project?.name ?? removedProject?.name;

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
          {projectName && (
            <span className="proj-tag" title="Project" style={project ? { color: projectColor(project), background: `color-mix(in srgb, ${projectColor(project)} 16%, transparent)` } : undefined}>
              {projectName}
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
        <MergeRequestChip session={session} project={project} popover={popover} onPopover={onPopover} onError={onError} />
        <span className="g-chip">
          <button type="button" title="Show Changes" aria-label={session.diffStat ? `Show changes: ${diffStatLabel(session.diffStat)}` : 'Show changes'} onClick={onShowChanges}>
            {session.diffStat ? (
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
        <IssueChip session={session} project={project} open={popover?.kind === 'issue'} onPopover={onPopover} onError={onError} />
      </div>
    </>
  );
}

/** A diff stat's file count: "1 file", "4 files". */
function filesText(stat: DiffStat): string {
  return `${stat.files} ${stat.files === 1 ? 'file' : 'files'}`;
}

/** The spoken form of a diff stat, e.g. "4 files, 1210 added, 3 removed". */
function diffStatLabel(stat: DiffStat): string {
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

/** The linked issue, opening it; or, while one can be linked, Link issue. */
function IssueChip({ session, project, open, onPopover, onError }: { session: Session; project: Project | undefined; open: boolean; onPopover: (popover: HeaderPopover | undefined) => void; onError: (message: string | undefined) => void }) {
  const api = useApi();
  const trigger = useRef<HTMLButtonElement>(null);
  const { issue } = session;
  if (issue) {
    return (
      <span className="g-chip">
        <button type="button" title={`Open issue #${issue.number}`} onClick={() => void api.invoke('links.open', { url: issue.url }).catch((e: unknown) => onError((e as Error).message))}>
          <CircleDot className="sm" />
          <span className="tech">#{issue.number}</span>
        </button>
      </span>
    );
  }
  if (!project || project.forge.state !== 'available' || session.status === 'archived') return null;
  const link = (picked: { number: number; url: string }) => {
    onError(undefined);
    api.invoke('sessions.linkIssue', { id: session.id, issue: { number: picked.number, url: picked.url } }).catch((e: unknown) => onError((e as Error).message));
  };
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

const CHECK_STATES: Record<BabysitCheckState, { label: string; icon: ReactNode }> = {
  passed: { label: 'Passed', icon: <CircleCheck className="sm tone-passed" /> },
  failed: { label: 'Failed', icon: <CircleX className="sm tone-failed" /> },
  pending: { label: 'Pending', icon: <Clock className="sm tone-pending" /> },
  'not-run': { label: 'Not run', icon: <CircleMinus className="sm muted" /> },
};

/** How the Merge request's CI is going, in a word or two, as an icon and its tone. */
const CI_LOOKS: Record<BabysitCi, { label: string; icon: ReactNode; tone: string }> = {
  passed: { label: 'CI passed', icon: <CircleCheck className="sm" />, tone: 'tone-passed' },
  failed: { label: 'CI failed', icon: <CircleX className="sm" />, tone: 'tone-failed' },
  pending: { label: 'CI running', icon: <Clock className="sm" />, tone: 'tone-pending' },
};

const CI_HEADINGS: Record<BabysitCi, string> = { passed: 'All checks have passed', failed: 'Some checks failed', pending: 'Checks are running' };

/** A merged or closed Merge request's state, as a word, an icon and its tone. */
const ENDED_LOOKS: Record<Exclude<MergeRequestState, 'open'>, { label: string; icon: ReactNode; tone: string }> = {
  merged: { label: 'Merged', icon: <GitMerge className="sm" />, tone: 'tone-accent' },
  closed: { label: 'Closed', icon: <GitPullRequestClosed className="sm" />, tone: 'tone-failed' },
};

/** "1 failed, 5 passed": the checks by state, the ones needing attention first. */
function checksSummary(checks: BabysitCheck[]): string {
  const order: BabysitCheckState[] = ['failed', 'passed', 'pending', 'not-run'];
  return order
    .flatMap((state) => {
      const count = checks.filter((check) => check.state === state).length;
      return count ? [`${count} ${CHECK_STATES[state].label.toLowerCase()}`] : [];
    })
    .join(', ');
}

/**
 * The Merge request chip: its number (and state once merged or closed),
 * opening the Merge request popover, then how its CI is going, opening its
 * checks. With none linked, it offers to create or link one, where the
 * Session can act on its Forge.
 */
function MergeRequestChip({ session, project, popover, onPopover, onError }: { session: Session; project: Project | undefined; popover: HeaderPopover | undefined; onPopover: (popover: HeaderPopover | undefined) => void; onError: (message: string | undefined) => void }) {
  const mrTrigger = useRef<HTMLButtonElement>(null);
  const ciTrigger = useRef<HTMLButtonElement>(null);
  const { mergeRequest, mergeRequestState: state } = session;
  const canAct = session.status !== 'archived' && !session.worktreeMissing && project?.forge.state === 'available';
  if (!mergeRequest && !canAct) return null;
  const ref = mergeRequest && mergeRequestRef(project?.forge.kind, mergeRequest.number);
  const ended = state === 'merged' || state === 'closed' ? ENDED_LOOKS[state] : undefined;
  const { ci, checks = [] } = session.babysit ?? {};
  const showsCi = mergeRequest && !ended && (ci !== undefined || checks.length > 0);
  const ciLook = ci ? CI_LOOKS[ci] : { label: 'Checks', icon: <CircleMinus className="sm" />, tone: 'muted' };
  const open = popover?.kind === 'merge-request';
  return (
    <span className={mergeRequest ? 'g-chip' : 'g-chip quiet'}>
      <button ref={mrTrigger} type="button" title={ref ? `Merge request ${ref}` : 'No Merge request yet'} aria-label={ref ? `Merge request ${ref}` : 'No Merge request yet'} aria-haspopup="dialog" aria-expanded={open} onClick={() => onPopover(open ? undefined : { kind: 'merge-request' })}>
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
      {open && <MergeRequestPopover session={session} project={project} anchor={mrTrigger} linking={!!popover.linking} onLinking={(linking) => onPopover({ kind: 'merge-request', linking })} onClose={() => onPopover(undefined)} onError={onError} />}
      {popover?.kind === 'checks' && showsCi && <ChecksPopover session={session} anchor={ciTrigger} onClose={() => onPopover(undefined)} onError={onError} />}
    </span>
  );
}

/**
 * The Merge request, until its own Panel (#131): open it on the Forge, and,
 * where the Session can act on its Forge, the Watch and Auto-prompt
 * switches, asking the agent to create or update it, and linking one by hand.
 */
function MergeRequestPopover({
  session,
  project,
  anchor,
  linking,
  onLinking,
  onClose,
  onError,
}: {
  session: Session;
  project: Project | undefined;
  anchor: RefObject<HTMLElement | null>;
  linking: boolean;
  onLinking: (linking: boolean) => void;
  onClose: () => void;
  onError: (message: string | undefined) => void;
}) {
  const api = useApi();
  const { mergeRequest, mergeRequestState: state } = session;
  const ref = mergeRequest && mergeRequestRef(project?.forge.kind, mergeRequest.number);
  const forgeOn = project?.forge.state === 'available';
  const canAct = session.status !== 'archived' && !session.worktreeMissing && forgeOn;
  // Only an open one can be watched.
  const watchable = session.status !== 'archived' && forgeOn && state === 'open';
  const watching = !session.babysitOff;
  const invoke = (run: () => Promise<unknown>) => {
    onError(undefined);
    run().catch((e: unknown) => onError((e as Error).message));
  };
  const ask = () => {
    onClose();
    invoke(() => api.invoke('sessions.requestMergeRequest', { id: session.id }));
  };
  return (
    <Popover anchor={anchor} role="dialog" label="Merge request" className="mr-popover" onClose={onClose}>
      <h4 tabIndex={-1} data-autofocus={linking ? undefined : true}>
        {ref ? (
          <>
            Merge request <span className="tech">{ref}</span>
          </>
        ) : (
          'No Merge request yet'
        )}
        {state && <span className="chip">{state === 'open' ? 'Open' : ENDED_LOOKS[state].label}</span>}
        {session.babysit?.stale && (
          <span className="chip stale" title="Loom couldn't reach the Forge on its last check: this may be out of date.">
            Stale
          </span>
        )}
      </h4>
      {mergeRequest && ref && (
        <button type="button" onClick={() => invoke(() => api.invoke('links.open', { url: mergeRequest.url }))}>
          <ExternalLink className="sm" />
          Open {ref}
        </button>
      )}
      {(watchable || canAct) && (
        <div className="switches">
          {watchable && <Switch label="Watch" icon={<Eye className="sm" />} on={watching} hint={watching ? `Babysit watches ${ref} for new feedback.` : `Loom isn't watching ${ref}.`} onSwitch={(on) => invoke(() => api.invoke('sessions.setBabysitting', { id: session.id, on }))} />}
          {canAct && (
            <Switch
              label="Auto-prompt"
              icon={<Bot className="sm" />}
              on={!!session.autoPrompt}
              disabled={!watching}
              hint={!watching ? 'Auto-prompt needs this Merge request to be watched.' : session.autoPrompt ? 'Feedback goes straight to the agent.' : 'Feedback waits for you.'}
              onSwitch={(on) => invoke(() => api.invoke('sessions.setAutoPrompt', { id: session.id, on }))}
            />
          )}
        </div>
      )}
      {canAct && (
        <div className="acts">
          <button type="button" onClick={ask}>
            {mergeRequest ? <GitPullRequest className="sm" /> : <GitPullRequestCreate className="sm" />}
            {mergeRequest ? 'Update Merge request' : 'Create Merge request'}
          </button>
          <button type="button" aria-expanded={linking} onClick={() => onLinking(!linking)}>
            <Link className="sm" />
            Link Merge request…
          </button>
        </div>
      )}
      {canAct && linking && <LinkMergeRequestForm session={session} onLinked={onClose} />}
    </Popover>
  );
}

/** A labelled switch: its name, whether it is on, and what that means. */
function Switch({ label, icon, on, hint, disabled, onSwitch }: { label: string; icon: ReactNode; on: boolean; hint: string; disabled?: boolean; onSwitch: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={on} aria-description={hint} title={hint} disabled={disabled} onClick={() => onSwitch(!on)}>
      {icon}
      <span className="grow">{label}</span>
      <span className="track" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

/** A number or URL to link, checked on the Forge; what went wrong shows under it. */
function LinkMergeRequestForm({ session, onLinked }: { session: Session; onLinked: () => void }) {
  const api = useApi();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [linking, setLinking] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || linking) return;
    setLinking(true);
    setError(undefined);
    try {
      await api.invoke('sessions.linkMergeRequest', { id: session.id, mergeRequest: value.trim() });
      onLinked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinking(false);
    }
  };
  return (
    <form className="link-mr" aria-label="Link Merge request" onSubmit={submit}>
      <label>
        <span>Merge request number or URL</span>
        <input autoFocus data-autofocus aria-label="Merge request number or URL" className="tech" placeholder="12, or its URL" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      <button className="primary" type="submit" disabled={!value.trim() || linking}>
        Link
      </button>
    </form>
  );
}

/** The Merge request's checks, as Babysit last saw them. */
function ChecksPopover({ session, anchor, onClose, onError }: { session: Session; anchor: RefObject<HTMLElement | null>; onClose: () => void; onError: (message: string | undefined) => void }) {
  const api = useApi();
  const { ci, checks = [], lastPollAt } = session.babysit ?? {};
  const heading = ci ? CI_HEADINGS[ci] : 'No CI checks';
  const empty = session.babysitOff ? "Loom isn't watching this Merge request, so it can't say how its CI is going." : "Loom hasn't seen any checks on this Merge request.";
  const open = (url: string) => {
    onError(undefined);
    api.invoke('links.open', { url }).catch((e: unknown) => onError((e as Error).message));
  };
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
      {lastPollAt !== undefined && <p className="muted checked">{`Checked ${new Date(lastPollAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</p>}
    </Popover>
  );
}
