import { useState } from 'react';
import { Settings } from './Settings';

type View = 'session' | 'projects' | 'dashboard' | 'settings';

export function App() {
  const [view, setView] = useState<View>('session');
  const [diffOpen, setDiffOpen] = useState(false);

  return (
    <div className="app">
      <aside className="side" aria-label="Inbox">
        <div className="side-top">
          <div className="brand">Loom</div>
          <button className="compose primary" type="button" disabled>
            New Session
          </button>
          <div className="search muted">
            Search <kbd>Ctrl K</kbd>
          </div>
        </div>
        <div className="side-list">
          <p className="empty muted">Nothing needs you right now.</p>
        </div>
        <nav className="side-foot">
          <button type="button" aria-current={view === 'projects'} onClick={() => setView('projects')}>
            Projects
          </button>
          <button type="button" aria-current={view === 'dashboard'} onClick={() => setView('dashboard')}>
            Dashboard
          </button>
          <button type="button" aria-current={view === 'settings'} onClick={() => setView('settings')}>
            Settings
          </button>
        </nav>
      </aside>
      <main className="main" aria-label="Session">
        {view === 'settings' ? <Settings /> : <div className="empty muted">No Session selected.</div>}
      </main>
      <div className="diff-pane">
        <button className="diff-rail" type="button" aria-label="Diff" aria-expanded={diffOpen} aria-controls="diff-panel" onClick={() => setDiffOpen(!diffOpen)}>
          <span>Diff</span>
        </button>
        {diffOpen && (
          <section id="diff-panel" className="diff" aria-label="Diff panel">
            <div className="empty muted">No diff available.</div>
          </section>
        )}
      </div>
    </div>
  );
}
