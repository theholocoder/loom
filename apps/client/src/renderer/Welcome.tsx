// The main pane on first run, with no Project yet: what Loom is, one way
// forward, and whether each Environment and its agent are ready.
import { FolderOpen, Waypoints } from 'lucide-react';
import { useEffect } from 'react';
import { OPENCODE_NAME } from '../shared/api';
import { useApi } from './api';
import { EnvironmentCheck } from './Settings';
import { SHORTCUTS } from './shortcuts';

export function Welcome({ adding, onAddProject }: { adding: boolean; onAddProject: () => void }) {
  const api = useApi();
  // Checks the agents again, as Settings does, so the check is current.
  useEffect(() => {
    api.invoke('environments.detect').catch((error: unknown) => console.error('agent detection failed:', error));
  }, [api]);
  return (
    <main className="main" aria-label="Welcome">
      <div className="welcome">
        <h1>
          <Waypoints /> Welcome to Loom
        </h1>
        <p className="muted">Loom runs coding agents on your own machine, one Session per piece of work, each in its own worktree of a Project: a git checkout you add from this machine.</p>
        <button className="primary" type="button" disabled={adding} onClick={onAddProject}>
          <FolderOpen className="sm" />
          {SHORTCUTS.addProject.label}
        </button>
        <h2>Ready to run {OPENCODE_NAME}?</h2>
        <EnvironmentCheck />
      </div>
    </main>
  );
}
