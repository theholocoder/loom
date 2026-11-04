// The window's three panes, following docs/prototypes/ui-layout.html: the
// Inbox sidebar, the main pane and the Session header's changes control. Also
// the Ctrl+K palette and the keyboard shortcuts, which run the same actions.
import {
  Archive,
  ArrowRightToLine,
  ChartColumn,
  CircleDot,
  ExternalLink,
  FileDiff,
  FolderGit2,
  FolderOpen,
  GitPullRequestCreate,
  MessageSquarePlus,
  Palette,
  Plus,
  Search,
  Settings as SettingsIcon,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { mergeRequestRef, type Project, type Session } from '../shared/api';
import { THEMES, type Theme } from '../shared/appearance';
import { useApi, useTopic } from './api';
import { useAppearance } from './appearance';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { DatabaseProblem } from './DatabaseProblem';
import { DiffPanel } from './DiffPanel';
import { inboxOrder, InboxList } from './Inbox';
import { Popover } from './Popover';
import { ProjectPicker } from './ProjectPicker';
import { Projects, useExistingCloneLinker } from './Projects';
import { NewSession, SessionView, type SessionCommand } from './Sessions';
import { Settings } from './Settings';

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
  const [diffOpen, setDiffOpen] = useState(false);
  const toggleDiff = () => setDiffOpen((open) => !open);
  const linker = useExistingCloneLinker();
  const sessions = useTopic('sessions') ?? [];
  const projects = useTopic('projects') ?? [];
  const [selectedId, setSelectedId] = useState<number>();
  /** Bumped to focus the open Session's composer. */
  const [replyRequest, setReplyRequest] = useState(0);
  /** What the open Session is asked to do next, until it has. */
  const [command, setCommand] = useState<SessionCommand>();
  /** The Project picked for the New Session view; each pick starts it afresh. */
  const [newSession, setNewSession] = useState<{ projectId?: number; fromIssue?: boolean; generation: number }>({ generation: 0 });
  const [picking, setPicking] = useState<Picking>();
  /** The palette, while open, and where focus was before it. */
  const [palette, setPalette] = useState<{ returnFocus: HTMLElement | null }>();
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

  const actions = paletteActions({
    projects,
    forgeProjects,
    session: shown,
    nextWaiting: nextWaitingSession(inboxOrder(sessions, projects), shown),
    newSession: (returnFocus) => pickProject(returnFocus),
    newSessionFromIssue: (returnFocus) => pickProject(returnFocus, true),
    addExistingClone,
    select,
    command: setCommand,
    toggleDiff,
    setTheme: (theme) => {
      api.invoke('settings.setAppearance', { theme }).catch((error: unknown) => console.error('theme change failed:', error));
    },
    setView,
  });

  const openPalette = () => setPalette({ returnFocus: focusedElement() });
  const closePalette = () => {
    palette?.returnFocus?.focus();
    setPalette(undefined);
  };
  const latest = useRef({ palette, openPalette, closePalette, actions });
  latest.current = { palette, openPalette, closePalette, actions };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { palette, openPalette, closePalette, actions } = latest.current;
      // Not over a dialog, nor a menu or picker, which have keys of their own.
      const covered = () => !!document.querySelector('[aria-modal="true"], .popover');
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (palette) closePalette();
        else if (!covered()) openPalette();
        return;
      }
      const ctrl = event.ctrlKey || event.metaKey;
      if (event.altKey || event.defaultPrevented || (!ctrl && isTyping(event.target)) || covered()) return;
      const action = actions.find((a) => a.shortcut && a.shortcut.key === event.key && !!a.shortcut.ctrl === ctrl);
      if (!action) return;
      event.preventDefault();
      action.run(focusedElement());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app">
      <aside className="side" aria-label="Inbox">
        <div className="side-top">
          <div className="brand">
            <Waypoints /> Loom<span className="grow" />
            <NewMenu onNewSession={(trigger) => pickProject(trigger)} onAddExistingClone={addExistingClone} />
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
        <nav className="side-foot">
          <FootButton label="Projects" icon={FolderGit2} current={view === 'projects'} onClick={() => setView('projects')} />
          <FootButton label="Dashboard" icon={ChartColumn} current={view === 'dashboard'} onClick={() => setView('dashboard')} />
          <span className="grow" />
          <FootButton label="Settings" icon={SettingsIcon} current={view === 'settings'} onClick={() => setView('settings')} />
        </nav>
      </aside>
      {view === 'settings' ? (
        <Settings />
      ) : view === 'projects' ? (
        <Projects linker={linker} />
      ) : view === 'new-session' ? (
        <NewSession key={newSession.generation} initialProjectId={newSession.projectId} pickIssue={newSession.fromIssue} onStarted={select} />
      ) : selected ? (
        <SessionView
          key={selected.id}
          session={selected}
          replyRequest={replyRequest}
          command={command}
          onCommandDone={() => setCommand(undefined)}
          diffOpen={diffOpen}
          onToggleDiff={toggleDiff}
        />
      ) : (
        <main className="main" aria-label="Session">
          <div className="empty">No Session selected.</div>
        </main>
      )}
      <DiffPanel session={selected} open={diffOpen} onToggle={toggleDiff} />
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
  );
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Whether a key goes to a text field, where it types rather than runs a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'));
}

