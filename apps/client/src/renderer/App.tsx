// The window's three panes, following docs/prototypes/ui-layout.html: the
// Inbox sidebar, the main pane and the diff rail.
import { Archive, ChartColumn, ChevronDown, ChevronRight, FileDiff, FolderGit2, FolderOpen, Inbox, LoaderCircle, MessageSquarePlus, PanelRightClose, Plus, Search, Settings as SettingsIcon, Waypoints, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Session } from '../shared/api';
import { useTopic } from './api';
import { Projects, useExistingCloneLinker } from './Projects';
import { NewSession, SessionView, StatusIcon } from './Sessions';
import { Settings } from './Settings';

type View = 'session' | 'new-session' | 'projects' | 'dashboard' | 'settings';

export function App() {
  const [view, setView] = useState<View>('session');
  const [diffOpen, setDiffOpen] = useState(false);
  const linker = useExistingCloneLinker();
  const sessions = useTopic('sessions') ?? [];
  const [selectedId, setSelectedId] = useState<number>();
  const selected = sessions.find((s) => s.id === selectedId);
  const select = (session: Session) => {
    setSelectedId(session.id);
    setView('session');
  };
  const waiting = sessions.filter((s) => s.status === 'waiting');

  return (
    <div className="app">
      <aside className="side" aria-label="Inbox">
        <div className="side-top">
          <div className="brand">
            <Waypoints /> Loom<span className="grow" />
            <NewMenu
              onNewSession={() => setView('new-session')}
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
          <div className="section-head" style={{ borderTop: 0, cursor: 'default' }}>
            <Inbox className="sm" /> Inbox<span className="grow" />
            {waiting.length}
          </div>
          {waiting.length === 0 ? <div className="empty">Nothing needs you right now.</div> : <SessionRows sessions={waiting} selectedId={view === 'session' ? selectedId : undefined} onSelect={select} />}
          <Section label="Working" icon={LoaderCircle} sessions={sessions.filter((s) => s.status === 'working')} selectedId={view === 'session' ? selectedId : undefined} onSelect={select} />
          <Section label="Archived" icon={Archive} sessions={sessions.filter((s) => s.status === 'archived')} selectedId={view === 'session' ? selectedId : undefined} onSelect={select} />
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
        <NewSession onStarted={select} />
      ) : selected ? (
        <SessionView key={selected.id} session={selected} />
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

/** The + button's menu of things to start: a Session or a Project. */
function NewMenu({ onNewSession, onAddExistingClone }: { onNewSession: () => void; onAddExistingClone: () => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    firstItem.current?.focus();
    const closeOutside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);
  return (
    <div className="menu-anchor" ref={container}>
      <button className="icon-btn" type="button" title="New" aria-label="New" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Plus />
      </button>
      {open && (
        <div className="menu" role="menu" onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
          <button
            ref={firstItem}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNewSession();
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
        </div>
      )}
    </div>
  );
}

interface SessionListProps {
  sessions: Session[];
  selectedId: number | undefined;
  onSelect: (session: Session) => void;
}

/** A collapsible sidebar section (Working, Archived) below the Inbox. */
function Section({ label, icon: Icon, ...list }: { label: string; icon: LucideIcon } & SessionListProps) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <button className="section-head" type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron className="sm" />
        <Icon className="sm" />
        {label}
        <span className="grow" />
        {list.sessions.length}
      </button>
      {open && <SessionRows {...list} />}
    </>
  );
}

/** Sessions as one-line rows: status and title. */
function SessionRows({ sessions, selectedId, onSelect }: SessionListProps) {
  return sessions.map((session) => (
    <button key={session.id} type="button" className={`mini${session.id === selectedId ? ' sel' : ''}`} aria-label={session.title} aria-current={session.id === selectedId ? 'true' : undefined} onClick={() => onSelect(session)}>
      <StatusIcon session={session} />
      <span className="grow ellipsis">{session.title}</span>
    </button>
  ));
}

function FootButton({ label, icon: Icon, current, onClick }: { label: string; icon: LucideIcon; current: boolean; onClick: () => void }) {
  return (
    <button className="icon-btn" type="button" title={label} aria-label={label} aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon />
    </button>
  );
}
