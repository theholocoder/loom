// The sidebar's Session info view: the open Session's details, which may
// change while it runs, each with the actions that go with it, in four fixed
// groups: Where, Git, Agent and Usage. An archived Session's are read-only.
import { Archive, Bot, BotOff, Check, CircleCheck, CircleDot, CircleMinus, CircleX, Clock, CodeXml, Copy, ExternalLink, Eye, EyeOff, FileDiff, GitMerge, GitPullRequest, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestCreate, Link, SquareTerminal, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { mergeRequestRef, type BabysitCheck, type BabysitCheckState, type BabysitCi, type DiffStat, type EnvironmentStatus, type MergeRequestState, type Project, type Session } from '../shared/api';
import { useApi, useTopic } from './api';
import { RemovedTag, useRemovedProject } from './Archive';
import { formatCost, formatDuration, formatTokens } from './Dashboard';
import { Popover } from './Popover';
import { baseName, copyable } from './ContextMenu';

/** A diff stat's file count: "1 file", "4 files". */
function filesText(stat: DiffStat): string {
  return `${stat.files} ${stat.files === 1 ? 'file' : 'files'}`;
}

/** The spoken form of a diff stat, e.g. "4 files, 1210 added, 3 removed". */
function diffStatLabel(stat: DiffStat): string {
  return `${filesText(stat)}, ${stat.added} added, ${stat.removed} removed`;
}

/** Whole numbers with thousands separators: 12,345. */
const wholeNumber = new Intl.NumberFormat('en');

/**
 * The Session's details in their four groups, with their actions; an
 * archived Session's without editor, terminal, Archive or Merge request
 * actions (Delete stays), and one whose worktree is missing without editor or terminal. `linking` opens the Link Merge request popover, as the palette asks;
 * `onLinkingChange` says when it opens or closes. What goes wrong running
 * an action goes to `onError`.
 */
export function SessionInfo({
  session,
  project,
  linking,
  onLinkingChange,
  onShowChanges,
  onArchive,
  onDelete,
  onError,
}: {
  session: Session;
  project: Project | undefined;
  linking: boolean;
  onLinkingChange: (linking: boolean) => void;
  onShowChanges: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onError: (message: string | undefined) => void;
}) {
  const api = useApi();
  const environment = useTopic('environments')?.find((e) => e.id === project?.checkout.environmentId);
  const removedProject = useRemovedProject(session.projectId);
  const archived = session.status === 'archived';
  // A missing worktree has no folder to open.
  const openable = !archived && !session.worktreeMissing;
  const run = (command: 'sessions.openInEditor' | 'sessions.openInTerminal' | 'sessions.requestMergeRequest') => {
    onError(undefined);
    api.invoke(command, { id: session.id }).catch((e: unknown) => onError((e as Error).message));
  };
  const open = (url: string) => void api.invoke('links.open', { url }).catch((e: unknown) => onError((e as Error).message));
  const setWatching = (on: boolean) => {
    onError(undefined);
    api.invoke('sessions.setBabysitting', { id: session.id, on }).catch((e: unknown) => onError((e as Error).message));
  };
  const setAutoPrompt = (on: boolean) => {
    onError(undefined);
    api.invoke('sessions.setAutoPrompt', { id: session.id, on }).catch((e: unknown) => onError((e as Error).message));
  };
  const model = session.model ?? session.agentConfig?.model;
  const effort = session.effort ?? session.agentConfig?.effort;
  const queued = session.queue?.length ?? 0;

  return (
    <div className="info">
      <Group label="Where">
        <Fact label="Project">
          {project?.name ?? removedProject?.name ?? 'Unknown'}
          {removedProject && <RemovedTag />}
          {project?.forge.repository && <span className="tech muted">{project.forge.repository}</span>}
        </Fact>
        <Fact label="Environment">{environmentText(environment)}</Fact>
        <Fact
          label="Working copy"
          actions={
            openable && (
              <>
                <IconAction label="Open in editor" icon={<CodeXml />} onClick={() => run('sessions.openInEditor')} />
                <IconAction label="Open in terminal" icon={<SquareTerminal />} onClick={() => run('sessions.openInTerminal')} />
              </>
            )
          }
        >
          <span className="chip">{session.workingCopy.kind}</span>
        </Fact>
        <Fact label="Path" actions={<CopyAction text={session.workingCopy.path} label="Copy path" />}>
          <span className="tech path" {...copyable(session.workingCopy.kind === 'worktree' ? 'worktree path' : 'path', session.workingCopy.path)}>
            {session.workingCopy.kind === 'worktree' ? <span {...copyable('worktree name', baseName(session.workingCopy.path))}>{session.workingCopy.path}</span> : session.workingCopy.path}
          </span>
        </Fact>
      </Group>
      <Group label="Git">
        <Fact label="Branch">{session.branch ? <span className="tech" {...copyable('branch name', session.branch)}>{session.branch}</span> : <span className="muted">Not known yet</span>}</Fact>
        <Fact label="Issue">
          {session.issue ? (
            <button type="button" className="link tech" title={`Open issue #${session.issue.number}`} onClick={() => open(session.issue!.url)}>
              <CircleDot className="sm" />#{session.issue.number}
            </button>
          ) : (
            <span className="muted">None</span>
          )}
        </Fact>
        <MergeRequestFact session={session} project={project} linking={linking} onLinkingChange={onLinkingChange} onOpen={open} onAsk={() => run('sessions.requestMergeRequest')} onAutoPrompt={setAutoPrompt} onWatch={setWatching} />
        <Fact label="Changes">
          {session.diffStat ? (
            <button type="button" className="link diff-stat" aria-label={`Show changes: ${diffStatLabel(session.diffStat)}`} onClick={onShowChanges}>
              <FileDiff className="sm" />
              <span className="files">{filesText(session.diffStat)}</span>
              <span className="add">+{session.diffStat.added}</span>
              <span className="del">−{session.diffStat.removed}</span>
            </button>
          ) : (
            <button type="button" className="link" onClick={onShowChanges}>
              Show changes
            </button>
          )}
        </Fact>
      </Group>
      <Group label="Agent">
        <Fact label="Agent">{session.agent}</Fact>
        <Fact label="Model">{model ? <span className="tech">{model}</span> : <span className="muted">The agent's default</span>}</Fact>
        <Fact label="Effort">{effort ? <span className="tech">{effort}</span> : <span className="muted">Default</span>}</Fact>
        <Fact label="Agent session" actions={session.agentSessionId && <CopyAction text={session.agentSessionId} label="Copy agent session id" />}>
          {session.agentSessionId ? <span className="tech path">{session.agentSessionId}</span> : <span className="muted">Not started yet</span>}
        </Fact>
        <Fact label="Queued messages">{wholeNumber.format(queued)}</Fact>
      </Group>
      <Group label="Usage">
        <Fact label="Context">
          {session.context ? <ContextBar used={session.context.used} size={session.context.size} /> : <span className="muted">Not reported yet</span>}
        </Fact>
        <Fact label="Tokens">{formatTokens(session.usage?.tokens ?? 0)}</Fact>
        <Fact label="Reported cost">{formatCost(session.usage?.reportedCost ?? 0)}</Fact>
        <Fact label="Working time">
          <WorkingTime session={session} />
        </Fact>
      </Group>
      <div className="info-foot">
        {!archived && (
          <button type="button" onClick={onArchive}>
            <Archive className="sm" />
            Archive
          </button>
        )}
        <button type="button" onClick={onDelete}>
          <Trash2 className="sm" />
          Delete
        </button>
      </div>
    </div>
  );
}

/** The native Environment by its OS, a WSL one by its distro (its label). */
function environmentText(environment: EnvironmentStatus | undefined): string {
  if (!environment) return 'Unknown';
  const os = environment.bridge?.os;
  return environment.id === 'native' && os ? `${environment.label} (${osName(os)})` : environment.label;
}

function osName(os: string): string {
  return ({ linux: 'Linux', darwin: 'macOS', windows: 'Windows' } as Record<string, string>)[os] ?? os;
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="info-group" aria-label={label}>
      <h3>{label}</h3>
      <dl>{children}</dl>
    </section>
  );
}

/** A fact, by its name, with the actions that go with it at the end. */
function Fact({ label, actions, children }: { label: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>
        <span className="value">{children}</span>
        {actions ? <span className="fact-actions">{actions}</span> : null}
      </dd>
    </div>
  );
}

/** An icon button for a fact; `expanded` makes it open a dialog, `buttonRef` anchors that dialog. */
function IconAction({ label, icon, onClick, buttonRef, expanded, className }: { label: string; icon: ReactNode; onClick: () => void; buttonRef?: RefObject<HTMLButtonElement | null>; expanded?: boolean; className?: string }) {
  return (
    <button
      ref={buttonRef}
      className={['icon-btn sm', className].filter(Boolean).join(' ')}
      type="button"
      title={label}
      aria-label={label}
      {...(expanded !== undefined && { 'aria-haspopup': 'dialog' as const, 'aria-expanded': expanded })}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

/** Puts `text` on the clipboard, saying how that went for a moment. */
function CopyAction({ text, label }: { text: string; label: string }) {
  const [outcome, setOutcome] = useState<'copied' | 'failed'>();
  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(undefined), 1500);
    return () => clearTimeout(timer);
  }, [outcome]);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setOutcome('copied'),
      () => setOutcome('failed'),
    );
  };
  const said = outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : label;
  return <IconAction label={said} icon={outcome === 'copied' ? <Check /> : outcome === 'failed' ? <TriangleAlert /> : <Copy />} onClick={copy} />;
}

