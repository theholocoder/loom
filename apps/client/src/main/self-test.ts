// The self-test CI runs on each packaged build (LOOM_SELF_TEST=1): Loom
// starts, opens its database and connects its native Environment's bridge,
// says so, and quits. It shows that the packaged app, its native SQLite
// driver and the bridge binary in its resources all work.
import type { DatabaseStatus, EnvironmentStatus, LoomApi } from '../shared/api';

/** Resolves with what passed once the database is open and every Environment is connected; rejects with why not. */
export async function selfTest(api: LoomApi): Promise<string> {
  const database = await currentDatabase(api);
  if (database.state !== 'ok') throw new Error(`the database ${database.path} is damaged: ${database.problem}`);
  const environments = await new Promise<EnvironmentStatus[]>((resolve, reject) => {
    let stop: (() => void) | undefined;
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
      queueMicrotask(() => stop?.());
    };
    stop = api.subscribe('environments', (list) => {
      const broken = list.find((e) => e.state === 'failed' || e.state === 'disconnected');
      if (broken) settle(() => reject(new Error(`${broken.label} is ${broken.state}: ${broken.error ?? 'no reason given'}`)));
      else if (list.length && list.every((e) => e.state === 'connected')) settle(() => resolve(list));
    });
    if (done) stop();
  });
  return `database ok; ${environments.map((e) => `${e.label} connected to loom-bridge ${e.bridge?.version ?? '?'}`).join('; ')}`;
}

/** The database's state: a topic gives its current value as soon as it is subscribed to. */
function currentDatabase(api: LoomApi): Promise<DatabaseStatus> {
  return new Promise((resolve) => {
    const stop = api.subscribe('database', (value) => {
      queueMicrotask(() => stop());
      resolve(value);
    });
  });
}
