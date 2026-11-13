// The main pane on first run, with no Project yet: what Loom is, one way
// forward, and whether each Environment and its agent are ready.
import { FolderOpen } from 'lucide-react';
import { OPENCODE_NAME } from '../shared/api';
import { Logo } from './Logo';
import { EnvironmentCheck, useAgentCheck } from './Settings';
import { SHORTCUTS } from './shortcuts';

export function Welcome({ onAddProject }: { onAddProject: () => void }) {
  useAgentCheck();
  return (
    // Still the main pane's Session landmark, as it is with a Project; the welcome is a region in it.
    <main className="main" aria-label="Session">
      <section className="welcome" aria-label="Welcome">
        <h1>
          <Logo /> Welcome to Loom
        </h1>
        <p className="muted">Loom runs coding agents on your own machine, one Session per piece of work, each in its own worktree of a Project: a git checkout you add from this machine.</p>
        <button className="primary" type="button" onClick={onAddProject}>
          <FolderOpen className="sm" />
          {SHORTCUTS.addProject.label}
        </button>
        <h2>Ready to run {OPENCODE_NAME}?</h2>
        <EnvironmentCheck />
        <p className="muted">Settings has the full check, and Reload for tools installed since Loom started.</p>
      </section>
    </main>
  );
}
