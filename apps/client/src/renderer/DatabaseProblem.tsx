// The blocking screen main's damaged database shows instead of the window.
// Loom never repairs the file: the user restores a snapshot, or deals with it.
import { DatabaseBackup, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { DatabaseStatus } from '../shared/api';
import { useApi } from './api';

export function DatabaseProblem({ status }: { status: Extract<DatabaseStatus, { state: 'damaged' }> }) {
  const api = useApi();
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string>();
  const restore = async () => {
    setRestoring(true);
    setError(undefined);
    try {
      await api.invoke('database.restoreLatestSnapshot');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="database-problem" role="alert" aria-labelledby="database-problem-title">
      <h1 id="database-problem-title">
        <TriangleAlert /> The database is damaged
      </h1>
      <p>
        Loom can't open <code>{status.path}</code>: {status.problem}. It won't try to repair it.
      </p>
      {status.snapshots.length ? (
        <>
          <p>Snapshots, newest first:</p>
          <ul>
            {status.snapshots.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
          <p>Restoring moves the damaged file aside, next to it, and puts the latest snapshot in its place.</p>
          <button className="primary" type="button" disabled={restoring} onClick={() => void restore()}>
            <DatabaseBackup /> Restore latest snapshot
          </button>
        </>
      ) : (
        <p>There are no snapshots to restore. Move the file aside to start with an empty database.</p>
      )}
      {error && <p className="error">Couldn't restore: {error}</p>}
    </div>
  );
}
