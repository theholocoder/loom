// The main pane for Sessions: starting one, and its chat, following
// docs/prototypes/ui-layout.html.
import { Archive, Bot, CircleCheckBig, CirclePause, FolderTree, GitBranch, GitPullRequest, ListPlus, LoaderCircle, MessageCircleQuestionMark, MessageSquareWarning, Navigation, OctagonX, PanelRight, Paperclip, Pause, RotateCw, SendHorizontal, ShieldAlert, Square, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeRequestRef, OPENCODE_NAME, type Branches, type Commands, type DiffComment, type ExistingBranch, type ExistingWorktree, type ForgeKind, type Issue, type NewAttachment, type QueuedMessage, type Session, type TranscriptItem, type WaitingReason } from '../shared/api';
import { issueBranch, suggestBranch } from '../shared/branches';
import { useApi, useTopic } from './api';
import { SearchPicker, type Loaded, type PickerOption } from './SearchPicker';
import { IssuePicker } from './IssuePicker';
import { ChangesView } from './Changes';
import { SessionInfo } from './SessionInfo';
import { Sidebar, type SidebarControl } from './Sidebar';
import { Select } from './Popover';
import { Markdown } from './Markdown';
import { useArchive, WorktreeMissing } from './Archive';
import { QuestionCard, TrustCard, useQuestionPanel } from './Questions';
import { ApprovalCard } from './Approvals';
import { FeedbackCard, FeedbackInfoCard } from './FeedbackCards';
import { ThinkingBlock, ToolCard } from './WorkCards';
import { ContextGauge, effortsOf, ModelMarker, ModelPickers, useCheckoutModels } from './ModelPicker';
import { AttachmentList, Composer } from './Composer';
import type { PaletteAction } from './CommandPalette';

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

/** The composer's working copy choices: a new worktree, an existing one, or the checkout. */
type WorkingCopyChoice = 'worktree' | 'existing' | 'checkout';

/**
 * What the Existing worktree picker picked: a worktree to work in as it is,
 * or a branch no worktree has, which gets a new worktree of its own.
 */
type ExistingPick = { worktree: ExistingWorktree } | { branch: ExistingBranch };

/** How a branch reads: `origin/<name>` for one on `origin`. */
function branchLabel(branch: ExistingBranch): string {
  return branch.remote ? `origin/${branch.name}` : branch.name;
}

/** The existing-worktree picker's options: the worktrees first, by branch, then the branches a new worktree can check out. */
function existingOptions(branches: Branches): PickerOption<ExistingPick>[] {
  return [
    ...branches.worktrees.map((worktree) => ({ ...existingKey({ worktree }), value: { worktree } })),
    ...branches.existing.map((branch) => ({ ...existingKey({ branch }), detail: 'new worktree', value: { branch } })),
  ];
}

/** The picker's key and label for a pick. */
function existingKey(pick: ExistingPick): { key: string; label: string } {
  return 'worktree' in pick
    ? { key: `worktree:${pick.worktree.path}`, label: pick.worktree.branch ?? 'detached HEAD' }
    : { key: `branch:${pick.branch.remote}:${pick.branch.name}`, label: branchLabel(pick.branch) };
}

/** The base picker's key and label for an `origin` branch. */
function baseKey(name: string): { key: string; label: string } {
  return { key: name, label: branchLabel({ name, remote: true }) };
}

/** What `sessions.create` is given for the working copy choice and what was picked for it. */
function workingCopyParams(
  choice: WorkingCopyChoice,
  { existing, branch, base }: { existing?: ExistingPick; branch?: string; base?: string },
): Pick<Commands['sessions.create']['params'], 'workingCopy' | 'branch' | 'base' | 'existing'> {
  switch (choice) {
    case 'checkout':
      return { workingCopy: 'checkout' };
    case 'existing':
      return { workingCopy: 'worktree', ...(existing && { existing: 'worktree' in existing ? { worktree: existing.worktree.path } : { branch: existing.branch } }) };
    case 'worktree':
      return { workingCopy: 'worktree', ...(branch?.trim() && { branch }), ...(base !== undefined && { base }) };
  }
}

/**
 * Where a new Session's files for @-mentions come from: the branch a new
 * worktree starts from or checks out, or an existing worktree has checked
 * out; or else the checkout itself.
 */
