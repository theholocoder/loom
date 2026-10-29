import { CircleCheckBig, CircleX, LoaderCircle, Server, TriangleAlert } from 'lucide-react';
import type { EnvironmentState, EnvironmentStatus } from '../shared/api';
import { useTopic } from './api';

// The prototype has no Settings page; it uses the layout of its other full
// page, the Dashboard: a .dash page with a card holding a data table.
export function Settings() {
  const environments = useTopic('environments') ?? [];
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
                <th>Bridge</th>
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
      <td>{env.bridge ? <span className="tech">{`loom-bridge ${env.bridge.version}`}</span> : <span className="muted">—</span>}</td>
    </tr>
  );
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
