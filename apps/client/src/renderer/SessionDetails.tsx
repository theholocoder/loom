// Session details: what rarely changes about the open Session (its Project,
// Environment, working copy, branch, agent and model) and its usage, in a
// popover opened from its title, its branch, its context meter or the ⋯ menu,
// rather than kept on screen. An archived Session's are read-only.
import { Check, CodeXml, Copy, Info, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { APPROVAL_MODES, modelNameIn, type EnvironmentStatus, type Project, type Session } from '../shared/api';
import { useApi, useTopic } from './api';
import { RemovedTag, useRemovedProject } from './Archive';
import { baseName, copyable } from './ContextMenu';
import { formatCost, formatDuration, formatTokens } from './Dashboard';
import { contextPercent, defaultModelOf, listedModels, ModelName } from './ModelPicker';
import { useSessionModels } from './checkout';
import { Popover } from './Popover';

/** Session details show whole, room allowing, rather than scroll like a menu. */
const DETAILS_MAX_HEIGHT = 640;

/** Whole numbers with thousands separators: 12,345. */
const wholeNumber = new Intl.NumberFormat('en');

/** Runs an action of the header's, clearing the last error first and reporting what goes wrong to `onError`. */
export function attempt(onError: (message: string | undefined) => void, run: () => Promise<unknown>): void {
  onError(undefined);
  run().catch((e: unknown) => onError((e as Error).message));
}

/** Whether the Session's working copy can be opened in the editor or a terminal: not archived, its worktree there. */
export function openable(session: Session): boolean {
  return session.status !== 'archived' && !session.worktreeMissing;
}

/** Break points after the `/ - _ .` of a path, branch or id, so that it wraps between its parts rather than mid-word. */
export function breakable(text: string): ReactNode {
  return text.split(/(?<=[/\-_.])/).flatMap((part, at) => (at === 0 ? [part] : [<wbr key={at} />, part]));
}

/**
 * The Session's details beside `anchor`, in three groups (Where, Agent and
 * Usage), each fact with the actions that go with it: no editor or terminal
 * for an archived Session or one whose worktree is missing. What goes wrong
 * running an action goes to `onError`.
 */
export function SessionDetails({ session, project, anchor, onClose, onError }: { session: Session; project: Project | undefined; anchor: RefObject<HTMLElement | null>; onClose: () => void; onError: (message: string | undefined) => void }) {
  const api = useApi();
  const environment = useTopic('environments')?.find((e) => e.id === project?.checkout.environmentId);
  const removedProject = useRemovedProject(session.projectId);
  const run = (command: 'sessions.openInEditor' | 'sessions.openInTerminal') => attempt(onError, () => api.invoke(command, { id: session.id }));
  const model = session.model ?? session.agentConfig?.model;
  const models = listedModels(useSessionModels(session, project?.id).listed);
  // Not picked, the model is the agent's default: the one it runs with, once it has said, or else the one the checkout's models mark.
  const agentDefault = session.model === undefined ? (session.agentConfig?.model ?? defaultModelOf(models)?.id) : undefined;
  const effort = session.effort ?? session.agentConfig?.effort;
  const { workingCopy } = session;

  return (
    <Popover anchor={anchor} role="dialog" label="Session details" className="details" maxHeight={DETAILS_MAX_HEIGHT} onClose={onClose}>
      <h4 tabIndex={-1} data-autofocus>
        <Info className="sm" />
        Session details
      </h4>
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
            openable(session) && (
              <>
                <IconAction label="Open in editor" icon={<CodeXml />} onClick={() => run('sessions.openInEditor')} />
                <IconAction label="Open in terminal" icon={<SquareTerminal />} onClick={() => run('sessions.openInTerminal')} />
              </>
            )
          }
        >
          <span className="chip">{workingCopy.kind}</span>
        </Fact>
        <Fact label="Path" actions={<CopyAction text={workingCopy.path} label="Copy path" />}>
          <span className="tech path" {...copyable(workingCopy.kind === 'worktree' ? 'worktree path' : 'path', workingCopy.path)}>
            {workingCopy.kind === 'worktree' ? <span {...copyable('worktree name', baseName(workingCopy.path))}>{breakable(workingCopy.path)}</span> : breakable(workingCopy.path)}
          </span>
          {workingCopy.kind === 'worktree' && session.status === 'archived' && (
            <span className="muted">{removedProject ? 'Removed on archiving.' : 'Removed on archiving; made again here when the Session reopens.'}</span>
          )}
        </Fact>
        <Fact label="Branch" actions={session.branch && <CopyAction text={session.branch} label="Copy branch name" />}>
          {session.branch ? (
            <span className="tech path" {...copyable('branch name', session.branch)}>
              {breakable(session.branch)}
            </span>
          ) : (
            <span className="muted">Not known yet</span>
          )}
        </Fact>
      </Group>
      <Group label="Agent">
        <Fact label="Agent">{session.agent}</Fact>
        <Fact label="Model">
          {agentDefault ? (
            <>
              <ModelName id={agentDefault} name={modelNameIn(models, agentDefault)} />
              <span className="muted">, the agent's default</span>
            </>
          ) : model ? (
            <ModelName id={model} name={modelNameIn(models, model)} />
          ) : (
            <span className="muted">The agent's default</span>
          )}
        </Fact>
        <Fact label="Effort">{effort ? <span className="tech">{effort}</span> : <span className="muted">Default</span>}</Fact>
        <Fact label="Approvals">{APPROVAL_MODES[session.fullAccess ? 'full' : 'supervised'].label}</Fact>
        <Fact label="Agent session" actions={session.agentSessionId && <CopyAction text={session.agentSessionId} label="Copy agent session id" />}>
          {session.agentSessionId ? <span className="tech path">{breakable(session.agentSessionId)}</span> : <span className="muted">Not started yet</span>}
        </Fact>
      </Group>
      <Group label="Usage">
        <Fact label="Context">{session.context ? <ContextBar used={session.context.used} size={session.context.size} /> : <span className="muted">Not reported yet</span>}</Fact>
        <Fact label="Tokens">{formatTokens(session.usage?.tokens ?? 0)}</Fact>
        <Fact label="Reported cost">{formatCost(session.usage?.reportedCost ?? 0)}</Fact>
        <Fact label="Working time">
          <WorkingTime session={session} />
        </Fact>
      </Group>
    </Popover>
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
    <section className="details-group" aria-label={label}>
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

function IconAction({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button className="icon-btn sm" type="button" title={label} aria-label={label} onClick={onClick}>
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

/** Context used against its size, as words and a bar. */
function ContextBar({ used, size }: { used: number; size: number }) {
  const percent = contextPercent({ used, size });
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

/** The Session's Working time so far, in milliseconds, at clock time `now`. */
export function workingMs(session: Session, now: number): number {
  const since = session.status === 'working' ? session.usage?.workingSince : undefined;
  return (session.usage?.workingMs ?? 0) + (since === undefined ? 0 : Math.max(0, now - since));
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
  return <>{formatDuration(workingMs(session, now))}</>;
}
