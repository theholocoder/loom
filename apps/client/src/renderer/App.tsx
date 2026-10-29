// The window's three panes, following docs/prototypes/ui-layout.html: the
// Inbox sidebar, the main pane and the diff rail.
import { Archive, ChartColumn, ChevronDown, ChevronRight, FileDiff, FolderGit2, FolderOpen, Inbox, LoaderCircle, PanelRightClose, Plus, Search, Settings as SettingsIcon, Waypoints, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Projects, useExistingCloneLinker } from './Projects';
import { Settings } from './Settings';

type View = 'session' | 'projects' | 'dashboard' | 'settings';

export function App() {
  const [view, setView] = useState<View>('session');
  const [diffOpen, setDiffOpen] = useState(false);
  const linker = useExistingCloneLinker();

  return (
    <div className="app">
      <aside className="side" aria-label="Inbox">
        <div className="side-top">
          <div className="brand">
            <Waypoints /> Loom<span className="grow" />
            <NewMenu
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
            <Inbox className="sm" /> Inbox<span className="grow" />0
          </div>
          <div className="empty">Nothing needs you right now.</div>
          <Section label="Working" icon={LoaderCircle} />
          <Section label="Archived" icon={Archive} />
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

/** The + button's menu of things to start: Projects now, Sessions later. */
function NewMenu({ onAddExistingClone }: { onAddExistingClone: () => void }) {
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

/** A collapsible sidebar section (Working, Archived) below the Inbox. */
function Section({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button className="section-head" type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
      <Chevron className="sm" />
      <Icon className="sm" />
      {label}
      <span className="grow" />0
    </button>
  );
}

function FootButton({ label, icon: Icon, current, onClick }: { label: string; icon: LucideIcon; current: boolean; onClick: () => void }) {
  return (
    <button className="icon-btn" type="button" title={label} aria-label={label} aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon />
    </button>
  );
}
