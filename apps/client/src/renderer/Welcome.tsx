// The main pane on first run, with no Project yet: what Loom is, one way
// forward, and whether each Environment and its agent are ready.
import { FolderOpen, Waypoints } from 'lucide-react';
import { OPENCODE_NAME } from '../shared/api';
import { EnvironmentCheck, useAgentCheck } from './Settings';
import { SHORTCUTS } from './shortcuts';

export function Welcome({ onAddProject }: { onAddProject: () => void }) {
  useAgentCheck();
  return (
    <main className="main" aria-label="Welcome">
      <div className="welcome">
        <h1>
          <Waypoints /> Welcome to Loom
        </h1>
        <p className="muted">Loom runs coding agents on your own machine, one Session per piece of work, each in its own worktree of a Project: a git checkout you add from this machine.</p>
        <button className="primary" type="button" onClick={onAddProject}>
          <FolderOpen className="sm" />
          {SHORTCUTS.addProject.label}
        </button>
        <h2>Ready to run {OPENCODE_NAME}?</h2>
        <EnvironmentCheck />
        <p className="muted">Settings has the full check, and Reload for tools installed since Loom started.</p>
      </div>
    </main>
  );
}