/**
 * The Merge request's number and state, opening it; asking the agent to open
 * or update it (a prompt shortcut), Link Merge request, and the auto-prompt
 * toggle. These need a Session that can take a prompt, on a Project whose
 * Forge is on.
 */
function MergeRequestFact({
  session,
  project,
  linking,
  onLinkingChange,
  onOpen,
  onAsk,
  onAutoPrompt,
  onWatch,
}: {
  session: Session;
  project: Project | undefined;
  linking: boolean;
  onLinkingChange: (linking: boolean) => void;
  onOpen: (url: string) => void;
  onAsk: () => void;
  onAutoPrompt: (on: boolean) => void;
  onWatch: (on: boolean) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const canAct = session.status !== 'archived' && !session.worktreeMissing && project?.forge.state === 'available';
  const { mergeRequest } = session;
  const ref = mergeRequest && mergeRequestRef(project?.forge.kind, mergeRequest.number);
  // Only an open one can be watched: the eye says so, and switches it.
  const watchable = session.status !== 'archived' && project?.forge.state === 'available' && session.mergeRequestState === 'open';
  const watching = !session.babysitOff;
  return (
    <Fact
      label="Merge request"
      actions={
        canAct && (
          <>
            <SwitchAction
              on={!!session.autoPrompt}
              label={!watching ? 'Auto-prompt needs this Merge request to be watched' : session.autoPrompt ? 'Auto-prompt on: feedback goes straight to the agent. Click to turn off' : 'Auto-prompt off: feedback waits for you. Click to turn on'}
              onIcon={<Bot />}
              offIcon={<BotOff />}
              onClassName="tone-accent"
              disabled={!watching}
              onSwitch={onAutoPrompt}
            />
            {mergeRequest ? (
              <IconAction label="Update Merge request" icon={<GitPullRequestArrow />} onClick={onAsk} />
            ) : (
              <IconAction label="Create Merge request" icon={<GitPullRequestCreate />} onClick={onAsk} />
            )}
            <IconAction label="Link Merge request" icon={<Link />} buttonRef={trigger} expanded={linking} onClick={() => onLinkingChange(!linking)} />
            {linking && <LinkMergeRequest session={session} anchor={trigger} onClose={() => onLinkingChange(false)} />}
          </>
        )
      }
    >
      {mergeRequest && ref ? (
        <>
          <button type="button" className="link tech" title={`Open Merge request ${ref}`} aria-label={`Open Merge request ${ref}`} onClick={() => onOpen(mergeRequest.url)}>
            {ref}
            <ExternalLink className="sm" />
          </button>
          {watchable && <SwitchAction on={watching} label={watching ? `Watching ${ref}, click to stop` : `Not watching ${ref}, click to watch`} onIcon={<Eye />} offIcon={<EyeOff />} onSwitch={onWatch} />}
          {session.mergeRequestState && <MergeRequestStatus state={session.mergeRequestState} session={session} onOpen={onOpen} />}
          {session.babysit?.stale && (
            <span className="chip stale" title="Loom couldn't reach the Forge on its last check: this may be out of date.">
              Stale
            </span>
          )}
        </>
      ) : (
        <span className="muted">None</span>
      )}
    </Fact>
  );
}

/** An icon that shows a setting and switches it. Hovered, it shows what a click will do; once clicked, what it did. */
function SwitchAction({ on, label, onIcon, offIcon, onClassName, disabled, onSwitch }: { on: boolean; label: string; onIcon: ReactNode; offIcon: ReactNode; onClassName?: string; disabled?: boolean; onSwitch: (on: boolean) => void }) {
  const [previewing, setPreviewing] = useState(false);
  const shown = previewing && !disabled ? !on : on;
  return (
    <button
      className={['icon-btn sm', shown ? onClassName : undefined].filter(Boolean).join(' ')}
      type="button"
      disabled={disabled}
      title={label}
      aria-label={label}
      onMouseEnter={() => setPreviewing(true)}
      onMouseLeave={() => setPreviewing(false)}
      onClick={() => {
        setPreviewing(false);
        onSwitch(!on);
      }}
    >
      {shown ? onIcon : offIcon}
    </button>
  );
}

const CHECK_STATES: Record<BabysitCheckState, { label: string; icon: ReactNode }> = {
  passed: { label: 'Passed', icon: <CircleCheck className="sm tone-passed" /> },
  failed: { label: 'Failed', icon: <CircleX className="sm tone-failed" /> },
  pending: { label: 'Pending', icon: <Clock className="sm tone-pending" /> },
  'not-run': { label: 'Not run', icon: <CircleMinus className="sm muted" /> },
};

/** What sums up a Merge request in one icon: merged or closed, or else how its CI is going. */
function statusLook(state: MergeRequestState, ci: BabysitCi | undefined): { label: string; icon: ReactNode; tone?: string } {
  if (state === 'merged') return { label: 'Merge request merged', icon: <GitMerge />, tone: 'tone-accent' };
  if (state === 'closed') return { label: 'Merge request closed', icon: <GitPullRequestClosed />, tone: 'tone-failed' };
  if (ci === 'passed') return { label: 'Merge request open, CI passed', icon: <CircleCheck />, tone: 'tone-passed' };
  if (ci === 'failed') return { label: 'Merge request open, CI failed', icon: <CircleX />, tone: 'tone-failed' };
  if (ci === 'pending') return { label: 'Merge request open, CI pending', icon: <Clock />, tone: 'tone-pending' };
  return { label: 'Merge request open', icon: <GitPullRequest /> };
}

const CI_HEADINGS: Record<BabysitCi, string> = { passed: 'All checks have passed', failed: 'Some checks failed', pending: 'Checks are running' };

/** "1 failed, 5 passed": the checks by state, the ones needing attention first. */
function checksSummary(checks: BabysitCheck[]): string {
  const order: BabysitCheckState[] = ['failed', 'passed', 'pending', 'not-run'];
  return order.flatMap((state) => {
    const count = checks.filter((check) => check.state === state).length;
    return count ? [`${count} ${CHECK_STATES[state].label.toLowerCase()}`] : [];
  }).join(', ');
}

/** The Merge request's state and CI as one icon, which opens the list of its checks. */
function MergeRequestStatus({ state, session, onOpen }: { state: MergeRequestState; session: Session; onOpen: (url: string) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [listing, setListing] = useState(false);
  const { ci, checks = [], lastPollAt } = session.babysit ?? {};
  const { label, icon, tone } = statusLook(state, ci);
  const heading = state === 'merged' ? 'Merged' : state === 'closed' ? 'Closed' : ci ? CI_HEADINGS[ci] : 'No CI checks';
  const empty = session.babysitOff ? "Loom isn't watching this Merge request, so it can't say how its CI is going." : "Loom hasn't seen any checks on this Merge request.";
  return (
    <>
      <IconAction label={label} icon={icon} className={tone} buttonRef={trigger} expanded={listing} onClick={() => setListing(!listing)} />
      {listing && (
        <Popover anchor={trigger} role="dialog" label="CI checks" className="ci-checks" onClose={() => setListing(false)}>
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
                    <button type="button" className="link" onClick={() => onOpen(check.url!)}>
                      Details
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {lastPollAt !== undefined && <p className="muted checked">{`Checked ${new Date(lastPollAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</p>}
        </Popover>
      )}
    </>
  );
}

/** A number or URL to link, checked on the Forge; what went wrong shows in the popover. */
function LinkMergeRequest({ session, anchor, onClose }: { session: Session; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
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
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinking(false);
    }
  };
  return (
    <Popover anchor={anchor} role="dialog" label="Link Merge request" className="link-mr" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          <span>Merge request number or URL</span>
          <input data-autofocus aria-label="Merge request number or URL" className="tech" placeholder="12, or its URL" value={value} onChange={(event) => setValue(event.target.value)} />
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
    </Popover>
  );
}

/** Context used against its size, as words and a bar. */
function ContextBar({ used, size }: { used: number; size: number }) {
  const percent = size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0;
  return (
    <span className="context">
      <span>
        {formatTokens(used)} / {formatTokens(size)} <span className="muted">({percent}%)</span>
      </span>
      <span className="bar" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} title={`${wholeNumber.format(used)} of ${wholeNumber.format(size)} tokens`}>
        <span style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

/** The Session's Working time, counting up each second while it runs. */
function WorkingTime({ session }: { session: Session }) {
  const since = session.status === 'working' ? session.usage?.workingSince : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const ms = (session.usage?.workingMs ?? 0) + (since === undefined ? 0 : Math.max(0, now - since));
  return <>{formatDuration(ms)}</>;
}
