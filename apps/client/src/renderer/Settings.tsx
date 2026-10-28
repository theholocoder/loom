import type { EnvironmentStatus } from '../shared/api';
import { useTopic } from './api';

export function Settings() {
  const environments = useTopic('environments') ?? [];
  return (
    <div className="page">
      <h1>Settings</h1>
      <section>
        <h2>Environments</h2>
        {environments.map((env) => (
          <EnvironmentRow key={env.id} env={env} />
        ))}
      </section>
    </div>
  );
}

function EnvironmentRow({ env }: { env: EnvironmentStatus }) {
  const name = `${env.label} Environment`;
  return (
    <div className="env" role="group" aria-label={name}>
      <span className={`dot st-${env.state}`} aria-hidden />
      <div className="grow">
        <div>{`${name}: ${env.state}`}</div>
        {env.bridge && <div className="muted tech">{`loom-bridge ${env.bridge.version}`}</div>}
        {env.error && <div className="err">{env.error}</div>}
      </div>
    </div>
  );
}
