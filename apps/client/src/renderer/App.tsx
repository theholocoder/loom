// The window's three panes, following docs/prototypes/ui-layout.html: the
// Inbox sidebar, the main pane and the diff rail.
import { Archive, ChartColumn, ChevronDown, ChevronRight, FileDiff, FolderGit2, Inbox, LoaderCircle, PanelRightClose, Plus, Search, Settings as SettingsIcon, Waypoints, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTopic } from './api';
import { FORGE_NAME, Projects } from './Projects';
import { Settings } from './Settings';

type View = 'session' | 'projects' | 'dashboard' | 'settings';

export function App() {
  const [view, setView] = useState<View>('session');
  const [diffOpen, setDiffOpen] = useState(false);
  const projects = useTopic('projects') ?? [];

  return (
    <div className="app">
      <aside className="side" aria-label="Inbox">
        <div className="side-top">
          <div className="brand">
            <Waypoints /> Loom<span className="grow" />
            <button className="icon-btn" type="button" title="New Session (N)" aria-label="New Session">
              <Plus />
            </button>
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
          {projects.map((project, index) => (
            <div key={project.id} className="B-group-head" role="group" aria-label={project.name}>
              <span className="proj-avatar" style={{ width: 26, height: 26, background: `var(--p${(index % 3) + 1})`, fontSize: 26 * 0.38 }}>
                {project.name.slice(0, 2).toUpperCase()}
              </span>
              <b className="ellipsis">{project.name}</b>
              {project.forge.kind && <span className="muted">{FORGE_NAME[project.forge.kind]}</span>}
              <span className="grow" />
              <span className="chip">0</span>
            </div>
          ))}
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
        <Projects />
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