/** The Waiting Session after the one shown, in Inbox order, wrapping round; the first when none is shown. */
function nextWaitingSession(waiting: Session[], shown: Session | undefined): Session | undefined {
  const at = shown ? waiting.findIndex((s) => s.id === shown.id) : -1;
  const next = waiting[(at + 1) % waiting.length];
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
  newSession: (returnFocus: HTMLElement | null) => void;
  newSessionFromIssue: (returnFocus: HTMLElement | null) => void;
  addExistingClone: () => void;
  select: (session: Session) => void;
  command: (command: SessionCommand) => void;
  toggleDiff: () => void;
  setTheme: (theme: Theme) => void;
  setView: (view: View) => void;
}): PaletteAction[] {
  const { session, nextWaiting } = app;
  const project = session && app.projects.find((p) => p.id === session.projectId);
  // A Session whose worktree is missing can only be archived.
  const active = session && session.status !== 'archived' && !session.worktreeMissing ? session : undefined;
  const mergeRequest = active?.mergeRequest;
  const canCreateMergeRequest = active && !mergeRequest && project?.forge.state === 'available';
  const actions: Array<PaletteAction | false | undefined> = [
    { label: 'New Session', icon: MessageSquarePlus, shortcut: { key: 'n', ctrl: true }, run: app.newSession },
    app.forgeProjects.length > 0 && { label: 'New Session from an issue…', icon: CircleDot, run: app.newSessionFromIssue },
    { label: 'Add Project from existing clone…', icon: FolderOpen, shortcut: { key: 'o', ctrl: true }, run: app.addExistingClone },
    nextWaiting && { label: 'Go to next Waiting Session', icon: ArrowRightToLine, shortcut: { key: 'j' }, run: () => app.select(nextWaiting) },
    mergeRequest && {
      label: `Open Merge request ${mergeRequestRef(project?.forge.kind, mergeRequest.number)} for this Session`,
      icon: ExternalLink,
      run: () => app.command('openMergeRequest'),
    },
    canCreateMergeRequest && { label: 'Create Merge request for this Session', icon: GitPullRequestCreate, run: () => app.command('createMergeRequest') },
    { label: 'Toggle changes panel', icon: FileDiff, shortcut: { key: 'd' }, run: app.toggleDiff },
    session && session.status !== 'archived' && { label: 'Archive this Session', icon: Archive, shortcut: { key: 'e' }, run: () => app.command('archive') },
    ...(Object.keys(THEMES) as Theme[]).map((theme) => ({ label: `Theme: ${THEMES[theme].label}`, icon: Palette, run: () => app.setTheme(theme) })),
    { label: 'Open Projects', icon: FolderGit2, run: () => app.setView('projects') },
    { label: 'Open Settings', icon: SettingsIcon, shortcut: { key: ',', ctrl: true }, run: () => app.setView('settings') },
  ];
  return actions.filter((action): action is PaletteAction => !!action);
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

function FootButton({ label, icon: Icon, current, onClick }: { label: string; icon: LucideIcon; current: boolean; onClick: () => void }) {
  return (
    <button className="icon-btn" type="button" title={label} aria-label={label} aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon />
    </button>
  );
}
