// The main pane for Sessions: starting one, and its chat, following
// docs/prototypes/ui-layout.html.
import { AlarmClock, AlarmClockOff, Archive, Bot, CircleCheckBig, CirclePause, FolderTree, GitBranch, GitPullRequest, ListPlus, LoaderCircle, MessageCircleQuestionMark, MessageSquareQuote, MessageSquareWarning, Navigation, OctagonX, Paperclip, Pause, Pencil, RotateCw, SendHorizontal, ShieldAlert, ShieldCheck, ShieldOff, Square, SquareTerminal, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { APPROVAL_MODES, mergeRequestRef, OPENCODE_NAME, type ApprovalMode, type Branches, type Highlight, type Commands, type ExistingBranch, type ExistingWorktree, type ForgeKind, type Issue, hasNothingToSend, type NewAttachment, type QueuedMessage, type Session, type TranscriptItem, type WaitingReason } from '../shared/api';
import { branchName, branchNameProblem, issueBranch, suggestBranch } from '../shared/branches';
import { kindOf, terminalOf, type PanelId } from '../shared/panels';
import { useApi, useTopic } from './api';
import { SearchPicker, type Loaded, type PickerOption } from './SearchPicker';
import { IssuePicker } from './IssuePicker';
import { ChangesView, type ChangesFocus, type DiffComments } from './Changes';
import { highlightLine, HighlightsPanel } from './HighlightsPanel';
import { IssuePanel } from './IssuePanel';
import type { ReviewNotes } from './ReviewNotes';
import { SessionHeader, type HeaderPopover } from './SessionHeader';
import { MergeRequestPanel, type MergeRequestFocus, type MergeRequestTab } from './MergeRequestPanel';
import { canRunTerminals, PanelArea, usePanels } from './Panels';
import { TerminalView } from './TerminalView';
import { Select } from './Popover';
import { Markdown } from './Markdown';
import { useArchive, useRemovedProject } from './Archive';
import { useToast } from './Toast';
import { useDelete } from './Delete';
import { QuestionCard, TrustCard, useQuestionPanel } from './Questions';
import { ApprovalCard } from './Approvals';
import { ENDED, FeedbackCard, FeedbackInfoCard, MergeRequestEndedCard } from './FeedbackCards';
import { PlanCard, ThinkingBlock, ToolCard } from './WorkCards';
import { useAgentCommands, useCheckoutModels } from './checkout';
import { isSnoozed, wakeTime } from './Snooze';
import { useNow } from './now';
import { ContextGauge, effortsOf, ModelMarker, ModelPickers } from './ModelPicker';
import { AttachmentList, CommentNoteForm, Composer } from './Composer';
import { withNote, type PendingComment } from './diff-comments';
import { useSessionMenu } from './SessionMenu';
import { isFreeEscape } from './escape';
import { addToContextMenu, selectedText } from './ContextMenu';
import { useForgetDraft, useKeptState } from './drafts';

/** Whose draft New Session's is (see `useKeptState`). */
const NEW_SESSION_DRAFT = 'new-session';
/** Whose draft a Session's is. */
const sessionDraft = (id: number) => `session:${id}`;

/** Why a Session is Waiting, but for unsaved work, which shows what became of its Merge request (see ENDED). */
const WAITING: Record<Exclude<WaitingReason, 'unsaved-work'>, { label: string; icon: LucideIcon }> = {
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
  const className = `st-waiting-${reason}`;
  if (reason !== 'unsaved-work') return { ...WAITING[reason], className };
  const { label, icon } = ENDED[session.mergeRequestState === 'closed' ? 'closed' : 'merged'];
  return { label: `${label} with unsaved work`, icon, className };
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
export type ExistingPick = { worktree: ExistingWorktree } | { branch: ExistingBranch };

/** The working copy a New Session starts on, when it is started from another Session: its checkout, or its worktree or branch. */
export type NewSessionWorkingCopy = { workingCopy: 'checkout' } | { workingCopy: 'existing'; existing: ExistingPick };

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
    : { key: `branch:${pick.branch.remote}:${pick.branch.name}`, label: branchName(pick.branch) };
}

/** The base picker's key and label for a branch, on `origin` or local. */
function baseKey(branch: ExistingBranch): { key: string; label: string } {
  return { key: `${branch.remote}:${branch.name}`, label: branchName(branch) };
}

/** What `sessions.create` is given for the working copy choice and what was picked for it. */
function workingCopyParams(
  choice: WorkingCopyChoice,
  { existing, branch, base }: { existing?: ExistingPick; branch?: string; base?: ExistingBranch },
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
function filesRef(choice: WorkingCopyChoice, { existing, base }: { existing?: ExistingPick; base?: ExistingBranch }): { ref?: string } {
  if (choice === 'worktree' && base) return { ref: branchName(base) };
  if (choice === 'existing' && existing && 'branch' in existing) return { ref: branchName(existing.branch) };
  // An existing worktree's files are those of its branch, but for what it hasn't committed.
  if (choice === 'existing' && existing && 'worktree' in existing && existing.worktree.branch) return { ref: existing.worktree.branch };
  return {};
}

/** Starting a Session: which Project, which working copy, and the first prompt. */
/**
 * `pickIssue` opens the issue picker at once, for starting from an issue;
 * `initialWorkingCopy` picks the working copy. Cancel gives up through
 * `onCancel`, throwing the draft away, as does Escape that nothing open on it
 * took, while nothing is typed. The draft is otherwise kept for the next New
 * Session, until a Session starts from it.
 */
export function NewSession({
  initialProjectId,
  pickIssue,
  initialWorkingCopy,
  onStarted,
  onCancel,
}: {
  initialProjectId?: number;
  pickIssue?: boolean;
  initialWorkingCopy?: NewSessionWorkingCopy;
  onStarted: (session: Session) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const projects = useTopic('projects') ?? [];
  const [projectId, setProjectId] = useState(initialProjectId);
  const chosen = projects.find((p) => p.id === projectId) ?? projects[0];
  const [pickedWorkingCopy, setPickedWorkingCopy] = useState<WorkingCopyChoice>(initialWorkingCopy?.workingCopy ?? 'worktree');
  // The branch picked to branch from; until then, the default base.
  const [pickedBase, setPickedBase] = useState<ExistingBranch>();
  const [existing, setExisting] = useState<ExistingPick | undefined>(initialWorkingCopy?.workingCopy === 'existing' ? initialWorkingCopy.existing : undefined);
  // Listed whatever the working copy, for what each choice offers.
  const { listed, refresh, refreshing } = useBranches(chosen?.id);
  const branches = listed && 'value' in listed ? listed.value : undefined;
  const unlisted = listed && 'error' in listed ? listed : undefined;
  // Existing worktree, while there is a worktree or a branch for one, or until the list says there isn't.
  const offersExisting = !branches || !!existing || existingOptions(branches).length > 0;
  const workingCopy = pickedWorkingCopy === 'existing' && !offersExisting ? 'worktree' : pickedWorkingCopy;
  // The prompt waits for the worktree to work in.
  const needsWorktree = workingCopy === 'existing' && !existing;
  // Why origin's branches may be out of date, for the pickers that list them.
  const stale = workingCopy === 'checkout' ? undefined : branches?.fetchError;
  const base = pickedBase ?? branches?.defaultBase;
  const [draft, setDraft] = useState('');
  // The branch the user typed; until then, the one suggested from the prompt.
  const [editedBranch, setEditedBranch] = useState<string>();
  const [error, setError] = useState<string>();
  // The issue picked to start from, while Forge features are on.
  const [pickedIssue, setIssue] = useState<Issue>();
  const issue = chosen?.forge.state === 'available' ? pickedIssue : undefined;
  // Why git wouldn't take the branch name typed, said as it is typed; main says it again on start.
  const typedBranch = workingCopy === 'worktree' ? editedBranch?.trim() : undefined;
  const branchProblem = typedBranch ? branchNameProblem(typedBranch) : undefined;
  const branchError = branchProblem && `"${typedBranch}" can't be a branch name: ${branchProblem}`;
  const branchErrorId = useId();
  const suggested = !chosen ? '' : issue ? issueBranch(chosen.branchPrefix, issue) : draft.trim() ? suggestBranch(chosen.branchPrefix, draft) : '';
  // The model and Effort picked; until then, the agent's own.
  const models = useCheckoutModels(chosen?.id);
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<string>();
  const efforts = effortsOf(models.listed, model);
  const commands = useAgentCommands(chosen?.id);
  // The Approval mode picked; until then, the default from Settings.
  const approvalModeDefault = useTopic('settings')?.approvalModeDefault ?? 'supervised';
  const [pickedMode, setApprovalMode] = useState<ApprovalMode>();
  const approvalMode = pickedMode ?? approvalModeDefault;
  const forgetDraft = useForgetDraft();
  // Esc gives up, but for what was typed: only Cancel throws that away.
  const escape = useRef<() => void>(undefined);
  escape.current = () => !draft.trim() && editedBranch === undefined && onCancel();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isFreeEscape(event)) return;
      event.preventDefault();
      escape.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // The prompt takes the focus from the start, unless the issue picker opens first; then once an issue is picked.
  const [focusRequest, setFocusRequest] = useState(pickIssue ? 0 : 1);

  const start = async (prompt: string, attachments: NewAttachment[]) => {
    if (!chosen) return false;
    setError(undefined);
    const params = workingCopyParams(workingCopy, { existing, branch: editedBranch, base: pickedBase });
    try {
      const pick = { ...(model !== undefined && { model }), ...(effort !== undefined && efforts.includes(effort) && { effort }) };
      onStarted(await api.invoke('sessions.create', { projectId: chosen.id, ...params, ...(issue ? { issue } : {}), ...pick, approvalMode, prompt, ...(attachments.length ? { attachments } : {}) }));
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
        <span className="grow" />
        <button
          type="button"
          title="Cancel (Esc)"
          onClick={() => {
            forgetDraft(NEW_SESSION_DRAFT);
            onCancel();
          }}
        >
          Cancel
        </button>
      </div>
      <div className="chat">
        {projects.length === 0 && <div className="empty">Add a Project before starting a Session.</div>}
      </div>
      {chosen && (
        <Composer
          agent={OPENCODE_NAME}
          placeholder={needsWorktree ? 'Pick the worktree to work in first.' : `Tell ${OPENCODE_NAME} what to do…`}
          tips={!needsWorktree}
          focusRequest={focusRequest}
          onSend={start}
          onDraftChange={setDraft}
          draftKey={NEW_SESSION_DRAFT}
          loadFiles={() => api.invoke('projects.files', { id: chosen.id, ...filesRef(workingCopy, { existing, base }) })}
          commands={commands}
          canSendEmpty={!!issue}
          disabled={needsWorktree}
          held={!!branchError}
          remarks={
            (error || stale || branchError) && (
              <>
                {branchError && (
                  <div className="err" role="alert" id={branchErrorId}>
                    {branchError}
                  </div>
                )}
                {stale && (
                  <div className="muted" role="status" title={stale}>
                    Couldn't refresh origin, using what's here.
                    <button type="button" className="link" disabled={refreshing} onClick={refresh}>
                      Retry
                    </button>
                  </div>
                )}
                {error && (
                  <div className="err" role="alert">
                    {error}
                  </div>
                )}
              </>
            )
          }
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
                  // Why the old Project's Session couldn't start says nothing of this one.
                  setError(undefined);
                  setFocusRequest((n) => n + 1);
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
              <Select<ApprovalMode>
                variant="compact"
                label="Approvals"
                icon={approvalMode === 'full' ? <ShieldOff className="sm" /> : <ShieldCheck className="sm" />}
                className={approvalMode === 'full' ? 'full-access' : undefined}
                value={approvalMode}
                options={(Object.keys(APPROVAL_MODES) as ApprovalMode[]).map((mode) => ({ value: mode, label: APPROVAL_MODES[mode].label }))}
                onChange={setApprovalMode}
              />
              <Select<WorkingCopyChoice>
                variant="compact"
                label="Working copy"
                value={workingCopy}
                options={[
                  { value: 'worktree', label: 'New worktree' },
                  ...(offersExisting ? [{ value: 'existing' as const, label: 'Existing worktree' }] : []),
                  { value: 'checkout', label: branches?.checkoutBranch ? `Stay on ${branches.checkoutBranch}` : 'Stay on current branch' },
                ]}
                onChange={setPickedWorkingCopy}
              />
              <IssuePicker
                project={chosen}
                defaultOpen={pickIssue}
                issue={issue}
                onChange={(picked) => {
                  setIssue(picked);
                  setEditedBranch(undefined);
                  if (picked) setFocusRequest((n) => n + 1);
                }}
              />
              {workingCopy === 'existing' && (
                <SearchPicker
                  label="Worktree"
                  placeholder="Pick a worktree"
                  icon={<FolderTree className="sm" />}
                  noun="worktrees"
                  loading="Listing branches…"
                  options={branches ? { value: existingOptions(branches) } : unlisted}
                  selected={existing && existingKey(existing)}
                  onOpen={refresh}
                  onChange={setExisting}
                />
              )}
              {workingCopy === 'worktree' && (
                <SearchPicker
                  label="Branch from"
                  placeholder="Pick a branch"
                  icon={<GitBranch className="sm" />}
                  noun="branches"
                  loading="Listing branches…"
                  options={branches ? { value: branches.bases.map((branch) => ({ ...baseKey(branch), value: branch })) } : unlisted}
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
                    aria-invalid={branchError ? true : undefined}
                    aria-describedby={branchError ? branchErrorId : undefined}
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
 * What a Session on the Project `projectId` can start from or work in, listed
 * by main (fetching origin) when the Project is chosen and again on
 * `refresh`, the last list staying until the new one comes (`refreshing`
 * meanwhile); nothing while `projectId` is undefined.
 */
function useBranches(projectId: number | undefined): { listed: Loaded<Branches>; refresh: () => void; refreshing: boolean } {
  const api = useApi();
  const [listed, setListed] = useState<{ projectId: number; generation: number; result: NonNullable<Loaded<Branches>> }>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (projectId === undefined) return;
    let current = true;
    api
      .invoke('projects.branches', { id: projectId })
      .then((value) => current && setListed({ projectId, generation, result: { value } }))
      .catch((e: unknown) => current && setListed({ projectId, generation, result: { error: (e as Error).message } }));
    return () => {
      current = false;
    };
  }, [api, projectId, generation]);
  const refresh = useCallback(() => setGeneration((n) => n + 1), []);
  const shown = listed && listed.projectId === projectId ? listed : undefined;
  return { listed: shown?.result, refresh, refreshing: !!shown && shown.generation !== generation };
}

/** An action asked of the open Session from outside it: by the palette or a shortcut. */
export type SessionCommand =
  | 'archive'
  | 'delete'
  | 'openMergeRequest'
  | 'requestMergeRequest'
  | 'linkMergeRequest'
  | 'toggleMergeRequest'
  | 'openInEditor'
  | 'openInTerminal'
  | 'retry'
  | 'markUnread'
  | 'toggleSideArea'
  | 'toggleChanges'
  | 'reviewChanges'
  | 'sessionDetails'
  | 'toggleTerminal';

/**
 * One Session: its header, its conversation and the composer, with its Panels
 * in the Side area beside them and the Dock under them. Showing it
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
}: {
  session: Session;
  replyRequest?: number;
  command?: SessionCommand;
  onCommandDone?: () => void;
  onRetryableChange?: (retryable: boolean) => void;
}) {
  const api = useApi();
  const items = useTopic('transcript', { sessionId: session.id }) ?? [];
  const project = useTopic('projects')?.find((p) => p.id === session.projectId);
  const commands = useAgentCommands(project?.id, session.agentCommands);
  const removedProject = useRemovedProject(session.projectId);
  // An archived Session takes a message, which reopens it, while its Project is there.
  const readOnly = session.status === 'archived' && !project;
  const [error, setError] = useState<string>();
  /** The header's popover open, if any: Session details, the Merge request's checks, Link issue or the ⋯ menu. */
  const [popover, setPopover] = useState<HeaderPopover>();
  /** Where the Merge request Panel was last asked to take the user. */
  const [mergeRequestFocus, setMergeRequestFocus] = useState<MergeRequestFocus>();
  /** The Merge request Panel's tab: its overview, or its diff, which alone can take Review mode. */
  const [mergeRequestTab, setMergeRequestTab] = useState<MergeRequestTab>('overview');
  const runsTerminals = canRunTerminals(session);
  const terminals = useTopic('terminals', { sessionId: session.id });
  const panels = usePanels(session.id, terminals);
  /** Shows the Merge request Panel, at its link form or its reviews when asked. */
  const showMergeRequest = (to?: MergeRequestFocus['to']) => {
    panels.show('merge-request');
    // The reviews are on the Overview, which leaves Review mode.
    if (to === 'reviews') showMergeRequestTab('overview');
    if (to) setMergeRequestFocus((was) => ({ to, n: (was?.n ?? 0) + 1 }));
  };
  /** Switches the Merge request Panel's tab: off its diff, it leaves Review mode. */
  const showMergeRequestTab = (tab: MergeRequestTab) => {
    setMergeRequestTab(tab);
    if (tab !== 'diff' && panels.review === 'merge-request') panels.leaveReview();
  };
  /** Whether `panel` can take Review mode now: the Merge request Panel only on its Diff tab. */
  const canReview = (panel: PanelId) => kindOf(panel) !== 'merge-request' || mergeRequestTab === 'diff';
  const { side, dock } = panels.state;
  const sideShown = panels.sideShown;
  // The Dock holds Terminals, and whatever Panels were moved there, which any Session can show.
  const hasDock = runsTerminals || dock.panels.length > 0;
  const archiver = useArchive();
  const deleter = useDelete();
  const toast = useToast();
  const conversation = useRef<HTMLDivElement>(null);
  /**
   * Where the focus goes when the composer can't keep it, disabled while the
   * agent waits on an answer: the card or panel asking, else the conversation.
   */
  const focusAsked = () => {
    const main = conversation.current?.closest('main');
    // A question is answered in its panel on the composer, rather than on its card.
    (main?.querySelector<HTMLElement>('.ask-panel[data-asked]') ?? main?.querySelector<HTMLElement>('[data-asked]') ?? conversation.current)?.focus();
  };
  const menu = useSessionMenu(session, setError);
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
  const pickersDisabled = working || asked || readOnly || !!session.worktreeMissing;
  const { agentConfig } = session;
  // Until the agent says what it offers (it hasn't started since the Client did), the checkout's models.
  const checkoutModels = useCheckoutModels(agentConfig ? undefined : project?.id);
  const shownModel = session.model ?? agentConfig?.model;
  /** A model's name as the agent gives it, or else its id. */
  const modelName = (model: string | undefined) => {
    if (model === undefined) return undefined;
    const offered = agentConfig?.models ?? (checkoutModels.listed && 'value' in checkoutModels.listed ? checkoutModels.listed.value : []);
    return offered.find((m) => m.id === model)?.name || model;
  };
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
      delete: async () => deleter.delete(session),
      openMergeRequest: () => api.invoke('links.open', { url: session.mergeRequest!.url }),
      requestMergeRequest: () => api.invoke('sessions.requestMergeRequest', { id }),
      linkMergeRequest: async () => showMergeRequest('link'),
      toggleMergeRequest: async () => panels.toggle('merge-request'),
      openInEditor: () => api.invoke('sessions.openInEditor', { id }),
      openInTerminal: () => api.invoke('sessions.openInTerminal', { id }),
      retry: () => (retryable ? api.invoke('sessions.retry', { id }) : Promise.resolve()),
      markUnread: async () => {
        await api.invoke('sessions.setUnread', { id, unread: true });
        toast.show({ message: `Marked “${session.title}” unread`, undo: () => api.invoke('sessions.setUnread', { id, unread: false }) });
      },
      toggleSideArea: async () => panels.toggleArea('side'),
      toggleChanges: async () => panels.toggle('changes'),
      reviewChanges: async () => panels.toggleReview('changes'),
      sessionDetails: async () => setPopover((open) => (open?.kind === 'details' ? undefined : { kind: 'details', from: 'title' })),
      toggleTerminal: async () => {
        if (runsTerminals) panels.toggleTerminal();
      },
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

  /** The comments on the diff or the conversation to go with the next message: chips in the composer, and notes in the diff. */
  const [pending, setPending] = useKeptState<PendingComment[]>(sessionDraft(session.id), 'comments', []);
  const comments = useMemo(() => pending.map((p) => p.comment), [pending]);
  const send = async (prompt: string, attachments: NewAttachment[]) => {
    setError(undefined);
    try {
      if (freeAnswer) return await freeAnswer.send(prompt);
      await api.invoke('sessions.send', { id: session.id, prompt, ...(attachments.length ? { attachments } : {}), ...(comments.length ? { comments } : {}) });
      setPending([]);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  /** What the composer is for right now, when it isn't for a reply. */
  const composerSituation = (): string | undefined => {
    if (working) return `Queue a message for when ${session.agent} finishes…`;
    if (freeAnswer) return freeAnswer.placeholder;
    if (firstAsked?.kind === 'approval') return 'Approve or deny the request above to go on.';
    if (asked) return 'Answer the question above to go on.';
    if (readOnly) return removedProject ? "This Session's Project was removed." : 'This Session is archived.';
    if (session.worktreeMissing) return "This Session's worktree is missing; it can only be archived.";
    return undefined;
  };
  const situation = composerSituation();

  /** Runs a command on the Session, showing why if it fails; resolves to whether it went through. */
  const runCommand = async (run: () => Promise<unknown>): Promise<boolean> => {
    setError(undefined);
    try {
      await run();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const openLink = (url: string) => void api.invoke('links.open', { url }).catch((e: unknown) => setError((e as Error).message));
  const retry = () => runCommand(() => api.invoke('sessions.retry', { id: session.id }));
  // Loom quit or crashed during the run, which the agent can go on with.
  const continuable = session.status === 'waiting' && session.waitingReason === 'interrupted' && !session.worktreeMissing;

  // Comments can go with the next message: not while the composer takes none, nor with an answer to a question.
  const composerDisabled = readOnly || (asked && !freeAnswer) || !!session.worktreeMissing;
  /** Comment…, on a right-click of text selected in the conversation: the passage and a note go to the composer as a chip. */
  const commentOnSelection = (event: ReactMouseEvent<HTMLElement>) => {
    const quote = selectedText().trim();
    const selection = window.getSelection();
    const inside = selection && selection.rangeCount > 0 && event.currentTarget.contains(selection.getRangeAt(0).commonAncestorContainer);
    if (!quote || !inside) return;
    addToContextMenu(event, [
      {
        label: 'Comment…',
        icon: MessageSquareQuote,
        disabled: composerDisabled || !!freeAnswer,
        open: (anchor, close) => (
          <CommentNoteForm
            anchor={anchor}
            label="Comment on the conversation"
            quote={quote}
            onClose={close}
            onSave={(note) => {
              close();
              setPending((list) => [...list, { comment: { quote, note } }]);
            }}
          />
        ),
      },
    ]);
  };

  const removeComment = (index: number) => setPending((list) => list.filter((_, i) => i !== index));
  const diffComments: DiffComments = {
    pending: pending.flatMap((p, index) => (p.range ? [{ index, comment: p.comment, range: p.range }] : [])),
    add: (comment, range) => setPending((list) => [...list, { comment, range }]),
    remove: removeComment,
  };

  /** The review threads resolved here, by when Babysit last read them then: left out until it reads them again. */
  const [resolved, setResolved] = useState<ReadonlyMap<string, number | undefined>>(new Map());
  const lastPollAt = session.babysit?.lastPollAt;
  const threads = session.babysit?.threads?.filter((thread) => !resolved.has(thread.id) || resolved.get(thread.id) !== lastPollAt);
  // Replying and resolving work on the Forge from the Project's checkout: the worktree needn't be there.
  const actOnThreads = session.status !== 'archived' && project?.forge.state === 'available';
  const reviewNotes: ReviewNotes | undefined = threads?.length
    ? {
        threads,
        forge: project?.forge.kind,
        onOpen: openLink,
        ...(actOnThreads
          ? {
              reply: (thread, body) => api.invoke('sessions.replyToReviewThread', { id: session.id, thread: thread.id, body }),
              resolve: async (thread) => {
                await api.invoke('sessions.resolveReviewThread', { id: session.id, thread: thread.id });
                setResolved((ids) => new Map(ids).set(thread.id, lastPollAt));
              },
            }
          : {}),
      }
    : undefined;

  /** Where Changes was last asked to take the user: a file a Highlight or a review comment names. */
  const [changesFocus, setChangesFocus] = useState<ChangesFocus>();
  /**
   * Scrolls the conversation to the turn `itemId` is in: to the user's
   * message it starts with, the last at or before it (the first, for an item
   * before any). A drawer over the conversation closes to show it.
   */
  const showTurn = (itemId: number) => {
    if (panels.drawer) panels.closeDrawer();
    const messages = [...document.querySelectorAll<HTMLElement>('[data-item-id]')];
    const target = messages.filter((m) => Number(m.dataset.itemId) <= itemId).at(-1) ?? messages[0];
    target?.scrollIntoView?.({ block: 'start' });
  };
  /** Shows Changes, at `path`. */
  const showFile = (path: string) => {
    setChangesFocus((was) => ({ path, n: (was?.n ?? 0) + 1 }));
    panels.show('changes');
  };
  /** Ask the agent, on a Highlight: it goes to the composer as a comment quoting it, its note to edit. */
  const askAboutHighlight = (highlight: Highlight) =>
    setPending((list) => [...list, { comment: { quote: highlightLine(highlight), note: 'Can you look into this?' } }]);

  /** A Panel's content, in whichever area it sits. */
  const renderPanel = (panel: PanelId) => {
    switch (kindOf(panel)) {
      case 'changes':
        return <ChangesView session={session} comments={diffComments} reviews={reviewNotes} focus={changesFocus} />;
      case 'merge-request':
        return (
          <MergeRequestPanel
            session={session}
            project={project}
            focus={mergeRequestFocus}
            tab={mergeRequestTab}
            onTab={showMergeRequestTab}
            // As on Changes: comments go with the next message, which an archived Session's diff doesn't take.
            comments={session.status === 'archived' || session.worktreeMissing ? undefined : diffComments}
            reviewNotes={reviewNotes}
            onError={setError}
          />
        );
      case 'issue':
        return <IssuePanel session={session} project={project} onUnlinked={() => panels.close('issue')} onError={setError} />;
      case 'highlights':
        return (
          <HighlightsPanel
            session={session}
            onShowTurn={showTurn}
            onShowFile={showFile}
            onAsk={composerDisabled || freeAnswer ? undefined : askAboutHighlight}
            onError={setError}
          />
        );
      case 'terminal': {
        const terminal = terminals?.find((t) => t.id === terminalOf(panel));
        return terminal && <TerminalView key={terminal.id} terminal={terminal} focusPending={panels.focus === panel} onFocused={panels.onFocused} />;
      }
    }
  };

  const StatusGlyph = status.icon;
  const statusIcon = <StatusGlyph className="sm" />;
  return (
    <main className="main" aria-label="Session">
      <SessionHeader
        session={session}
        project={project}
        removedProject={removedProject}
        status={{ ...status, icon: working ? <span className="spin">{statusIcon}</span> : statusIcon }}
        flags={isSnoozed(session) && <Snoozed session={session} onError={setError} />}
        popover={popover}
        onPopover={setPopover}
        side={{ shown: sideShown, onToggle: () => panels.toggleArea('side') }}
        dock={hasDock ? { shown: dock.open, onToggle: () => panels.toggleArea('dock') } : undefined}
        menu={menu}
        onShowChanges={() => panels.show('changes')}
        onShowMergeRequest={showMergeRequest}
        onShowIssue={() => panels.show('issue')}
        onError={setError}
      >
        {archiver.dialog}
        {deleter.dialog}
        {menu.dialogs}
      </SessionHeader>
      <div className={panels.review ? 'session-body reviewing' : 'session-body'}>
        <div className="convo">
          <div ref={conversation} className="chat" role="log" aria-label="Conversation" tabIndex={-1} onContextMenu={commentOnSelection}>
            {turnParts(items).map((item) =>
              'said' in item ? (
                <AgentWords key={item.said[0]!.id} agent={session.agent} said={item.said} model={modelName(item.said.find((i) => i.model)?.model)} />
              ) : item.kind === 'user' ? (
                <div key={item.id} className="msg user" data-item-id={item.id}>
                  <div className="body" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div className="bubble">
                      {item.text && <Markdown text={item.text} flavour="user" />}
                      {item.attachments && <AttachmentList attachments={item.attachments} />}
                    </div>
                  </div>
                </div>
              ) : item.kind === 'tool' ? (
                <ToolCard key={item.id} item={item} />
              ) : item.kind === 'plan' ? (
                <PlanCard key={item.id} item={item} />
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
                  onShowPlace={showFile}
                />
              ) : item.kind === 'feedback-info' ? (
                <FeedbackInfoCard key={item.id} item={item} onOpen={() => openLink(item.url)} />
              ) : item.kind === 'merge-request-ended' ? (
                <MergeRequestEndedCard key={item.id} item={item} forge={project?.forge.kind} onOpen={() => openLink(item.url)} />
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
            placeholder={situation ?? `Reply to ${session.agent}…`}
            tips={situation === undefined}
            disabled={composerDisabled}
            dock={panel}
            clearKey={stepKey}
            focusRequest={replyRequest}
            onSend={send}
            canAttach={!freeAnswer}
            loadFiles={readOnly || session.worktreeMissing ? undefined : () => api.invoke('sessions.files', { id: session.id })}
            commands={commands}
            // Not with an answer to a question: they wait for the next message.
            comments={freeAnswer ? undefined : comments}
            onRemoveComment={removeComment}
            onEditComment={(index, note) => setPending((list) => list.map((p, i) => (i === index ? withNote(p, note) : p)))}
            // Out to the conversation, where the shortcuts without Ctrl work.
            onEscape={() => conversation.current?.focus()}
            onDisabledWithFocus={focusAsked}
            draftKey={sessionDraft(session.id)}
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
                  onEdit={(queuedId, text) => runCommand(() => api.invoke('sessions.editQueued', { id: session.id, queuedId, text }))}
                  onEditLost={() => setError('The queued message was sent before your edit was saved.')}
                />
              ) : undefined
            }
          />
        </div>
        {panels.ready && (sideShown || panels.review) && (
          <PanelArea area="side" session={session} terminals={terminals} control={panels} canReview={canReview} render={renderPanel} />
        )}
      </div>
      {panels.ready && hasDock && dock.open && (
        <PanelArea area="dock" session={session} terminals={terminals} control={panels} render={renderPanel} />
      )}
    </main>
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

/** The messages waiting to be sent, oldest first: each can be edited in place, removed, or sent now (or steered in, if the agent can be). */
function Queue({
  queue,
  steer,
  onSendNow,
  onSteer,
  onRemove,
  onEdit,
  onEditLost,
}: {
  queue: QueuedMessage[];
  steer: boolean;
  onSendNow: (queuedId: number) => void;
  onSteer: (queuedId: number) => void;
  onRemove: (queuedId: number) => void;
  /** Resolves to whether main took the edit. */
  onEdit: (queuedId: number, text: string) => Promise<boolean>;
  /** The message being edited left the queue, sent as it was, before the edit was saved. */
  onEditLost: () => void;
}) {
  /** The message being edited, if any. */
  const [editing, setEditing] = useState<number>();
  const lost = editing !== undefined && !queue.some((m) => m.id === editing);
  useEffect(() => {
    if (!lost) return;
    setEditing(undefined);
    onEditLost();
  }, [lost]);
  return (
    <ul className="queue" aria-label="Queued messages">
      {queue.map((message) =>
        editing === message.id ? (
          <QueuedMessageEditor
            key={message.id}
            message={message}
            onSave={async (text) => {
              if (await onEdit(message.id, text)) setEditing((now) => (now === message.id ? undefined : now));
            }}
            onCancel={() => setEditing(undefined)}
          />
        ) : (
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
            <button className="icon-btn sm" type="button" title="Edit" aria-label="Edit" onClick={() => setEditing(message.id)}>
              <Pencil className="sm" />
            </button>
            <button className="icon-btn sm" type="button" title="Remove" aria-label="Remove" onClick={() => onRemove(message.id)}>
              <X className="sm" />
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/** A queued message's line while it is edited, in place: Enter or Save saves, Escape or Cancel leaves it as it was. */
function QueuedMessageEditor({ message, onSave, onCancel }: { message: QueuedMessage; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(message.text);
  const [saving, setSaving] = useState(false);
  const canSave = !saving && !hasNothingToSend({ text, attachments: message.attachments });
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(text);
    } finally {
      setSaving(false);
    }
  };
  return (
    <li className="editing">
      <ListPlus className="sm" />
      <textarea
        className="grow"
        aria-label="Queued message"
        rows={1}
        value={text}
        autoFocus
        onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void save();
          } else if (event.key === 'Escape') {
            // Taken here: not the view's Escape too.
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </li>
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

/** A Snoozed Session's mark in its header: until when, and Wake, to bring it back now. */
function Snoozed({ session, onError }: { session: Session; onError: (message: string | undefined) => void }) {
  const api = useApi();
  const now = useNow();
  const until = session.snoozedUntil!;
  return (
    <>
      <span className="chip" role="status" aria-label="Snoozed" title={new Date(until).toLocaleString()}>
        <AlarmClock className="sm" />
        Snoozed until {wakeTime(until, now)}
      </span>
      <button
        className="icon-btn sm"
        type="button"
        title="Wake"
        aria-label="Wake"
        onClick={() => {
          onError(undefined);
          api.invoke('sessions.snooze', { id: session.id, until: null }).catch((e: unknown) => onError((e as Error).message));
        }}
      >
        <AlarmClockOff />
      </button>
    </>
  );
}

/** Something the agent said: its thinking, or its words. */
type Said = Extract<TranscriptItem, { kind: 'agent' | 'thinking' }>;

/**
 * The conversation as shown: what the agent said in a row by the same model,
 * its thinking and then its words, gathered under one name line; every other
 * item as it is.
 */
function turnParts(items: TranscriptItem[]): Array<Exclude<TranscriptItem, Said> | { said: Said[] }> {
  const parts: Array<Exclude<TranscriptItem, Said> | { said: Said[] }> = [];
  for (const item of items) {
    if (item.kind !== 'agent' && item.kind !== 'thinking') {
      parts.push(item);
      continue;
    }
    const last = parts.at(-1);
    // Thinking after words starts the agent's next step.
    const joins = last && 'said' in last && last.said[0]!.model === item.model && !(item.kind === 'thinking' && last.said.at(-1)!.kind === 'agent');
    if (joins) last.said.push(item);
    else parts.push({ said: [item] });
  }
  return parts;
}

/** The agent's name, and the model that spoke when known ("OpenCode · Claude Sonnet 5.5"), over its thinking and its words. */
function AgentWords({ agent, said, model }: { agent: string; said: Said[]; model: string | undefined }) {
  return (
    <div className="msg agent">
      <div className="who">
        <Bot />
      </div>
      <div className="body">
        <div className="name">
          {agent}
          {model && (
            <>
              {' · '}
              <span className="tech">{model}</span>
            </>
          )}
        </div>
        {said.map((item) =>
          item.kind === 'thinking' ? (
            <ThinkingBlock key={item.id} item={item} />
          ) : (
            <div key={item.id} className="bubble">
              <Markdown text={item.text} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