function filesRef(choice: WorkingCopyChoice, { existing, base }: { existing?: ExistingPick; base?: string }): { ref?: string } {
  if (choice === 'worktree' && base) return { ref: `origin/${base}` };
  if (choice === 'existing' && existing && 'branch' in existing) return { ref: branchLabel(existing.branch) };
  // An existing worktree's files are those of its branch, but for what it hasn't committed.
  if (choice === 'existing' && existing && 'worktree' in existing && existing.worktree.branch) return { ref: existing.worktree.branch };
  return {};
}

/** Starting a Session: which Project, which working copy, and the first prompt. */
/** `pickIssue` opens the issue picker at once, for starting from an issue. */
/** `commands` are what the composer's `/` offers: the palette's actions. */
export function NewSession({
  initialProjectId,
  pickIssue,
  onStarted,
  commands,
}: {
  initialProjectId?: number;
  pickIssue?: boolean;
  onStarted: (session: Session) => void;
  commands?: PaletteAction[];
}) {
  const api = useApi();
  const projects = useTopic('projects') ?? [];
  const [projectId, setProjectId] = useState(initialProjectId);
  const chosen = projects.find((p) => p.id === projectId) ?? projects[0];
  const [workingCopy, setWorkingCopy] = useState<WorkingCopyChoice>('worktree');
  // The `origin` branch picked to branch from; until then, origin's default.
  const [pickedBase, setPickedBase] = useState<string>();
  const [existing, setExisting] = useState<ExistingPick>();
  const { listed, refresh } = useBranches(workingCopy === 'checkout' ? undefined : chosen?.id);
  const defaultBranch = listed && 'value' in listed ? listed.value.defaultBranch : undefined;
  const base = pickedBase ?? defaultBranch;
  const [draft, setDraft] = useState('');
  // The branch the user typed; until then, the one suggested from the prompt.
  const [editedBranch, setEditedBranch] = useState<string>();
  const [error, setError] = useState<string>();
  // The issue picked to start from, while Forge features are on.
  const [pickedIssue, setIssue] = useState<Issue>();
  const issue = chosen?.forge.state === 'available' ? pickedIssue : undefined;
  const suggested = !chosen ? '' : issue ? issueBranch(chosen.branchPrefix, issue) : draft.trim() ? suggestBranch(chosen.branchPrefix, draft) : '';
  // The model and Effort picked; until then, the agent's own.
  const models = useCheckoutModels(chosen?.id);
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<string>();
  const efforts = effortsOf(models.listed, model);

  const start = async (prompt: string, attachments: NewAttachment[]) => {
    if (!chosen) return false;
    setError(undefined);
    const params = workingCopyParams(workingCopy, { existing, branch: editedBranch, base: pickedBase });
    try {
      const pick = { ...(model !== undefined && { model }), ...(effort !== undefined && efforts.includes(effort) && { effort }) };
      onStarted(await api.invoke('sessions.create', { projectId: chosen.id, ...params, ...(issue ? { issue } : {}), ...pick, prompt, ...(attachments.length ? { attachments } : {}) }));
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
          loadFiles={() => api.invoke('projects.files', { id: chosen.id, ...filesRef(workingCopy, { existing, base }) })}
          commands={commands}
          canSendEmpty={!!issue}
          disabled={workingCopy === 'existing' && !existing}
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
                  setExisting(undefined);
                  // Another checkout may offer other models.
                  setModel(undefined);
                  setEffort(undefined);
                }}
              />
              <ModelPickers
                agent={OPENCODE_NAME}
                models={models.listed}
                model={model}
                efforts={efforts}
                effort={effort}
                onOpen={models.refresh}
                onModel={(picked) => {
                  setModel(picked);
                  // A new model starts on its own default Effort.
                  setEffort(undefined);
                }}
                onEffort={setEffort}
              />
              <Select<WorkingCopyChoice>
                variant="compact"
                label="Working copy"
                value={workingCopy}
                options={[
                  { value: 'worktree', label: 'New worktree' },
                  { value: 'existing', label: 'Existing worktree' },
                  { value: 'checkout', label: 'Stay on current branch' },
                ]}
                onChange={setWorkingCopy}
              />
              <IssuePicker
                project={chosen}
                defaultOpen={pickIssue}
                issue={issue}
                onChange={(picked) => {
                  setIssue(picked);
                  setEditedBranch(undefined);
                }}
              />
              {workingCopy === 'existing' && (
                <SearchPicker
                  label="Worktree"
                  placeholder="Pick a worktree"
                  icon={<FolderTree className="sm" />}
                  noun="worktrees"
                  loading="Fetching origin…"
                  options={listed && 'value' in listed ? { value: existingOptions(listed.value) } : listed}
                  selected={existing && existingKey(existing)}
                  onOpen={refresh}
                  onChange={setExisting}
                />
              )}
              {workingCopy === 'worktree' && (
                <SearchPicker
                  label="Branch from"
                  placeholder="origin/…"
                  icon={<GitBranch className="sm" />}
                  noun="branches"
                  loading="Fetching origin…"
                  options={listed && 'value' in listed ? { value: listed.value.remote.map((name) => ({ ...baseKey(name), value: name })) } : listed}
                  selected={base === undefined ? undefined : baseKey(base)}
                  onOpen={refresh}
                  onChange={setPickedBase}
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
 * What a worktree Session on the Project `projectId` can start from, listed
 * by main (fetching origin) when the Project is chosen and again on
 * `refresh`, the last list staying until the new one comes; nothing while
 * `projectId` is undefined.
 */
function useBranches(projectId: number | undefined): { listed: Loaded<Branches>; refresh: () => void } {
  const api = useApi();
  const [listed, setListed] = useState<{ projectId: number; result: NonNullable<Loaded<Branches>> }>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (projectId === undefined) return;
    let current = true;
    api
      .invoke('projects.branches', { id: projectId })
      .then((value) => current && setListed({ projectId, result: { value } }))
      .catch((e: unknown) => current && setListed({ projectId, result: { error: (e as Error).message } }));
    return () => {
      current = false;
    };
  }, [api, projectId, generation]);
  const refresh = useCallback(() => setGeneration((n) => n + 1), []);
  return { listed: listed && listed.projectId === projectId ? listed.result : undefined, refresh };
}

/** An action asked of the open Session from outside it: by the palette or a shortcut. */
export type SessionCommand = 'archive' | 'openMergeRequest' | 'requestMergeRequest' | 'linkMergeRequest' | 'openInEditor' | 'openInTerminal' | 'retry' | 'markUnread';

/**
 * One Session: its header, its conversation and the composer, and the right
 * sidebar beside them while `sidebar` is open. Showing it
 * marks it read, as does a status change while it is shown. Changing
 * `replyRequest` focuses the composer. A `command` is run once, showing what
 * went wrong in the conversation like the header's own actions, then handed
 * back through `onCommandDone`. `onRetryableChange` says whether `retry`
 * would do anything: whether the last prompt failed.
 */
export function SessionView({
  session,
  replyRequest = 0,
  command,
  onCommandDone,
  onRetryableChange,
  sidebar,
  commands,
}: {
  session: Session;
  replyRequest?: number;
  command?: SessionCommand;
  onCommandDone?: () => void;
  onRetryableChange?: (retryable: boolean) => void;
  sidebar: SidebarControl;
  /** What the composer's `/` offers: the palette's actions. */
  commands?: PaletteAction[];
}) {
  const api = useApi();
  const items = useTopic('transcript', { sessionId: session.id }) ?? [];
  const project = useTopic('projects')?.find((p) => p.id === session.projectId);
  const [error, setError] = useState<string>();
  /** Whether Session info's Link Merge request popover is open. */
  const [linking, setLinking] = useState(false);
  const infoShown = sidebar.open && sidebar.view === 'info';
  useEffect(() => {
    if (!infoShown) setLinking(false);
  }, [infoShown]);
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
  // at a time, the composer giving its answers of one's own; a trust or Approval request, on its card.
  const firstAsked = session.status === 'waiting' ? items.find((i) => (i.kind === 'question' || i.kind === 'trust' || i.kind === 'approval') && i.state === 'asked') : undefined;
  const asked = firstAsked !== undefined;
  // Between runs only: not while the agent works, or waits on an answer.
  const pickersDisabled = working || asked || session.status === 'archived' || !!session.worktreeMissing;
  const { agentConfig } = session;
  // Until the agent says what it offers (it hasn't started since the Client did), the checkout's models.
  const checkoutModels = useCheckoutModels(agentConfig ? undefined : session.projectId);
  const shownModel = session.model ?? agentConfig?.model;
  const shownEfforts = agentConfig && agentConfig.model === shownModel ? agentConfig.efforts : effortsOf(checkoutModels.listed, shownModel);
  const { panel, freeAnswer, stepKey } = useQuestionPanel(firstAsked?.kind === 'question' ? firstAsked : undefined, (itemId, answer) =>
    api.invoke('sessions.answer', { id: session.id, itemId, answer }),
  );

  useEffect(() => {
    if (!command) return;
    onCommandDone?.();
    setError(undefined);
    const { id } = session;
    const runs: Record<SessionCommand, () => Promise<void>> = {
      archive: () => archiver.archive(session),
      openMergeRequest: () => api.invoke('links.open', { url: session.mergeRequest!.url }),
      requestMergeRequest: () => api.invoke('sessions.requestMergeRequest', { id }),
      linkMergeRequest: async () => {
        sidebar.reveal('info');
        setLinking(true);
      },
      openInEditor: () => api.invoke('sessions.openInEditor', { id }),
      openInTerminal: () => api.invoke('sessions.openInTerminal', { id }),
      retry: () => (retryable ? api.invoke('sessions.retry', { id }) : Promise.resolve()),
      markUnread: () => api.invoke('sessions.setUnread', { id, unread: true }),
    };
    runs[command]().catch((e: unknown) => setError((e as Error).message));
    // Run once per command: onCommandDone clears it, so asking again runs it again.
  }, [command]);
  useEffect(() => {
    onRetryableChange?.(retryable);
  }, [retryable]);
  useEffect(() => () => onRetryableChange?.(false), []);

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

  /** The comments on the diff to go with the next message, as chips in the composer. */
  const [comments, setComments] = useState<DiffComment[]>([]);
  const send = async (prompt: string, attachments: NewAttachment[]) => {
    setError(undefined);
    try {
      if (freeAnswer) return await freeAnswer.send(prompt);
      await api.invoke('sessions.send', { id: session.id, prompt, ...(attachments.length ? { attachments } : {}), ...(comments.length ? { comments } : {}) });
      setComments([]);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  /** What the composer is for right now. */
  const composerPlaceholder = (): string => {
    if (working) return `Queue a message for when ${session.agent} finishes…`;
    if (freeAnswer) return freeAnswer.placeholder;
    if (firstAsked?.kind === 'approval') return 'Approve or deny the request above to go on.';
    if (asked) return 'Answer the question above to go on.';
    if (session.status === 'archived') return 'This Session is archived.';
    if (session.worktreeMissing) return "This Session's worktree is missing; it can only be archived.";
    return `Reply to ${session.agent}…`;
  };

  /** Runs a command on the Session, showing why if it fails. */
  const runCommand = async (run: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const openLink = (url: string) => void api.invoke('links.open', { url }).catch((e: unknown) => setError((e as Error).message));
  const retry = () => runCommand(() => api.invoke('sessions.retry', { id: session.id }));
  // Loom quit or crashed during the run, which the agent can go on with.
  const continuable = session.status === 'waiting' && session.waitingReason === 'interrupted' && !session.worktreeMissing;

  const archive = () => {
    setError(undefined);
    archiver.archive(session).catch((e: unknown) => setError((e as Error).message));
  };

  return (
    <>
      <main className="main" aria-label="Session">
        <div className="main-head" role="region" aria-label="Session header">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="crumb">
              {project && <span>{project.name}</span>}
              {project && session.branch && <span aria-hidden="true">·</span>}
              {session.branch && (
                <>
                  <GitBranch className="sm" />
                  <span className="tech ellipsis" title="Branch">
                    {session.branch}
                  </span>
                </>
              )}
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
          <button
            className="icon-btn"
            type="button"
            title={sidebar.open ? 'Hide sidebar' : 'Show sidebar'}
            aria-label={sidebar.open ? 'Hide sidebar' : 'Show sidebar'}
            aria-expanded={sidebar.open}
            aria-controls="session-sidebar"
            onClick={sidebar.toggle}
          >
            <PanelRight />
          </button>
          {archiver.dialog}
        </div>
        <div className="chat" role="log" aria-label="Conversation">
          {items.map((item) =>
            item.kind === 'user' ? (
              <div key={item.id} className="msg user">
                <div className="body" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <div className="bubble">
                    {item.text && <Markdown text={item.text} breaks />}
                    {item.attachments && <AttachmentList attachments={item.attachments} />}
                  </div>
                </div>
              </div>
            ) : item.kind === 'agent' ? (
              <div key={item.id} className="msg agent">
                <div className="who">
                  <Bot />
                </div>
                <div className="body">
                  <div className="name">{session.agent}</div>
                  <div className="bubble">
                    <Markdown text={item.text} />
                  </div>
                </div>
              </div>
            ) : item.kind === 'thinking' ? (
              <ThinkingBlock key={item.id} item={item} />
            ) : item.kind === 'tool' ? (
              <ToolCard key={item.id} item={item} />
            ) : item.kind === 'question' ? (
              <QuestionCard key={item.id} item={item} />
            ) : item.kind === 'approval' ? (
              <ApprovalCard key={item.id} item={item} onDecide={(decision, message) => api.invoke('sessions.approve', { id: session.id, itemId: item.id, decision, ...(message ? { message } : {}) })} />
            ) : item.kind === 'trust' ? (
              <TrustCard key={item.id} item={item} project={project?.name} onTrust={(trusted) => api.invoke('sessions.trust', { id: session.id, itemId: item.id, trusted })} />
            ) : item.kind === 'interruption' ? (
              <Interruption key={item.id} item={item} onContinue={continuable && item === items.at(-1) ? () => void runCommand(() => api.invoke('sessions.continue', { id: session.id })) : undefined} />
            ) : item.kind === 'model' ? (
              <ModelMarker key={item.id} item={item} />
            ) : item.kind === 'merge-request-refused' ? (
              <div key={item.id} className="interruption" role="note">
                <TriangleAlert className="sm" />
                <span>
                  Couldn't link Merge request <span className="tech">{item.mergeRequest}</span>: {item.reason}
                </span>
              </div>
            ) : item.kind === 'merge-request' ? (
              <MergeRequestCard key={item.id} item={item} forge={project?.forge.kind} onOpen={() => openLink(item.url)} />
            ) : item.kind === 'feedback' ? (
              <FeedbackCard
                key={item.id}
                item={item}
                forge={project?.forge.kind}
                readOnly={session.status === 'archived' || !!session.worktreeMissing}
                onOpen={openLink}
                onSend={() => api.invoke('sessions.sendFeedback', { id: session.id, itemId: item.id })}
              />
            ) : item.kind === 'feedback-info' ? (
              <FeedbackInfoCard key={item.id} item={item} onOpen={() => openLink(item.url)} />
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
          disabled={(session.status !== 'waiting' && !working) || (asked && !freeAnswer) || !!session.worktreeMissing}
          dock={panel}
          clearKey={stepKey}
          focusRequest={replyRequest}
          onSend={send}
          canAttach={!freeAnswer}
          loadFiles={session.status === 'archived' || session.worktreeMissing ? undefined : () => api.invoke('sessions.files', { id: session.id })}
          commands={commands}
          // Not with an answer to a question: they wait for the next message.
          comments={freeAnswer ? undefined : comments}
          onRemoveComment={(index) => setComments((list) => list.filter((_, i) => i !== index))}
          queueing={working}
          tools={
            <ModelPickers
              agent={session.agent}
              models={agentConfig ? { value: agentConfig.models } : checkoutModels.listed}
              model={shownModel}
              efforts={shownEfforts}
              effort={session.effort ?? agentConfig?.effort}
              disabled={pickersDisabled}
              onOpen={checkoutModels.refresh}
              onModel={(model) => void runCommand(() => api.invoke('sessions.setModel', { id: session.id, model }))}
              onEffort={(effort) => void runCommand(() => api.invoke('sessions.setModel', { id: session.id, effort }))}
            />
          }
          gauge={session.context && <ContextGauge context={session.context} />}
          onStop={working ? () => void runCommand(() => api.invoke('sessions.stop', { id: session.id })) : undefined}
          queue={
            session.queue && session.status !== 'archived' ? (
              <Queue
                queue={session.queue}
                // Steering needs a run going; otherwise Send now sends it as the reply.
                steer={working && !!session.canSteer}
                onSendNow={(queuedId) => void runCommand(() => api.invoke('sessions.sendNow', { id: session.id, queuedId }))}
                onSteer={(queuedId) => void runCommand(() => api.invoke('sessions.steer', { id: session.id, queuedId }))}
                onRemove={(queuedId) => void runCommand(() => api.invoke('sessions.removeQueued', { id: session.id, queuedId }))}
              />
            ) : undefined
          }
        />
      </main>
      {sidebar.open && (
        <Sidebar control={sidebar}>
          {sidebar.view === 'changes' ? (
            <ChangesView session={session} onComment={(comment) => setComments((list) => [...list, comment])} />
          ) : (
            <SessionInfo
              session={session}
              project={project}
              linking={linking}
              onLinkingChange={setLinking}
              onShowChanges={() => sidebar.reveal('changes')}
              onArchive={archive}
              onError={setError}
            />
          )}
        </Sidebar>
      )}
    </>
  );
}

/** A Merge request linked to the Session: "Merge request !12 opened · Open". */
function MergeRequestCard({ item, forge, onOpen }: { item: Extract<TranscriptItem, { kind: 'merge-request' }>; forge: ForgeKind | undefined; onOpen: () => void }) {
  return (
    <div className="interruption merge-request" role="note">
      <GitPullRequest className="sm" />
      <span>
        Merge request <span className="tech">{mergeRequestRef(forge, item.number)}</span> opened
      </span>
      <span aria-hidden="true">·</span>
      <button type="button" className="link" onClick={onOpen}>
        Open
      </button>
    </div>
  );
}

const INTERRUPTIONS = {
  stop: { icon: Square, label: 'Stopped' },
  'send-now': { icon: SendHorizontal, label: 'Interrupted to send a queued message' },
  quit: { icon: CirclePause, label: 'Loom quit or crashed during this run' },
} satisfies Record<Extract<TranscriptItem, { kind: 'interruption' }>['by'], { icon: LucideIcon; label: string }>;

/**
 * Where the run was interrupted: by the user, with Stop or to send a queued
 * message now, or by Loom quitting, with Continue when `onContinue` is given.
 */
function Interruption({ item, onContinue }: { item: Extract<TranscriptItem, { kind: 'interruption' }>; onContinue?: () => void }) {
  const { icon: Icon, label } = INTERRUPTIONS[item.by];
  return (
    <div className="interruption" role="note">
      <Icon className="sm" />
      <span>{label}</span>
      {onContinue && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="link" onClick={onContinue}>
            Continue
          </button>
        </>
      )}
    </div>
  );
}

/** The messages waiting to be sent, oldest first: each can be removed, or sent now (or steered in, if the agent can be). */
function Queue({
  queue,
  steer,
  onSendNow,
  onSteer,
  onRemove,
}: {
  queue: QueuedMessage[];
  steer: boolean;
  onSendNow: (queuedId: number) => void;
  onSteer: (queuedId: number) => void;
  onRemove: (queuedId: number) => void;
}) {
  return (
    <ul className="queue" aria-label="Queued messages">
      {queue.map((message) => (
        <li key={message.id}>
          <ListPlus className="sm" />
          <span className="grow ellipsis" title={message.text}>
            {message.text}
          </span>
          {message.attachments && (
            <span className="row muted" title={message.attachments.map((a) => a.name).join('\n')} aria-label={`${message.attachments.length} attached`}>
              <Paperclip className="sm" />
              {message.attachments.length}
            </span>
          )}
          {steer ? (
            <button type="button" onClick={() => onSteer(message.id)}>
              <Navigation className="sm" />
              Steer
            </button>
          ) : (
            <button type="button" onClick={() => onSendNow(message.id)}>
              <SendHorizontal className="sm" />
              Send now
            </button>
          )}
          <button className="icon-btn sm" type="button" title="Remove" aria-label="Remove" onClick={() => onRemove(message.id)}>
            <X className="sm" />
          </button>
        </li>
      ))}
    </ul>
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
