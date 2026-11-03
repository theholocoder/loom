// The main pane for Sessions: starting one, and its chat, following
// docs/prototypes/ui-layout.html.
import { Archive, ArrowUp, Bot, ChevronRight, CircleCheckBig, CircleDot, CirclePause, FolderTree, GitBranch, LoaderCircle, MessageCircleQuestionMark, MessageSquareWarning, OctagonX, Pause, RotateCw, ShieldAlert, SquareTerminal, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { OPENCODE_NAME, type Branches, type ExistingBranch, type Issue, type Session, type WaitingReason } from '../shared/api';
import { issueBranch, suggestBranch } from '../shared/branches';
import { useApi, useTopic } from './api';
import { BranchPicker, type Listed } from './BranchPicker';
import { DiffToggle } from './DiffToggle';
import { IssuePicker } from './IssuePicker';
import { OpenActions } from './OpenActions';
import { Select } from './Popover';
import { useArchive, WorktreeMissing } from './Archive';
import { QuestionCard, TrustCard, useQuestionPanel } from './Questions';
import { ThinkingBlock, ToolCard } from './WorkCards';

const WAITING: Record<WaitingReason, { label: string; icon: LucideIcon }> = {
  finished: { label: 'Finished', icon: CircleCheckBig },
  stopped: { label: 'Stopped', icon: Pause },
  question: { label: 'Asked a question', icon: MessageCircleQuestionMark },
  approval: { label: 'Needs approval', icon: ShieldAlert },
  stuck: { label: 'Stuck', icon: TriangleAlert },
  error: { label: 'Error', icon: OctagonX },
  interrupted: { label: 'Interrupted', icon: CirclePause },
  feedback: { label: 'Feedback', icon: MessageSquareWarning },
};

/** What the Session's status says, in words and as an icon. */
export function statusOf(session: Session): { label: string; icon: LucideIcon; className: string } {
  if (session.status === 'working') return { label: 'Working', icon: LoaderCircle, className: 'st-working' };
  if (session.status === 'archived') return { label: 'Archived', icon: Archive, className: 'st-archived' };
  const reason = session.waitingReason ?? 'finished';
  return { ...WAITING[reason], className: `st-waiting-${reason}` };
}

export function StatusIcon({ session }: { session: Session }) {
  const { label, icon: Icon, className } = statusOf(session);
  const icon = <Icon className="sm" />;
  return (
    <span className={className} title={label} role="img" aria-label={label}>
      {session.status === 'working' ? <span className="spin">{icon}</span> : icon}
    </span>
  );
}

/** The composer's working copy choices: a worktree on a new or an existing branch, or the checkout. */
type WorkingCopyChoice = 'worktree' | 'existing' | 'checkout';

/** Starting a Session: which Project, which working copy, and the first prompt. */
export function NewSession({ initialProjectId, onStarted }: { initialProjectId?: number; onStarted: (session: Session) => void }) {
  const api = useApi();
  const projects = useTopic('projects') ?? [];
  const [projectId, setProjectId] = useState(initialProjectId);
  const chosen = projects.find((p) => p.id === projectId) ?? projects[0];
  const [workingCopy, setWorkingCopy] = useState<WorkingCopyChoice>('worktree');
  // The `origin` branch picked to branch from; until then, origin's default.
  const [pickedBase, setPickedBase] = useState<string>();
  const [existingBranch, setExistingBranch] = useState<ExistingBranch>();
  const listed = useBranches(workingCopy === 'checkout' ? undefined : chosen?.id);
  const defaultBranch = listed && 'branches' in listed ? listed.branches.defaultBranch : undefined;
  const base = pickedBase ?? defaultBranch;
  const [draft, setDraft] = useState('');
  // The branch the user typed; until then, the one suggested from the prompt.
  const [editedBranch, setEditedBranch] = useState<string>();
  const [error, setError] = useState<string>();
  // The issue picked to start from, while Forge features are on.
  const [pickedIssue, setIssue] = useState<Issue>();
  const issue = chosen?.forge.state === 'available' ? pickedIssue : undefined;
  const suggested = !chosen ? '' : issue ? issueBranch(chosen.branchPrefix, issue) : draft.trim() ? suggestBranch(chosen.branchPrefix, draft) : '';

  const start = async (prompt: string) => {
    if (!chosen) return false;
    setError(undefined);
    const branch =
      workingCopy === 'existing'
        ? { existingBranch }
        : workingCopy === 'worktree'
          ? { ...(editedBranch?.trim() ? { branch: editedBranch } : {}), ...(pickedBase !== undefined ? { base: pickedBase } : {}) }
          : {};
    try {
      onStarted(await api.invoke('sessions.create', { projectId: chosen.id, workingCopy: workingCopy === 'checkout' ? 'checkout' : 'worktree', ...branch, ...(issue ? { issue } : {}), prompt }));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <main className="main" aria-label="New Session">
      <div className="main-head">
        <h1>New Session</h1>
      </div>
      <div className="chat">
        {projects.length === 0 && <div className="empty">Add a Project before starting a Session.</div>}
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
      </div>
      {chosen && (
        <Composer
          agent={OPENCODE_NAME}
          placeholder={`Tell ${OPENCODE_NAME} what to do…`}
          onSend={start}
          onDraftChange={setDraft}
          canSendEmpty={!!issue}
          disabled={workingCopy === 'existing' && !existingBranch}
          tools={
            <>
              <Select
                variant="compact"
                label="Project"
                icon={<FolderTree className="sm" />}
                value={chosen.id}
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
                onChange={(id) => {
                  setProjectId(id);
                  // An edited name has the old Project's prefix; the issue and branches are the old Project's.
                  setEditedBranch(undefined);
                  setIssue(undefined);
                  setPickedBase(undefined);
                  setExistingBranch(undefined);
                }}
              />
              <Select<WorkingCopyChoice>
                variant="compact"
                label="Working copy"
                value={workingCopy}
                options={[
                  { value: 'worktree', label: 'New worktree' },
                  { value: 'existing', label: 'Check out an existing branch' },
                  { value: 'checkout', label: 'Stay on current branch' },
                ]}
                onChange={setWorkingCopy}
              />
              <IssuePicker
                project={chosen}
                issue={issue}
                onChange={(picked) => {
                  setIssue(picked);
                  setEditedBranch(undefined);
                }}
              />
              {workingCopy === 'existing' && (
                <BranchPicker
                  label="Existing branch"
                  placeholder="Pick a branch"
                  listed={listed && 'branches' in listed ? { branches: listed.branches.existing } : listed}
                  selected={existingBranch}
                  onChange={setExistingBranch}
                />
              )}
              {workingCopy === 'worktree' && (
                <BranchPicker
                  label="Branch from"
                  placeholder="origin/…"
                  listed={listed && 'branches' in listed ? { branches: listed.branches.remote.map((name) => ({ name, remote: true })) } : listed}
                  selected={base === undefined ? undefined : { name: base, remote: true }}
                  onChange={(picked) => setPickedBase(picked.name)}
                />
              )}
              {workingCopy === 'worktree' && (
                <label className="pick" title="Branch">
                  <GitBranch className="sm" />
                  <input
                    className="branch tech"
                    aria-label="Branch"
                    placeholder={`${chosen.branchPrefix}/…`}
                    value={editedBranch ?? suggested}
                    onChange={(event) => setEditedBranch(event.target.value)}
                  />
                </label>
              )}
            </>
          }
        />
      )}
    </main>
  );
}

/**
 * The branches of the Project `projectId` a worktree Session can start from,
 * listed (fetching origin) once per Project; nothing while undefined.
 */
function useBranches(projectId: number | undefined): Listed<Branches> {
  const api = useApi();
  const [listed, setListed] = useState<{ projectId: number; result: NonNullable<Listed<Branches>> }>();
  const wanted = projectId !== undefined && listed?.projectId !== projectId;
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    api
      .invoke('projects.branches', { id: projectId })
      .then((branches) => current && setListed({ projectId, result: { branches } }))
      .catch((e: unknown) => current && setListed({ projectId, result: { error: (e as Error).message } }));
    return () => {
      current = false;
    };
  }, [api, projectId, wanted]);
  return listed && listed.projectId === projectId ? listed.result : undefined;
}

