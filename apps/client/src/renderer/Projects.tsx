import { ArchiveRestore, CircleCheckBig, CircleX, FolderGit2, FolderMinus, FolderOpen, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { FORGE_CLI, type ForgeKind, type ForgeStatus, type Project, type RestorableProject, type UnsavedSession } from '../shared/api';
import { useApi, useTopic } from './api';
import { unsavedWorkSummary } from './Archive';

const FORGE_NAME: Record<ForgeKind, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** Adding a Project from a folder the user chooses, and how the last attempt went. */
export interface ExistingCloneLinker {
  linking: boolean;
  /** Why the last attempt failed. */
  error?: string;
  /**
   * Asks for a folder and links its checkout; does nothing if the user
   * cancels. A checkout of a removed Project first asks whether to restore it.
   */
  link(): Promise<void>;
  /** The offer to restore a removed Project, while one is open; render it anywhere. */
  dialog: ReactNode;
}

export function useExistingCloneLinker(): ExistingCloneLinker {
  const api = useApi();
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string>();
  const [offer, setOffer] = useState<{ path: string; project: RestorableProject }>();
  const run = async (action: () => Promise<void>) => {
    setError(undefined);
    setLinking(true);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinking(false);
    }
  };
  const link = () =>
    run(async () => {
      const path = await api.invoke('dialogs.chooseFolder');
      if (!path) return;
      const project = await api.invoke('projects.restorable', { path });
      if (project) setOffer({ path, project });
      else await api.invoke('projects.link', { path });
    });
  const answer = (restore: boolean) => {
    if (!offer) return;
    setOffer(undefined);
    void run(async () => {
      await api.invoke('projects.link', restore ? { path: offer.path, restore: offer.project.id } : { path: offer.path });
    });
  };
  const dialog = offer && <RestoreOffer project={offer.project} onRestore={() => answer(true)} onNew={() => answer(false)} onCancel={() => setOffer(undefined)} />;
  return { linking, error, link, dialog };
}

