import { CircleCheckBig, CircleX, FolderGit2, FolderOpen, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { FORGE_CLI, type ForgeKind, type ForgeStatus, type Project } from '../shared/api';
import { useApi, useTopic } from './api';

export const FORGE_NAME: Record<ForgeKind, string> = { github: 'GitHub', gitlab: 'GitLab' };

// Laid out like Settings: a .dash page with a card holding a data table.
export function Projects() {
  const api = useApi();
  const projects = useTopic('projects') ?? [];
  const environments = useTopic('environments') ?? [];
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  // Opening Projects checks the Forges again, so what it shows is current.
  useEffect(() => {
    api.invoke('projects.check').catch((error: unknown) => console.error('Forge detection failed:', error));
  }, [api]);

  const useExistingClone = async () => {
    setLinkError(undefined);
    setLinking(true);
    try {
      const path = await api.invoke('dialogs.chooseFolder');
      if (path) await api.invoke('projects.link', { path });
    } catch (error) {
      setLinkError((error as Error).message);
    } finally {
      setLinking(false);
    }
  };

  const environmentLabel = (id: string) => environments.find((e) => e.id === id)?.label ?? id;
  return (
    <main className="dash" aria-label="Projects">
      <div className="row">
        <h1>Projects</h1>
        <span className="grow" />
        <button className="primary" type="button" disabled={linking} onClick={() => void useExistingClone()}>
          <FolderOpen className="sm" />
          Use existing clone…
        </button>
      </div>
      {linkError && (
        <div className="err" role="alert" style={{ marginTop: 8 }}>
          {linkError}
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
    </tr>
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
function forgeOffReason(forge: ForgeStatus, environmentLabel: string): string | undefined {
  const cli = forge.kind && FORGE_CLI[forge.kind];
  const recheck = 'Loom checks again whenever Projects opens.';
  switch (forge.state) {
    case 'no-remote':
      return 'Forge features are off: this checkout has no origin remote.';
    case 'unsupported':
      return `Forge features are off: origin (${forge.remote}) isn't on GitHub or GitLab.`;
    case 'cli-missing':
      return `Forge features are off: ${cli} isn't installed in ${environmentLabel}, or isn't on your shell's PATH. Install it, then Reload the Environment in Settings.`;
    case 'signed-out':
      return `Forge features are off: ${cli} isn't signed in to ${forge.host}. Run "${cli} auth login --hostname ${forge.host}"; ${recheck}`;
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

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (value === project.branchPrefix) return;
    setError(undefined);
    api.invoke('projects.setBranchPrefix', { id: project.id, branchPrefix: value }).catch((e: unknown) => setError((e as Error).message));
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
