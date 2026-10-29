import { CircleCheckBig, CircleX, LoaderCircle, RotateCw, Server, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { OPENCODE_MIN_VERSION, type AgentStatus, type EnvironmentState, type EnvironmentStatus } from '../shared/api';
import { useApi, useTopic } from './api';

// The prototype has no Settings page; it uses the layout of its other full
// page, the Dashboard: a .dash page with a card holding a data table.
export function Settings() {
  const api = useApi();
  const environments = useTopic('environments') ?? [];
  // Opening Settings checks the agents again, so what it shows is current.
  useEffect(() => {
    api.invoke('environments.detect').catch((error: unknown) => console.error('agent detection failed:', error));
  }, [api]);
  return (
    <main className="dash" aria-label="Settings">
      <div className="row">
        <h1>Settings</h1>
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
            <Server className="sm" />
            <h3>Environments</h3>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>Environment</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Bridge</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {environments.map((env) => (
                <EnvironmentRow key={env.id} env={env} />
              ))}
            </tbody>
          </table>
      </div>
    </main>
  );
}

function EnvironmentRow({ env }: { env: EnvironmentStatus }) {
  const api = useApi();
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string>();
  const reload = () => {
    setReloading(true);
    setReloadError(undefined);
    api
      .invoke('environments.reload', { id: env.id })
      .catch((error: unknown) => setReloadError((error as Error).message))
      .finally(() => setReloading(false));
  };
  const warnings = [shellWarning(env), env.agent && agentWarning(env.agent)].filter((w): w is string => !!w);
  return (
    <tr>
      <td>{env.label}</td>
      <td>
        <span className={`row st-${env.state}`}>
          <StateIcon state={env.state} />
          <span>{env.state}</span>
        </span>
        {env.error && <div className="err">{env.error}</div>}
      </td>
      <td>
        {env.agent ? <AgentCell agent={env.agent} /> : <span className="muted">—</span>}
        {warnings.map((warning) => (
          <div key={warning} className="warn" role="alert">
            {warning}
          </div>
        ))}
      </td>
      <td>{env.bridge ? <span className="tech">{`loom-bridge ${env.bridge.version}`}</span> : <span className="muted">—</span>}</td>
      <td>
        <button
          type="button"
          title="Re-read your shell environment, for tools installed since Loom started"
          disabled={reloading || env.state !== 'connected'}
          onClick={reload}
        >
          <span className={reloading ? 'spin' : undefined}>
            <RotateCw className="sm" />
          </span>
          Reload
        </button>
        {reloadError && <div className="err">{reloadError}</div>}
      </td>
    </tr>
  );
}

function AgentCell({ agent }: { agent: AgentStatus }) {
  const label = agent.checking ? 'checking' : agent.state;
  return (
    <>
      <div className="tech" title={agent.path}>
        {agent.version ? `${agent.name} ${agent.version}` : agent.name}
      </div>
      <span className={`row ag-${agent.checking ? 'checking' : agent.state}`}>
        <AgentIcon agent={agent} />
        <span>{label}</span>
      </span>
    </>
  );
}

function AgentIcon({ agent }: { agent: AgentStatus }) {
  if (agent.checking) {
    return (
      <span className="spin">
        <LoaderCircle className="sm" />
      </span>
    );
  }
  switch (agent.state) {
    case 'ready':
      return <CircleCheckBig className="sm" />;
    case 'unknown':
      return null;
    case 'signed-out':
    case 'unsupported':
      return <TriangleAlert className="sm" />;
    case 'missing':
    case 'error':
      return <CircleX className="sm" />;
  }
}

/** What to fix before the agent can run Sessions, if anything. */
function agentWarning(agent: AgentStatus): string | undefined {
  const install = `Install OpenCode ${OPENCODE_MIN_VERSION} or later, then Reload.`;
  switch (agent.state) {
    case 'missing':
      return `OpenCode isn't installed in this Environment, or isn't on your shell's PATH. ${install}`;
    case 'unsupported':
      return agent.version?.startsWith('1.')
        ? `OpenCode ${agent.version} is V1 OpenCode (opencode-ai), which is not supported. ${install}`
        : `OpenCode ${agent.version} is too old. ${install}`;
    case 'signed-out':
      return "OpenCode isn't signed in to any model provider. Sign in from OpenCode; Loom checks again whenever Settings opens.";
    case 'error':
      return `Loom couldn't check OpenCode: ${agent.error}`;
    default:
      return undefined;
  }
}

/** Native Windows has no login shell, so only other Environments warn. */
function shellWarning(env: EnvironmentStatus): string | undefined {
  if (env.shellEnvironment !== 'bridge' || env.bridge?.os === 'windows') return undefined;
  return "Loom couldn't read your login shell's environment, so tools set up in your shell profile (mise, asdf, ~/.local/bin) may not be found.";
}

function StateIcon({ state }: { state: EnvironmentState }) {
  switch (state) {
    case 'connected':
      return <CircleCheckBig className="sm" />;
    case 'starting':
      return (
        <span className="spin">
          <LoaderCircle className="sm" />
        </span>
      );
    case 'unresponsive':
      return <TriangleAlert className="sm" />;
    case 'disconnected':
    case 'failed':
      return <CircleX className="sm" />;
  }
}