function RestoreOffer({ project, onRestore, onNew, onCancel }: { project: RestorableProject; onRestore: () => void; onNew: () => void; onCancel: () => void }) {
  const restore = useRef<HTMLButtonElement>(null);
  useEffect(() => restore.current?.focus(), []);
  const sessions = project.sessions === 1 ? '1 archived Session' : `${project.sessions} archived Sessions`;
  return (
    <div className="scrim" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="card modal" role="alertdialog" aria-modal="true" aria-labelledby="restore-title" aria-describedby="restore-text">
        <div className="card-head">
          <ArchiveRestore className="sm" />
          <h3 id="restore-title">Restore {project.name}?</h3>
        </div>
        <p id="restore-text">
          This checkout is of a Project you removed. Restore {project.name} with its {sessions} and usage history, or start a new Project?
        </p>
        <div className="row modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onNew}>
            New Project
          </button>
          <button ref={restore} type="button" className="primary" onClick={onRestore}>
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}

// Laid out like Settings: a .dash page with a card holding a data table. The
// linker is shared with the sidebar's + menu, whose result shows here.
export function Projects({ linker }: { linker: ExistingCloneLinker }) {
  const api = useApi();
  const projects = useTopic('projects') ?? [];
  const environments = useTopic('environments') ?? [];
  // Opening Projects checks the Forges again, so what it shows is current.
  useEffect(() => {
    api.invoke('projects.check').catch((error: unknown) => console.error('Forge detection failed:', error));
  }, [api]);

  const environmentLabel = (id: string) => environments.find((e) => e.id === id)?.label ?? id;
  return (
    <main className="dash" aria-label="Projects">
      <div className="row">
        <h1>Projects</h1>
        <span className="grow" />
        <button className="primary" type="button" disabled={linker.linking} onClick={() => void linker.link()}>
          <FolderOpen className="sm" />
          Use existing clone…
        </button>
      </div>
      {linker.dialog}
      {linker.error && (
        <div className="err" role="alert" style={{ marginTop: 8 }}>
          {linker.error}
        </div>
      )}
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <FolderGit2 className="sm" />
          <h3>Projects</h3>
        </div>
        {projects.length === 0 ? (
          <div className="empty">No Projects yet. Add a git checkout with "Use existing clone…".</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th>Checkout</th>
                <th>Environment</th>
                <th>Forge</th>
                <th>Branch prefix</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <ProjectRow key={project.id} project={project} environmentLabel={environmentLabel(project.checkout.environmentId)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

function ProjectRow({ project, environmentLabel }: { project: Project; environmentLabel: string }) {
  const reason = forgeOffReason(project.forge, environmentLabel);
  return (
    <tr>
      <td>{project.name}</td>
      <td>
        <span className="tech">{project.checkout.path}</span>
      </td>
      <td>{environmentLabel}</td>
      <td>
        <ForgeCell forge={project.forge} />
        {reason && (
          <div className="warn" role="alert">
            {reason}
          </div>
        )}
      </td>
      <td>
        <BranchPrefix project={project} />
      </td>
      <td>
        <RemoveProject project={project} />
      </td>
    </tr>
  );
}

/** The row's Remove button, and the dialogs it opens: Remove? then, with unsaved work, Discard and remove? */
function RemoveProject({ project }: { project: Project }) {
  const api = useApi();
  const sessions = (useTopic('sessions') ?? []).filter((s) => s.projectId === project.id);
  const [step, setStep] = useState<{ unsaved?: UnsavedSession[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelButton.current?.focus(), [step]);
  const close = () => {
    setStep(undefined);
    setError(undefined);
  };
  const remove = (discard: boolean) => {
    setError(undefined);
    setBusy(true);
    api
      .invoke('projects.remove', discard ? { id: project.id, discard } : { id: project.id })
      .then((result) => (result.removed ? close() : setStep({ unsaved: result.unsaved })))
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const open = sessions.filter((s) => s.status !== 'archived').length;
  const count = sessions.length === 1 ? '1 Session' : `${sessions.length} Sessions`;
  const unsaved = step?.unsaved;
  return (
    <>
      <button className="icon-btn sm" type="button" title={`Remove ${project.name}`} aria-label={`Remove ${project.name}`} onClick={() => setStep({})}>
        <FolderMinus />
      </button>
      {step && (
        <div className="scrim" onKeyDown={(e) => e.key === 'Escape' && close()}>
          <div className="card modal" role="alertdialog" aria-modal="true" aria-labelledby={`remove-${project.id}-title`} aria-describedby={`remove-${project.id}-text`}>
            <div className="card-head">
              <TriangleAlert className="sm warn-icon" />
              <h3 id={`remove-${project.id}-title`}>{unsaved ? `Remove ${project.name} with unsaved work?` : `Remove ${project.name}?`}</h3>
            </div>
            {unsaved ? (
              <div id={`remove-${project.id}-text`}>
                <p>These Sessions' worktrees have unsaved work. Removing the Project removes the worktrees and discards their changes; commits stay on their local branches.</p>
                <ul>
                  {unsaved.map((u) => (
                    <li key={u.sessionId}>
                      <b>{u.title}</b>: {unsavedWorkSummary(u.unsavedWork)}
                      {u.unsavedWork.detached && u.unsavedWork.unpushedCommits > 0 && ', on no branch, so those commits will be lost'}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p id={`remove-${project.id}-text`}>
                Loom forgets this Project; the folder at <span className="tech">{project.checkout.path}</span> stays on disk.{' '}
                {sessions.length > 0 && (
                  <>
                    Its {count} {open > 0 && `(${open} still Working or Waiting, which are archived first) `}stay in the Archive, read-only.{' '}
                  </>
                )}
                Adding a checkout of it again offers to restore it.
              </p>
            )}
            {error && (
              <div className="err" role="alert">
                {error}
              </div>
            )}
            <div className="row modal-actions">
              <button ref={cancelButton} type="button" onClick={close}>
                Cancel
              </button>
              <button type="button" className="danger" disabled={busy} onClick={() => remove(!!unsaved)}>
                {unsaved ? 'Discard and remove' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ForgeCell({ forge }: { forge: ForgeStatus }) {
  const look = forge.checking ? 'checking' : forge.state === 'available' || forge.state === 'unknown' ? forge.state : 'off';
  return (
    <>
      {forge.kind && (
        <div>
          {FORGE_NAME[forge.kind]} {forge.repository && <span className="tech">{forge.repository}</span>}
        </div>
      )}
      <span className={`row fg-${look}`}>
        <ForgeIcon forge={forge} />
        <span>{look === 'unknown' ? 'not checked' : look}</span>
      </span>
    </>
  );
}

function ForgeIcon({ forge }: { forge: ForgeStatus }) {
  if (forge.checking) {
    return (
      <span className="spin">
        <LoaderCircle className="sm" />
      </span>
    );
  }
  switch (forge.state) {
    case 'available':
      return <CircleCheckBig className="sm" />;
    case 'unknown':
      return null;
    case 'no-remote':
    case 'unsupported':
    case 'cli-missing':
    case 'signed-out':
      return <TriangleAlert className="sm" />;
    case 'error':
      return <CircleX className="sm" />;
  }
}

/** Why the Project's Forge features are off, and what to do about it, if they are. */
function forgeOffReason(forge: ForgeStatus, environmentLabel: string): ReactNode {
  const command = forge.kind && FORGE_CLI[forge.kind];
  const cli = <span className="tech">{command}</span>;
  const recheck = 'Loom checks again whenever Projects opens.';
  switch (forge.state) {
    case 'no-remote':
      return 'Forge features are off: this checkout has no origin remote.';
    case 'unsupported':
      return (
        <>
          Forge features are off: origin (<span className="tech">{forge.remote}</span>) isn't on GitHub or GitLab.
        </>
      );
    case 'cli-missing':
      return (
        <>
          Forge features are off: {cli} isn't installed in {environmentLabel}, or isn't on your shell's PATH. Install it, then Reload the Environment in Settings.
        </>
      );
    case 'signed-out':
      return (
        <>
          Forge features are off: {cli} isn't signed in to <span className="tech">{forge.host}</span>. Run "
          <span className="tech">{`${command} auth login --hostname ${forge.host}`}</span>"; {recheck}
        </>
      );
    case 'error':
      return `Forge features are off: Loom couldn't check the Forge: ${forge.error}`;
    default:
      return undefined;
  }
}

function BranchPrefix({ project }: { project: Project }) {
  const api = useApi();
  const [value, setValue] = useState(project.branchPrefix);
  const [error, setError] = useState<string>();
  useEffect(() => setValue(project.branchPrefix), [project.branchPrefix]);

  // Enter submits, then leaving the field blurs it: save each value once.
  const sent = useRef<string>(undefined);
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (value === project.branchPrefix || value === sent.current) return;
    sent.current = value;
    setError(undefined);
    api
      .invoke('projects.setBranchPrefix', { id: project.id, branchPrefix: value })
      // Main trims the prefix, which may leave it as it was.
      .then((saved) => setValue(saved.branchPrefix))
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => (sent.current = undefined));
  };
  return (
    <form onSubmit={save}>
      <input
        className="tech prefix"
        aria-label={`Branch prefix for ${project.name}`}
        value={value}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => save()}
      />
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
