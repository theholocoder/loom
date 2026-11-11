// The window's panes, following docs/prototypes/ui-layout.html: the Inbox
// sidebar, the main pane and the open Session's Side area. Also the
// Ctrl+K palette and the keyboard shortcuts, which run the same actions.
import {
  Archive,
  ArrowLeftToLine,
  ArrowRightToLine,
  ChartColumn,
  CircleDot,
  CodeXml,
  ExternalLink,
  FileDiff,
  FolderGit2,
  FolderOpen,
  GitPullRequestArrow,
  GitPullRequestCreate,
  Info,
  Keyboard,
  Link,
  Mail,
  MessageSquarePlus,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  Reply,
  RotateCw,
  Search,
  Settings as SettingsIcon,
  SquareTerminal,
  Trash2,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { mergeRequestRef, type Project, type Session } from '../shared/api';
import { THEMES, type Theme } from '../shared/appearance';
import { useApi, useTopic } from './api';
import { useAppearance } from './appearance';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { DatabaseProblem } from './DatabaseProblem';
import { inboxOrder, InboxList } from './Inbox';
import { Popover } from './Popover';
import { ProjectPicker } from './ProjectPicker';
import { Dashboard } from './Dashboard';
import { Projects, useExistingCloneLinker } from './Projects';
import { NewSession, SessionView, type NewSessionWorkingCopy, type SessionCommand } from './Sessions';
import { NewSessionContext } from './SessionMenu';
import { ContextMenuHost } from './ContextMenu';
import { Settings } from './Settings';
import { ShortcutHelp } from './ShortcutHelp';
import { matchesShortcut, SHORTCUTS, type ShortcutName } from './shortcuts';
import { ResizeEdge } from './ResizeEdge';
import { useInbox, useWindowSize, WindowLayoutProvider } from './WindowLayout';
import { INBOX_WIDTH, windowLayout } from '../shared/window';

type View = 'session' | 'new-session' | 'projects' | 'dashboard' | 'settings';

export function App() {
  const database = useTopic('database');
  // Nothing else can be served until main knows its database is usable.
  if (!database) return null;
  if (database.state === 'damaged') return <DatabaseProblem status={database} />;
  return <Workspace />;
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
  // A worktree may be deleted while Loom is in the background: look again on focus.
  useEffect(() => {
    const check = () => {
      api.invoke('sessions.check').catch((error: unknown) => console.error('session check failed:', error));
    };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [api]);
  const linker = useExistingCloneLinker();
  const sessions = useTopic('sessions') ?? [];
  const projects = useTopic('projects') ?? [];
  const [selectedId, setSelectedId] = useState<number>();
  /** Bumped to focus the open Session's composer. */
  const [replyRequest, setReplyRequest] = useState(0);
  /** What the open Session is asked to do next, until it has. */
  const [command, setCommand] = useState<SessionCommand>();
  /** Whether the open Session's last prompt failed, so it can be sent again. */
  const [retryable, setRetryable] = useState(false);
  /** The Project picked for the New Session view; each pick starts it afresh. */
  const [newSession, setNewSession] = useState<{ projectId?: number; fromIssue?: boolean; workingCopy?: NewSessionWorkingCopy; generation: number }>({ generation: 0 });
  const [picking, setPicking] = useState<Picking>();
  /** The palette, while open, and where focus was before it. */
  const [palette, setPalette] = useState<{ returnFocus: HTMLElement | null }>();
  /** The shortcuts list, while open, and where focus was before it. */
  const [help, setHelp] = useState<{ returnFocus: HTMLElement | null }>();
  const selected = sessions.find((s) => s.id === selectedId);
  const shown = view === 'session' ? selected : undefined;
  const select = (session: Session) => {
    setSelectedId(session.id);
    setCommand(undefined);
    setView('session');
  };
  const reply = (session: Session) => {
    select(session);
    setReplyRequest((n) => n + 1);
  };
  const startNewSession = (project: Project | undefined, fromIssue = false) => {
    setNewSession((n) => ({ projectId: project?.id, fromIssue, generation: n.generation + 1 }));
    setView('new-session');
  };
  /** New Session on a Project's working copy, from another Session's menu. */
  const startNewSessionOn = (projectId: number, workingCopy: NewSessionWorkingCopy) => {
    setNewSession((n) => ({ projectId, workingCopy, generation: n.generation + 1 }));
    setView('new-session');
  };
  /** New Session asks for the Project first, when there is one to pick. */
  const pickProject = (returnFocus: HTMLElement | null, fromIssue = false) => {
    if (fromIssue || projects.length) setPicking({ fromIssue, returnFocus });
    else startNewSession(undefined);
  };
  const addExistingClone = () => {
    setView('projects');
    void linker.link();
  };
  const forgeProjects = projects.filter((p) => p.forge.state === 'available');
  const inbox = useInbox();
  const windowSize = useWindowSize();
  const layout = { ...windowLayout(windowSize.width, inbox.value), height: windowSize.height };

  const waiting = inboxOrder(sessions, projects);
  const actions = paletteActions({
    projects,
    forgeProjects,
    session: shown,
    nextWaiting: stepWaiting(waiting, shown, 1),
    previousWaiting: stepWaiting(waiting, shown, -1),
    retryable,
    reply,
    newSession: (returnFocus) => pickProject(returnFocus),
    newSessionFromIssue: (returnFocus) => pickProject(returnFocus, true),
    addExistingClone,
    select,
    command: setCommand,
    setTheme: (theme) => {
      api.invoke('settings.setAppearance', { theme }).catch((error: unknown) => console.error('theme change failed:', error));
    },
    setView,
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
  const latest = useRef({ palette, openPalette, closePalette, help, closeHelp, actions, waiting, select });
  latest.current = { palette, openPalette, closePalette, help, closeHelp, actions, waiting, select };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { palette, openPalette, closePalette, help, closeHelp, actions, waiting, select } = latest.current;
      // A terminal takes every key but Ctrl+`, which xterm lets through to here.
      if (event.target instanceof Element && event.target.closest('.terminal-screen')) {
        if (!matchesShortcut(SHORTCUTS.toggleTerminal.shortcut, event)) return;
        event.preventDefault();
        actions.find((a) => a.shortcut === SHORTCUTS.toggleTerminal.shortcut)?.run(focusedElement());
        return;
      }
      // Not over a dialog, nor a menu or picker, which have keys of their own.
      const covered = () => !!document.querySelector('[aria-modal="true"], .popover');
      // The palette and the shortcuts list close on their own key too.
      if (matchesShortcut(SHORTCUTS.palette.shortcut, event)) {
        event.preventDefault();
        if (palette) closePalette();
        else if (!covered()) openPalette();
        return;
      }
      if (help && matchesShortcut(SHORTCUTS.help.shortcut, event)) {
        event.preventDefault();
        closeHelp();
        return;
      }
      const ctrl = event.ctrlKey || event.metaKey;
      if (event.altKey || event.defaultPrevented || (!ctrl && isTyping(event.target)) || covered()) return;
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
    return () => window.removeEventListener('keydown', onKeyDown);
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
                <Waypoints /> Loom<span className="grow" />
                <NewMenu onNewSession={(trigger) => pickProject(trigger)} onAddExistingClone={addExistingClone} />
                <button className="icon-btn" type="button" title="Collapse the Inbox" aria-label="Collapse the Inbox" aria-expanded="true" aria-controls="inbox" onClick={inbox.toggle}>
                  <PanelLeftClose />
                </button>
              </div>
              <button className="search" type="button" aria-label="Search Sessions and actions" aria-haspopup="dialog" onClick={openPalette}>
                <Search />
                <span>Search Sessions and actions</span>
                <kbd>Ctrl K</kbd>
              </button>
            </div>
            <div className="side-list">
              <InboxList sessions={sessions} projects={projects} selectedId={shown?.id} onSelect={select} onReply={reply} />
            </div>
            <ViewNav className="side-foot" view={view} onView={setView} />
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
            <NewMenu onNewSession={(trigger) => pickProject(trigger)} onAddExistingClone={addExistingClone} />
            <button className="icon-btn" type="button" title="Search Sessions and actions" aria-label="Search Sessions and actions" aria-haspopup="dialog" onClick={openPalette}>
              <Search />
            </button>
            <span className="grow" />
            <ViewNav className="rail-foot" view={view} onView={setView} />
          </aside>
        )}
        {view === 'settings' ? (
          <Settings />
        ) : view === 'dashboard' ? (
          <Dashboard onOpenSession={select} />
        ) : view === 'projects' ? (
          <Projects linker={linker} />
        ) : view === 'new-session' ? (
          <NewSession key={newSession.generation} initialProjectId={newSession.projectId} pickIssue={newSession.fromIssue} initialWorkingCopy={newSession.workingCopy} onStarted={select} />
        ) : selected ? (
          <SessionView
            key={selected.id}
            session={selected}
            replyRequest={replyRequest}
            command={command}
            onCommandDone={() => setCommand(undefined)}
            onRetryableChange={setRetryable}
          />
        ) : (
          <main className="main" aria-label="Session">
            <div className="empty">No Session selected.</div>
          </main>
        )}
        {picking && (
          <ProjectPicker
            projects={picking.fromIssue ? forgeProjects : projects}
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
  addExistingClone: () => void;
  select: (session: Session) => void;
  command: (command: SessionCommand) => void;
  setTheme: (theme: Theme) => void;
  setView: (view: View) => void;
  showHelp: (returnFocus: HTMLElement | null) => void;
  toggleInbox: () => void;
}): PaletteAction[] {
  const { session, nextWaiting, previousWaiting } = app;
  const project = session && app.projects.find((p) => p.id === session.projectId);
  // A Session whose worktree is missing can only be archived.
  const active = session && session.status !== 'archived' && !session.worktreeMissing ? session : undefined;
  const mergeRequest = active?.mergeRequest;
  const canCreateMergeRequest = active && !mergeRequest && project?.forge.state === 'available';
  const open = session && session.status !== 'archived' ? session : undefined;
  const actions: Array<PaletteAction | false | undefined> = [
    shortcutAction('newSession', MessageSquarePlus, app.newSession),
    app.forgeProjects.length > 0 && shortcutAction('newSessionFromIssue', CircleDot, app.newSessionFromIssue),
    shortcutAction('addExistingClone', FolderOpen, app.addExistingClone),
    nextWaiting && shortcutAction('nextWaiting', ArrowRightToLine, () => app.select(nextWaiting)),
    previousWaiting && shortcutAction('previousWaiting', ArrowLeftToLine, () => app.select(previousWaiting)),
    active?.status === 'waiting' && shortcutAction('reply', Reply, () => app.reply(active)),
    app.retryable && shortcutAction('retry', RotateCw, () => app.command('retry')),
    mergeRequest && {
      ...shortcutAction('mergeRequest', ExternalLink, () => app.command('openMergeRequest')),
      label: `Open Merge request ${mergeRequestRef(project?.forge.kind, mergeRequest.number)} for this Session`,
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
    session && shortcutAction('toggleInfo', Info, () => app.command('toggleInfo')),
    active && !active.unread && shortcutAction('markUnread', Mail, () => app.command('markUnread')),
    open && shortcutAction('archive', Archive, () => app.command('archive')),
    session && { label: 'Delete this Session…', icon: Trash2, run: () => app.command('delete') },
    ...(Object.keys(THEMES) as Theme[]).map((theme) => ({ label: `Theme: ${THEMES[theme].label}`, icon: Palette, run: () => app.setTheme(theme) })),
    { label: 'Open Projects', icon: FolderGit2, run: () => app.setView('projects') },
    { label: 'Open Dashboard', icon: ChartColumn, run: () => app.setView('dashboard') },
    shortcutAction('settings', SettingsIcon, () => app.setView('settings')),
    shortcutAction('help', Keyboard, app.showHelp),
  ];
  return actions.filter((action): action is PaletteAction => !!action);
}

/** An action named and keyed as the shortcuts catalog has it. */
function shortcutAction(name: ShortcutName, icon: LucideIcon, run: PaletteAction['run']): PaletteAction {
  const { label, shortcut } = SHORTCUTS[name];
  return { label, icon, shortcut, run };
}

/** The + button's menu of things to start: a Session or a Project. */
function NewMenu({ onNewSession, onAddExistingClone }: { onNewSession: (trigger: HTMLElement | null) => void; onAddExistingClone: () => void }) {
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
              onAddExistingClone();
            }}
          >
            <FolderOpen className="sm" />
            Add Project from existing clone…
          </button>
        </Popover>
      )}
    </>
  );
}

/** The Inbox's foot: Projects, Dashboard and Settings, Settings at the end. */
function ViewNav({ className, view, onView }: { className: string; view: View; onView: (view: View) => void }) {
  return (
    <nav className={className}>
      <FootButton label="Projects" icon={FolderGit2} current={view === 'projects'} onClick={() => onView('projects')} />
      <FootButton label="Dashboard" icon={ChartColumn} current={view === 'dashboard'} onClick={() => onView('dashboard')} />
      <span className="grow" />
      <FootButton label="Settings" icon={SettingsIcon} current={view === 'settings'} onClick={() => onView('settings')} />
    </nav>
  );
}

function FootButton({ label, icon: Icon, current, onClick }: { label: string; icon: LucideIcon; current: boolean; onClick: () => void }) {
  return (
    <button className="icon-btn" type="button" title={label} aria-label={label} aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon />
    </button>
  );
}
