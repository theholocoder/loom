// The window's three panes, following docs/prototypes/ui-layout.html: the
// Inbox sidebar, the main pane and the diff rail.
import { ChartColumn, FileDiff, FolderGit2, FolderOpen, MessageSquarePlus, PanelRightClose, Plus, Search, Settings as SettingsIcon, Waypoints, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Project, Session } from '../shared/api';
import { useApi, useTopic } from './api';
import { useAppearance } from './appearance';
import { DatabaseProblem } from './DatabaseProblem';
import { Popover } from './Popover';
import { ProjectPicker } from './ProjectPicker';
import { Projects, useExistingCloneLinker } from './Projects';
import { InboxList } from './Inbox';
import { NewSession, SessionView } from './Sessions';
import { Settings } from './Settings';

type View = 'session' | 'new-session' | 'projects' | 'dashboard' | 'settings';

export function App() {
  const database = useTopic('database');
  // Nothing else can be served until main knows its database is usable.
  if (!database) return null;
  if (database.state === 'damaged') return <DatabaseProblem status={database} />;
  return <Workspace />;
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
  const linker = useExistingCloneLinker();
  const sessions = useTopic('sessions') ?? [];
  const projects = useTopic('projects') ?? [];
  const [selectedId, setSelectedId] = useState<number>();
  /** Bumped to focus the open Session's composer. */
  const [replyRequest, setReplyRequest] = useState(0);
  /** The Project picked for the New Session view; each pick starts it afresh. */
  const [newSession, setNewSession] = useState<{ projectId?: number; key: number }>({ key: 0 });
  const selected = sessions.find((s) => s.id === selectedId);
  const select = (session: Session) => {
    setSelectedId(session.id);
    setView('session');
  };
  const reply = (session: Session) => {
    select(session);
    setReplyRequest((n) => n + 1);
  };

  return (
    <div className="app">
      <aside className="side" aria-label="Inbox">
        <div className="side-top">
          <div className="brand">
            <Waypoints /> Loom<span className="grow" />
            <NewMenu
              projects={projects}
              onNewSession={(project) => {
                setNewSession((n) => ({ projectId: project?.id, key: n.key + 1 }));
                setView('new-session');
              }}
              onAddExistingClone={() => {
                setView('projects');
                void linker.link();
              }}
            />
          </div>
          <button className="search" type="button" aria-label="Search Sessions and actions">
            <Search />
            <span>Search Sessions and actions</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>
        <div className="side-list">
          <InboxList sessions={sessions} projects={projects} selectedId={view === 'session' ? selectedId : undefined} onSelect={select} onReply={reply} />
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
        <NewSession key={newSession.key} initialProjectId={newSession.projectId} onStarted={select} />
      ) : selected ? (
        <SessionView key={selected.id} session={selected} replyRequest={replyRequest} />
      ) : (
        <main className="main" aria-label="Session">
          <div className="empty">No Session selected.</div>
        </main>
      )}
      {diffOpen ? (
        <section className="diff" id="diff-panel" aria-label="Changes">
          <header>
            <FileDiff />
            <b>Changes</b>
            <span className="grow" />
            <button className="icon-btn sm" type="button" title="Close" aria-label="Hide changes" aria-controls="diff-panel" aria-expanded onClick={() => setDiffOpen(false)}>
              <PanelRightClose />
            </button>
          </header>
          <div className="scroll">
            <div className="empty">No Session selected.</div>
          </div>
        </section>
      ) : (
        <button className="diff-rail" type="button" title="Show changes" aria-label="Show changes" aria-expanded={false} onClick={() => setDiffOpen(true)}>
          <FileDiff />
          <span>CHANGES</span>
        </button>
      )}
    </div>
  );
}

/**
 * The + button's menu of things to start: a Session (in the Project picked
 * from the Project picker) or a Project. With no Project to pick, New Session
 * goes straight to its view, which asks for one.
 */
function NewMenu({ projects, onNewSession, onAddExistingClone }: { projects: Project[]; onNewSession: (project?: Project) => void; onAddExistingClone: () => void }) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closePicker = () => {
    setPicking(false);
    trigger.current?.focus();
  };
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
              if (projects.length) setPicking(true);
              else onNewSession();
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
      {picking && (
        <ProjectPicker
          projects={projects}
          onClose={closePicker}
          onPick={(project) => {
            setPicking(false);
            onNewSession(project);
          }}
        />
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
