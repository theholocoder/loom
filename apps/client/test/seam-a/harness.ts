// Seam A: drives main in-process through the same typed API the renderer
// uses. Everything below the API is real: SQLite in a temporary userData and
// the real loom-bridge binary. Time is a manual clock the test advances.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { createLoom, type Loom } from '../../src/main/loom';
import type { Clock, TimerHandle } from '../../src/main/clock';
import type { LoomApi, TopicName, Topics } from '../../src/shared/api';
import { bridgeBinaryPath } from '../../src/main/environments/bridge-path';
import clientPackage from '../../package.json';

export const appVersion = clientPackage.version;

/** A clock that only moves when the test calls `advance`. */
export class ManualClock implements Clock {
  private time = 1_000_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Moves time forward, firing every timer that falls due on the way. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort(([a, ta], [b, tb]) => ta.at - tb.at || a - b)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.time = timer.at;
      timer.fn();
    }
    this.time = end;
  }
}

export interface MainHarness {
  api: LoomApi;
  clock: ManualClock;
  userDataDir: string;
  /** The native Environment's bridge process. */
  bridge(): ChildProcess;
  /** Shuts main down; the harness also does this after each test. */
  close(): Promise<void>;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

export async function startMain(options: { userDataDir?: string; bridgePath?: string; appVersion?: string } = {}): Promise<MainHarness> {
  const ownDir = !options.userDataDir;
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'loom-seam-a-'));
  const clock = new ManualClock();
  let bridge: ChildProcess | undefined;
  const loom: Loom = await createLoom({
    userDataDir,
    appVersion: options.appVersion ?? appVersion,
    clock,
    bridgePath: options.bridgePath ?? bridgeBinaryPath(fileURLToPath(new URL('../../../../bridge/dist', import.meta.url))),
    spawnBridge: (command, args) => (bridge = spawn(command, args, { stdio: 'pipe' })),
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await loom.close();
    if (ownDir) rmSync(userDataDir, { recursive: true, force: true });
  };
  open.push(close);
  return {
    api: loom.api,
    clock,
    userDataDir,
    bridge: () => {
      if (!bridge) throw new Error('the bridge has not been spawned');
      return bridge;
    },
    close,
  };
}

/** Resolves with the first value of `topic` that satisfies `predicate`. */
export function waitFor<T extends TopicName>(
  api: LoomApi,
  topic: T,
  predicate: (value: Topics[T]) => boolean,
  timeoutMs = 5000,
): Promise<Topics[T]> {
  return new Promise((resolve, reject) => {
    let last: Topics[T] | undefined;
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting on "${topic}"; last value: ${JSON.stringify(last)}`));
    }, timeoutMs);
    let done = false;
    unsubscribe = api.subscribe(topic, (value) => {
      last = value;
      if (done || !predicate(value)) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe());
      resolve(value);
    });
    if (done) unsubscribe();
  });
}
