// The window's panes, following docs/prototypes/ui-layout.html: the Inbox
// sidebar, the main pane and the open Session's Side area, with Projects, the
// Dashboard or Settings in a window over them. Also the Ctrl+K palette and
// the keyboard shortcuts, which run the same actions.
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowLeftToLine,
  ArrowRightToLine,
  ChartColumn,
  CircleDot,
  CodeXml,
  ExternalLink,
  FileDiff,
  FolderGit2,
  FolderOpen,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestCreate,
  Info,
  Keyboard,
  Link,
  Mail,
  Maximize2,
  MessageSquarePlus,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  Plus,
  Reply,
  RotateCw,
  Search,
  Settings as SettingsIcon,
  SquareTerminal,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { forgeName, mergeRequestRef, type Project, type Session } from '../shared/api';
import { MATCH_SYSTEM_LABEL, THEMES, type Theme, type ThemeChoice } from '../shared/appearance';
import { useApi, useTopic } from './api';
import { useAppearance } from './appearance';
import { DatesProvider } from './dates';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { DatabaseProblem } from './DatabaseProblem';
import { inboxOrder, InboxList } from './Inbox';
import { Logo } from './Logo';
import { Popover } from './Popover';
import { PageWindow, type Page } from './PageWindow';
import { ProjectPicker } from './ProjectPicker';
import { Dashboard } from './Dashboard';
import { Projects, useProjectAdder } from './Projects';
import { DraftsProvider } from './drafts';
import { NewSession, SessionView, type NewSessionWorkingCopy, type SessionCommand } from './Sessions';
import { NewSessionContext } from './SessionMenu';
import { ContextMenuHost } from './ContextMenu';
import { Settings } from './Settings';
import { canSnooze, isSnoozed } from './Snooze';
import { ShortcutHelp } from './ShortcutHelp';
import { BindingsProvider, isTerminalShortcut, matchesShortcut, shortcutLabel, SHORTCUTS, typingGuard, useBindings, type Bindings, type ShortcutName } from './shortcuts';
import { ToastHost, useToast } from './Toast';
import { Welcome } from './Welcome';
import { ResizeEdge } from './ResizeEdge';
import { useInbox, useWindowSize, WindowLayoutProvider } from './WindowLayout';
import { INBOX_WIDTH, windowLayout } from '../shared/window';

/** What the main pane shows; a Page opens over it. */
type View = 'session' | 'new-session';

/** `systemLocale` is the system's regional format, when main has said already. */
export function App({ systemLocale }: { systemLocale?: string } = {}) {
  const database = useTopic('database');
  // Nothing else can be served until main knows its database is usable.
  if (!database) return null;
  if (database.state === 'damaged') return <DatabaseProblem status={database} />;
  return (
    <BindingsProvider>
      <DatesProvider systemLocale={systemLocale}>
        <ToastHost>
          <DraftsProvider>
            <Workspace />
          </DraftsProvider>
        </ToastHost>
      </DatesProvider>
    </BindingsProvider>
  );
}

/** The Page open over the main pane, and where focus goes back when it closes. */
interface OpenPage {
  name: Page;
  returnFocus: HTMLElement | null;
}

/** The Project picker, while open: for any new Session or one from an issue, and where focus goes back to. */
interface Picking {
  fromIssue: boolean;
  returnFocus: HTMLElement | null;
}