/**
 * One Session: its header, its conversation and the composer. Showing it
 * marks it read, as does a status change while it is shown. Changing
 * `replyRequest` focuses the composer.
 */
export function SessionView({ session, replyRequest = 0, diffOpen, onToggleDiff }: { session: Session; replyRequest?: number; diffOpen: boolean; onToggleDiff: () => void }) {
  const api = useApi();
  const items = useTopic('transcript', { sessionId: session.id }) ?? [];
  const project = useTopic('projects')?.find((p) => p.id === session.projectId);
  const [error, setError] = useState<string>();
  const archiver = useArchive();
  const status = statusOf(session);
  const working = session.status === 'working';
  // The conversation lives only while the Client runs; the error is stored.
  const unshownError = session.waitingReason === 'error' && session.error && !items.some((i) => i.kind === 'error') ? session.error : undefined;
  const environment = useTopic('environments')?.find((e) => e.id === project?.checkout.environmentId);
  // Disconnected: the bridge died and is about to be started again.
  const starting = working && (environment?.state === 'starting' || environment?.state === 'disconnected');
  // The last prompt went unanswered, so it can be sent again.
  const retryable = session.status === 'waiting' && session.waitingReason === 'error' && items.at(-2)?.kind === 'user' && items.at(-1)?.kind === 'error' && !session.worktreeMissing;
  // The agent waits on an answer. A question is answered in a panel on the composer, one question
  // at a time, the composer giving its answers of one's own; a trust request, on its card.
  const firstAsked = session.status === 'waiting' ? items.find((i) => (i.kind === 'question' || i.kind === 'trust') && i.state === 'asked') : undefined;
  const asked = firstAsked !== undefined;
  const { panel, freeAnswer, stepKey } = useQuestionPanel(firstAsked?.kind === 'question' ? firstAsked : undefined, (itemId, answer) =>
    api.invoke('sessions.answer', { id: session.id, itemId, answer }),
  );

  const end = useRef<HTMLDivElement>(null);
  // A block body: Chromium's scrollIntoView returns a promise, which React would take for a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [items]);

  // Not on `unread` itself, so that Mark unread sticks while the Session is shown.
  useEffect(() => {
    // Failing to mark it read leaves it unread, which the Inbox already shows.
    if (session.unread) api.invoke('sessions.setUnread', { id: session.id, unread: false }).catch(() => {});
  }, [session.id, session.updatedAt]);

  const send = async (prompt: string) => {
    setError(undefined);
    try {
      if (freeAnswer) return await freeAnswer.send(prompt);
      await api.invoke('sessions.send', { id: session.id, prompt });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  /** What the composer is for right now. */
  const composerPlaceholder = (): string => {
    if (working) return `${session.agent} is working…`;
    if (freeAnswer) return freeAnswer.placeholder;
    if (asked) return 'Answer the question above to go on.';
    if (session.status === 'archived') return 'This Session is archived.';
    if (session.worktreeMissing) return "This Session's worktree is missing; it can only be archived.";
    return `Reply to ${session.agent}…`;
  };

  const retry = async () => {
    setError(undefined);
    try {
      await api.invoke('sessions.retry', { id: session.id });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main className="main" aria-label="Session">
      <div className="main-head" role="region" aria-label="Session header">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="crumb">
            {project && <span>{project.name}</span>}
            {project?.forge.repository && <span className="tech">{project.forge.repository}</span>}
            {session.issue && (
              <>
                <ChevronRight className="sm" />
                <button type="button" className="chip tech" title="Issue" onClick={() => void api.invoke('links.open', { url: session.issue!.url }).catch(() => {})}>
                  <CircleDot className="sm" />#{session.issue.number}
                </button>
              </>
            )}
            {session.branch && (
              <>
                <ChevronRight className="sm" />
                <GitBranch className="sm" />
                <span className="tech ellipsis" title="Branch">
                  {session.branch}
                </span>
              </>
            )}
            <ChevronRight className="sm" />
            <span className="chip" title={session.workingCopy.path}>
              <FolderTree className="sm" />
              {session.workingCopy.kind}
            </span>
          </div>
          <div className="row">
            <h1 className="ellipsis">{session.title}</h1>
            <StatusIcon session={session} />
            <span className={`${status.className} chip`} role="status" aria-label="Session status">
              {status.label}
            </span>
            {session.worktreeMissing && <WorktreeMissing />}
          </div>
        </div>
        <DiffToggle stat={session.diffStat} open={diffOpen} onToggle={onToggleDiff} />
        <OpenActions session={session} onError={setError} />
        {session.status !== 'archived' && (
          <button
            className="icon-btn"
            type="button"
            title="Archive"
            aria-label="Archive"
            onClick={() => {
              setError(undefined);
              archiver.archive(session).catch((e: unknown) => setError((e as Error).message));
            }}
          >
            <Archive />
          </button>
        )}
        {archiver.dialog}
      </div>
      <div className="chat" role="log" aria-label="Conversation">
        {items.map((item) =>
          item.kind === 'user' ? (
            <div key={item.id} className="msg user">
              <div className="body" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div className="bubble">{item.text}</div>
              </div>
            </div>
          ) : item.kind === 'agent' ? (
            <div key={item.id} className="msg agent">
              <div className="who">
                <Bot />
              </div>
              <div className="body">
                <div className="name">{session.agent}</div>
                <div className="bubble">{item.text}</div>
              </div>
            </div>
          ) : item.kind === 'thinking' ? (
            <ThinkingBlock key={item.id} item={item} />
          ) : item.kind === 'tool' ? (
            <ToolCard key={item.id} item={item} />
          ) : item.kind === 'question' ? (
            <QuestionCard key={item.id} item={item} />
          ) : item.kind === 'trust' ? (
            <TrustCard key={item.id} item={item} project={project?.name} onTrust={(trusted) => api.invoke('sessions.trust', { id: session.id, itemId: item.id, trusted })} />
          ) : (
            <ErrorCard key={item.id} message={item.message} onRetry={retryable && item === items.at(-1) ? retry : undefined} />
          ),
        )}
        {unshownError && <ErrorCard message={unshownError} />}
        {starting && environment && (
          <div className="tools">
            <div className="tool" role="status">
              <div className="tool-head">
                <span className="spin">
                  <LoaderCircle className="sm" />
                </span>
                <span className="grow">{`Starting ${environment.label}…`}</span>
              </div>
            </div>
          </div>
        )}
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
        <div ref={end} />
      </div>
      <Composer
        agent={session.agent}
        placeholder={composerPlaceholder()}
        disabled={session.status !== 'waiting' || (asked && !freeAnswer) || !!session.worktreeMissing}
        dock={panel}
        clearKey={stepKey}
        focusRequest={replyRequest}
        onSend={send}
      />
    </main>
  );
}

/** A run that failed, with the agent's message, and Retry when `onRetry` is given. */
function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="tools">
      <div className="tool failed">
        <div className="tool-head">
          <OctagonX className="sm" />
          <span className="name">error</span>
          <span className="grow" role="alert">
            {message}
          </span>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              <RotateCw className="sm" />
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The prompt box, with the agent's label and `tools` in its toolbar. Enter
 * sends, Shift+Enter adds a line. `onSend` resolves to whether to clear it.
 */
function Composer({
  agent,
  placeholder,
  disabled = false,
  tools,
  focusRequest = 0,
  onSend,
  onDraftChange,
  canSendEmpty = false,
  dock,
  clearKey,
}: {
  /** The agent Sessions run on; a label, not a picker, in v1. */
  agent: string;
  placeholder: string;
  disabled?: boolean;
  tools?: ReactNode;
  /** Changing it focuses the prompt box. */
  focusRequest?: number;
  onSend: (prompt: string) => Promise<boolean>;
  /** Called with the prompt as the user types it. */
  onDraftChange?: (draft: string) => void;
  /** Whether an empty prompt can be sent. */
  canSendEmpty?: boolean;
  /** What sits on the prompt box, part of it: the panel of a question it answers. */
  dock?: ReactNode;
  /** Changing it empties the prompt box: what was typed was for something else, such as another question. */
  clearKey?: string;
}) {
  const [draft, setDraftState] = useState('');
  const setDraft = (value: string) => {
    setDraftState(value);
    onDraftChange?.(value);
  };
  const prompt = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusRequest) prompt.current?.focus();
  }, [focusRequest]);
  const clearedFor = useRef(clearKey);
  useEffect(() => {
    if (clearedFor.current === clearKey) return;
    clearedFor.current = clearKey;
    setDraft('');
  }, [clearKey]);
  const [sending, setSending] = useState(false);
  const canSend = !disabled && !sending && (canSendEmpty || draft.trim() !== '');

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      if (await onSend(draft)) setDraft('');
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) void send(event);
  };

  return (
    <form className="composer-wrap" aria-label="Composer" onSubmit={send}>
      <div className={`composer${dock ? ' docked' : ''}`}>
        {dock}
        <textarea ref={prompt} aria-label="Prompt" rows={2} placeholder={placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        <div className="ctoolbar">
          <span className="pick" title="Agent" style={{ cursor: 'default' }}>
            <SquareTerminal className="sm" />
            <b>{agent}</b>
          </span>
          {tools}
          <span className="grow" />
          <button className="primary send" type="submit" disabled={!canSend}>
            <ArrowUp />
            Send
          </button>
        </div>
      </div>
      <div className="hint">
        <span>
          <kbd>Enter</kbd> send
        </span>
        <span>
          <kbd>Shift Enter</kbd> newline
        </span>
      </div>
    </form>
  );
}