function Workspace() {
  useAppearance();
  const api = useApi();
  const [view, setView] = useState<View>('session');
  /** The Page open over the main pane, and where focus was before it opened. */
  const [page, setPage] = useState<OpenPage>();
  // A worktree may be deleted while Loom is in the background: look again on focus.
  useEffect(() => {
    const check = () => {
      api.invoke('sessions.check').catch((error: unknown) => console.error('session check failed:', error));
    };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [api]);
  const adder = useProjectAdder();
  const toast = useToast();
  const sessions = useTopic('sessions') ?? [];
  const loadedProjects = useTopic('projects');
  const projects = loadedProjects ?? [];
  const [selectedId, setSelectedId] = useState<number>();
  /** Bumped to focus the open Session's composer. */
  const [replyRequest, setReplyRequest] = useState(0);
  /** What the open Session is asked to do next, until it has. */
  const [command, setCommand] = useState<SessionCommand>();
  /** Whether the open Session's last prompt failed, so it can be sent again. */
  const [retryable, setRetryable] = useState(false);
  /** The Project picked for the New Session view; each pick starts it afresh. */
  /** `from` is the view it was started from, and the Page open over it, which Cancel goes back to. */
  const [newSession, setNewSession] = useState<{ projectId?: number; fromIssue?: boolean; workingCopy?: NewSessionWorkingCopy; from: { view: View; page?: OpenPage }; generation: number }>({
    from: { view: 'session' },
    generation: 0,
  });
  const [picking, setPicking] = useState<Picking>();
  /** The palette, while open, and where focus was before it. */
  const [palette, setPalette] = useState<{ returnFocus: HTMLElement | null }>();
  /** The shortcuts list, while open, and where focus was before it. */
  const [help, setHelp] = useState<{ returnFocus: HTMLElement | null }>();
  const selected = sessions.find((s) => s.id === selectedId);
  /** The Session in the main pane, under any Page. */
  const behind = view === 'session' ? selected : undefined;
  /** The Session shown, which actions act on: none while a Page covers it. */
  const shown = page ? undefined : behind;
  /** Opens a Page over the main pane, or another in its place. */
  const openPage = (name: Page) => setPage((open) => ({ name, returnFocus: open ? open.returnFocus : focusedElement() }));
  /** Closes the Page, focus going back where it was. */
  const closePage = () => {
    if (page?.returnFocus?.isConnected) page.returnFocus.focus();
    setPage(undefined);
  };
  const select = (session: Session) => {
    setSelectedId(session.id);
    setCommand(undefined);
    setView('session');
    setPage(undefined);
  };
  const reply = (session: Session) => {
    select(session);
    setReplyRequest((n) => n + 1);
  };
  /** Starts the New Session view afresh, Cancel going back to the view before it. */
  const openNewSession = (start: { projectId?: number; fromIssue?: boolean; workingCopy?: NewSessionWorkingCopy }) => {
    setNewSession((n) => ({ ...start, from: view === 'new-session' ? n.from : { view, page }, generation: n.generation + 1 }));
    setView('new-session');
    setPage(undefined);
  };
  const startNewSession = (project: Project | undefined, fromIssue = false) => openNewSession({ projectId: project?.id, fromIssue });
  /** New Session on a Project's working copy, from another Session's menu. */
  const startNewSessionOn = (projectId: number, workingCopy: NewSessionWorkingCopy) => openNewSession({ projectId, workingCopy });
  /** New Session asks for the Project first, when there is one to pick. */
  const pickProject = (returnFocus: HTMLElement | null, fromIssue = false) => {
    if (fromIssue || projects.length) setPicking({ fromIssue, returnFocus });
    else startNewSession(undefined);
  };
  const addProject = () => {
    openPage('projects');
    void adder.link();
  };
  const forgeProjects = projects.filter((p) => p.forge.state === 'available');
  const inbox = useInbox();
  const windowSize = useWindowSize();
  const layout = { ...windowLayout(windowSize.width, inbox.value), height: windowSize.height };

  const waiting = inboxOrder(sessions, projects);
  const bindings = useBindings();
  const actions = paletteActions({
    bindings,
    projects,
    forgeProjects,
    session: shown,
    nextWaiting: stepWaiting(waiting, shown, 1),
    previousWaiting: stepWaiting(waiting, shown, -1),
    retryable,
    reply,
    newSession: (returnFocus) => pickProject(returnFocus),
    newSessionFromIssue: (returnFocus) => pickProject(returnFocus, true),
    addProject,
    select,
    command: setCommand,
    setTheme: (theme) => {
      api.invoke('settings.setAppearance', { theme }).catch((error: unknown) => console.error('theme change failed:', error));
    },
    openPage,
    showHelp: (returnFocus) => setHelp({ returnFocus }),
    toggleInbox: inbox.toggle,
  });

  const openPalette = () => setPalette({ returnFocus: focusedElement() });
  const closePalette = () => {
    palette?.returnFocus?.focus();
    setPalette(undefined);
  };
  const closeHelp = () => {
    help?.returnFocus?.focus();
    setHelp(undefined);
  };
  const latest = useRef({ palette, openPalette, closePalette, help, closeHelp, actions, waiting, select, bindings });
  latest.current = { palette, openPalette, closePalette, help, closeHelp, actions, waiting, select, bindings };
  // Main keeps quiet about the Session shown while the window has the focus.
  const shownId = shown?.id ?? null;
  useEffect(() => {
    api.invoke('window.showing', { sessionId: shownId }).catch((error: unknown) => console.error('telling main the Session shown failed:', error));
  }, [api, shownId]);
  // A click on a desktop notification opens its Session, over the palette or the shortcuts list; one
  // made before this window loaded is left, as is one already handled when subscribing again.
  const sessionsNow = useRef(sessions);
  sessionsNow.current = sessions;
  const lastClick = useRef<number>(undefined);
  useEffect(
    () =>
      api.subscribe('openSession', (request) => {
        const seen = lastClick.current;
        lastClick.current = request?.click ?? 0;
        if (seen === undefined || !request || request.click === seen) return;
        const session = sessionsNow.current.find((s) => s.id === request.sessionId);
        if (!session) return;
        setPalette(undefined);
        setHelp(undefined);
        latest.current.select(session);
      }),
    [api],
  );
  useEffect(() => {
    const typing = typingGuard();
    const onPointerDown = () => typing.reset();
    const onKeyDown = (event: KeyboardEvent) => {
      const { palette, openPalette, closePalette, help, closeHelp, actions, waiting, select, bindings } = latest.current;
      // A terminal takes every key but the few shortcuts xterm lets through to here.
      if (event.target instanceof Element && event.target.closest('.terminal-screen') && !isTerminalShortcut(event, bindings)) return;
      if (isTyping(event.target)) typing.typed(event);
      const ctrl = event.ctrlKey || event.metaKey;
      // Not over a dialog, nor a menu or picker, which have keys of their own.
      const covered = () => !!document.querySelector('[aria-modal="true"], .popover');
      // The palette and the shortcuts list close on their own key too; one without Ctrl, only away from typing, as any.
      const anywhere = () => ctrl || (!isTyping(event.target) && !typing.holds());
      if (matchesShortcut(bindings.palette, event) && anywhere()) {
        event.preventDefault();
        if (palette) closePalette();
        else if (!covered()) openPalette();
        return;
      }
      if (help && matchesShortcut(bindings.help, event) && anywhere()) {
        event.preventDefault();
        closeHelp();
        return;
      }
      if (event.altKey || event.defaultPrevented || (!ctrl && isTyping(event.target)) || covered()) return;
      // The toast's Undo; in a text field, the field's own.
      if (matchesShortcut(bindings.undo, event)) {
        if (!isTyping(event.target) && toast.undo()) event.preventDefault();
        return;
      }
      // Keys meant as text, the focus having dropped out of a text field mid-word.
      if (!ctrl && typing.holds()) return;
      // Ctrl+1 to Ctrl+9: the Inbox's Sessions by position, by physical key (AZERTY's 1 types &).
      const position = ctrl && !event.shiftKey ? /^Digit([1-9])$/.exec(event.code)?.[1] : undefined;
      if (position) {
        event.preventDefault();
        const session = waiting[Number(position) - 1];
        if (session) select(session);
        return;
      }
      const action = actions.find((a) => a.shortcut && matchesShortcut(a.shortcut, event));
      if (!action) return;
      event.preventDefault();
      action.run(focusedElement());
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  return (
    <NewSessionContext.Provider value={startNewSessionOn}>
      <WindowLayoutProvider value={layout}>
      <div className="app" style={{ '--inbox-width': `${layout.inboxWidth}px` } as CSSProperties}>
        <ContextMenuHost />
        {inbox.value.open ? (
          <aside className="side" id="inbox" aria-label="Inbox">
            <ResizeEdge
              side="right"
              label="Resize the Inbox"
              controls="inbox"
              size={layout.inboxWidth}
              min={layout.inboxBounds.min}
              max={layout.inboxBounds.max}
              preferred={INBOX_WIDTH.preferred}
              onResize={inbox.resize}
            />
            <div className="side-top">
              <div className="brand">
                <Logo working={sessions.some((s) => s.status === 'working')} /> Loom<span className="grow" />
                <NewMenu onNewSession={(trigger) => pickProject(trigger)} onAddProject={addProject} />
                <button className="icon-btn" type="button" title="Collapse the Inbox" aria-label="Collapse the Inbox" aria-expanded="true" aria-controls="inbox" onClick={inbox.toggle}>
                  <PanelLeftClose />
                </button>
              </div>
              <button className="search" type="button" title="Search Sessions and actions" aria-label="Search Sessions and actions" aria-haspopup="dialog" onClick={openPalette}>
                <Search />
                <span>Search…</span>
                {bindings.palette && <kbd>{shortcutLabel(bindings.palette)}</kbd>}
              </button>
            </div>
            <InboxList sessions={sessions} projects={projects} selectedId={behind?.id} onSelect={select} onReply={reply} />
            <PageNav className="side-foot" page={page?.name} onPage={openPage} />
          </aside>
        ) : (
          <aside className="side rail" id="inbox" aria-label="Inbox">
            <button
              className="icon-btn"
              type="button"
              title={`Show the Inbox: ${waiting.length} Waiting`}
              aria-label="Show the Inbox"
              aria-description={`${waiting.length} Waiting`}
              aria-expanded="false"
              aria-controls="inbox"
              onClick={inbox.toggle}
            >
              <PanelLeftOpen />
              {waiting.length > 0 && (
                <span className="badge" aria-hidden="true">
                  {waiting.length}
                </span>
              )}
            </button>
            <NewMenu onNewSession={(trigger) => pickProject(trigger)} onAddProject={addProject} />
            <button className="icon-btn" type="button" title="Search Sessions and actions" aria-label="Search Sessions and actions" aria-haspopup="dialog" onClick={openPalette}>
              <Search />
            </button>
            <span className="grow" />
            <PageNav className="rail-foot" page={page?.name} onPage={openPage} />
          </aside>
        )}
        {/* Inert under a Page, as it was; it adds no box of its own to the layout. */}
        <div className="main-pane" inert={!!page}>
        {view === 'new-session' ? (
          <NewSession
            key={newSession.generation}
            initialProjectId={newSession.projectId}
            pickIssue={newSession.fromIssue}
            initialWorkingCopy={newSession.workingCopy}
            onStarted={select}
            onAddProject={addProject}
            onCancel={() => {
              // Back to the Page it was started from, focus going back on closing it where it was before that.
              setView(newSession.from.view);
              setPage(newSession.from.page);
            }}
          />
        ) : selected ? (
          <SessionView
            key={selected.id}
            session={selected}
            replyRequest={replyRequest}
            command={command}
            onCommandDone={() => setCommand(undefined)}
            onRetryableChange={setRetryable}
          />
        ) : loadedProjects?.length === 0 ? (
          <Welcome onAddProject={addProject} />
        ) : !loadedProjects ? (
          // Nothing to offer until the Projects are known: the welcome or a New Session.
          <main className="main" aria-label="Session" />
        ) : (
          <main className="main" aria-label="Session">
            <div className="empty">
              No Session selected.
              <button type="button" onClick={(event) => pickProject(event.currentTarget)}>
                <MessageSquarePlus className="sm" />
                {SHORTCUTS.newSession.label}
              </button>
            </div>
          </main>
        )}
        </div>
        {page && (
          <PageWindow page={page.name} onClose={closePage}>
            {page.name === 'settings' ? <Settings /> : page.name === 'dashboard' ? <Dashboard onOpenSession={select} /> : <Projects adder={adder} onStartSession={(project) => startNewSession(project)} />}
          </PageWindow>
        )}
        {picking && (
          <ProjectPicker
            projects={picking.fromIssue ? forgeProjects : projects}
            highlightedId={currentProjectId(selected, sessions)}
            onClose={() => {
              setPicking(undefined);
              picking.returnFocus?.focus();
            }}
            onPick={(project) => {
              setPicking(undefined);
              startNewSession(project, picking.fromIssue);
            }}
          />
        )}
        {help && <ShortcutHelp onClose={closeHelp} />}
        {palette && (
          <CommandPalette
            actions={actions}
            sessions={sessions}
            projects={projects}
            onClose={closePalette}
            onOpenSession={(session) => {
              setPalette(undefined);
              select(session);
            }}
            onRun={(action) => {
              // Back where it was, unless the action opens something taking it.
              palette.returnFocus?.focus();
              setPalette(undefined);
              action.run(palette.returnFocus);
            }}
          />
        )}
      </div>
      </WindowLayoutProvider>
    </NewSessionContext.Provider>
  );
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Whether a key goes to a text field, where it types rather than runs a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'));
}

/**
 * The Waiting Session `step` places from the one shown, in Inbox order,
 * wrapping round; from none shown, the first going forward or the last going
 * back. None when that is the one shown.
 */
function stepWaiting(waiting: Session[], shown: Session | undefined, step: 1 | -1): Session | undefined {
  if (!waiting.length) return undefined;
  const at = shown ? waiting.findIndex((s) => s.id === shown.id) : -1;
  const from = at < 0 && step < 0 ? waiting.length : at;
  const next = waiting[(from + step + waiting.length) % waiting.length];
  return next?.id === shown?.id ? undefined : next;
}

/**
 * The main actions, as far as there is something for them: the palette lists
 * them, in this order, and their shortcuts run them (see Shortcut).
 */
function paletteActions(app: {
  /** Each action's shortcut, as the user has them. */
  bindings: Bindings;
  projects: Project[];
  forgeProjects: Project[];
  session: Session | undefined;
  nextWaiting: Session | undefined;
  previousWaiting: Session | undefined;
  /** Whether the open Session's last prompt failed. */
  retryable: boolean;
  reply: (session: Session) => void;
  newSession: (returnFocus: HTMLElement | null) => void;
  newSessionFromIssue: (returnFocus: HTMLElement | null) => void;
  addProject: () => void;
  select: (session: Session) => void;
  command: (command: SessionCommand) => void;
  setTheme: (theme: ThemeChoice) => void;
  openPage: (page: Page) => void;
  showHelp: (returnFocus: HTMLElement | null) => void;
  toggleInbox: () => void;
}): PaletteAction[] {
  const { session, nextWaiting, previousWaiting } = app;
  /** An action named and keyed as the shortcuts catalog has it, with the user's shortcut. */
  const shortcutAction = (name: ShortcutName, icon: LucideIcon, run: PaletteAction['run']): PaletteAction => ({ label: SHORTCUTS[name].label, icon, shortcut: app.bindings[name], run });
  const project = session && app.projects.find((p) => p.id === session.projectId);
  // A Session whose worktree is missing can only be archived.
  const active = session && session.status !== 'archived' && !session.worktreeMissing ? session : undefined;
  const mergeRequest = active?.mergeRequest;
  const canCreateMergeRequest = active && !mergeRequest && project?.forge.state === 'available';
  const open = session && session.status !== 'archived' ? session : undefined;
  const actions: Array<PaletteAction | false | undefined> = [
    shortcutAction('newSession', MessageSquarePlus, app.newSession),
    app.forgeProjects.length > 0 && shortcutAction('newSessionFromIssue', CircleDot, app.newSessionFromIssue),
    shortcutAction('addProject', FolderOpen, app.addProject),
    nextWaiting && shortcutAction('nextWaiting', ArrowRightToLine, () => app.select(nextWaiting)),
    previousWaiting && shortcutAction('previousWaiting', ArrowLeftToLine, () => app.select(previousWaiting)),
    active?.status === 'waiting' && shortcutAction('reply', Reply, () => app.reply(active)),
    app.retryable && shortcutAction('retry', RotateCw, () => app.command('retry')),
    mergeRequest && {
      ...shortcutAction('mergeRequest', GitPullRequest, () => app.command('toggleMergeRequest')),
      label: `Show Merge request ${mergeRequestRef(project?.forge.kind, mergeRequest.number)} for this Session`,
    },
    mergeRequest && {
      label: `Open Merge request ${mergeRequestRef(project?.forge.kind, mergeRequest.number)} on ${forgeName(project?.forge.kind)}`,
      icon: ExternalLink,
      run: () => app.command('openMergeRequest'),
    },
    canCreateMergeRequest && {
      ...shortcutAction('mergeRequest', GitPullRequestCreate, () => app.command('requestMergeRequest')),
      label: 'Create Merge request for this Session',
    },
    mergeRequest && project?.forge.state === 'available' && {
      label: `Update Merge request ${mergeRequestRef(project.forge.kind, mergeRequest.number)} for this Session`,
      icon: GitPullRequestArrow,
      run: () => app.command('requestMergeRequest'),
    },
    active && project?.forge.state === 'available' && { label: 'Link Merge request…', icon: Link, run: () => app.command('linkMergeRequest') },
    open && shortcutAction('openInEditor', CodeXml, () => app.command('openInEditor')),
    // The user's own terminal app, which Ctrl+` no longer opens.
    open && { label: 'Open in terminal', icon: ExternalLink, run: () => app.command('openInTerminal') },
    active && shortcutAction('toggleTerminal', SquareTerminal, () => app.command('toggleTerminal')),
    shortcutAction('toggleInbox', PanelLeftClose, app.toggleInbox),
    // The Side area is the open Session's: with none, there is none to toggle.
    session && shortcutAction('toggleSideArea', PanelRight, () => app.command('toggleSideArea')),
    session && shortcutAction('toggleDiff', FileDiff, () => app.command('toggleChanges')),
    session && shortcutAction('reviewChanges', Maximize2, () => app.command('reviewChanges')),
    session && shortcutAction('sessionDetails', Info, () => app.command('sessionDetails')),
    active && !active.unread && shortcutAction('markUnread', Mail, () => app.command('markUnread')),
    session && canSnooze(session) && { label: 'Snooze this Session…', icon: AlarmClock, run: () => app.command('snooze') },
    session && isSnoozed(session) && { label: 'Wake this Session', icon: AlarmClockOff, run: () => app.command('wake') },
    // A removed Project's Sessions are read-only.
    session && project && { label: 'Rename this Session…', icon: Pencil, run: () => app.command('rename') },
    // Not from a single key while it waits on an answer: archiving would deny the request, or drop the question. From the palette, deliberately, it still can.
    open && { ...shortcutAction('archive', Archive, () => app.command('archive')), shortcut: awaitsAnswer(open) ? undefined : app.bindings.archive },
    // A removed Project's archived Sessions are read-only.
    session?.status === 'archived' && project && { label: 'Reopen this Session', icon: ArchiveRestore, run: () => app.command('reopen') },
    session && { label: 'Delete this Session…', icon: Trash2, run: () => app.command('delete') },
    { label: `Theme: ${MATCH_SYSTEM_LABEL}`, icon: Palette, run: () => app.setTheme('system') },
    ...(Object.keys(THEMES) as Theme[]).map((theme) => ({ label: `Theme: ${THEMES[theme].label}`, icon: Palette, run: () => app.setTheme(theme) })),
    { label: 'Open Projects', icon: FolderGit2, run: () => app.openPage('projects') },
    { label: 'Open Dashboard', icon: ChartColumn, run: () => app.openPage('dashboard') },
    shortcutAction('settings', SettingsIcon, () => app.openPage('settings')),
    shortcutAction('help', Keyboard, app.showHelp),
  ];
  return actions.filter((action): action is PaletteAction => !!action);
}

/** Whether the Session waits on the user's answer: an Approval request, or a question. */
function awaitsAnswer(session: Session): boolean {
  return session.status === 'waiting' && (session.waitingReason === 'approval' || session.waitingReason === 'question');
}

/** The Project a new Session most likely goes in: the open Session's, else that of the Session most recently active. */
function currentProjectId(selected: Session | undefined, sessions: Session[]): number | undefined {
  if (selected) return selected.projectId;
  return sessions.reduce<Session | undefined>((latest, s) => (!latest || s.updatedAt > latest.updatedAt ? s : latest), undefined)?.projectId;
}

/** The + button's menu of things to start: a Session or a Project. */
function NewMenu({ onNewSession, onAddProject }: { onNewSession: (trigger: HTMLElement | null) => void; onAddProject: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} className="icon-btn" type="button" title="New" aria-label="New" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Plus />
      </button>
      {open && (
        <Popover anchor={trigger} role="menu" label="New" onClose={() => setOpen(false)}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNewSession(trigger.current);
            }}
          >
            <MessageSquarePlus className="sm" />
            New Session
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAddProject();
            }}
          >
            <FolderOpen className="sm" />
            {SHORTCUTS.addProject.label}
          </button>
        </Popover>
      )}
    </>
  );
}

/** The Inbox's foot: Projects, Dashboard and Settings, Settings at the end, each opening its Page over the main pane. */
function PageNav({ className, page, onPage }: { className: string; page: Page | undefined; onPage: (page: Page) => void }) {
  return (
    <nav className={className}>
      <FootButton label="Projects" icon={FolderGit2} current={page === 'projects'} onClick={() => onPage('projects')} />
      <FootButton label="Dashboard" icon={ChartColumn} current={page === 'dashboard'} onClick={() => onPage('dashboard')} />
      <span className="grow" />
      <FootButton label="Settings" icon={SettingsIcon} current={page === 'settings'} onClick={() => onPage('settings')} />
    </nav>
  );
}

function FootButton({ label, icon: Icon, current, onClick }: { label: string; icon: LucideIcon; current: boolean; onClick: () => void }) {
  return (
    <button className="icon-btn" type="button" title={label} aria-label={label} aria-haspopup="dialog" aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon />
    </button>
  );
}
