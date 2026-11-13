// Seam A: drives main in-process through the same typed API the renderer
// uses. Everything below the API is real: SQLite in a temporary userData and
// the real loom-bridge binary. Time is a manual clock the test advances, and
// the user's machine is a temporary one (see Machine).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach } from 'vitest';
import { createLoom, type Loom } from '../../src/main/loom';
import type { Clock, TimerHandle } from '../../src/main/clock';
import type { AgentAdapter } from '../../src/main/agents/adapter';
import type { LoomApi, TopicArgs, TopicName, Topics } from '../../src/shared/api';
import { bridgeBinaryPath } from '../../src/main/environments/bridge-path';
import { PING_INTERVAL_MS } from '../../src/main/environments/environment';
import clientPackage from '../../package.json';

export const appVersion = clientPackage.version;

/** The loom-bridge binary built for this machine. */
export const realBridgePath = bridgeBinaryPath(fileURLToPath(new URL('../../../../bridge/dist', import.meta.url)));

/** A clock that only moves when the test calls `advance`. */
export class ManualClock implements Clock {
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(private time = 1_000_000) {}

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

export * from './machine';
import { Machine, removeTemplates } from './machine';

afterAll(removeTemplates);

export interface MainHarness {
  api: LoomApi;
  clock: ManualClock;
  userDataDir: string;
  machine: Machine;
  /** Every URL main has opened in the user's browser, in order. */
  opened: string[];
  /** Every desktop notification main has shown, in order; `click` clicks it. */
  notifications: ShownNotification[];
  /** Gives Loom's window the focus, or takes it away: it starts without. */
  setWindowFocused(focused: boolean): void;
  /** The native Environment's bridge process: the one started last. */
  bridge(): ChildProcess;
  /** How many times main has started a bridge. */
  bridgeStarts(): number;
  /** Starts bridges from `path` from now on; undefined goes back to the real one. */
  setBridgePath(path: string | undefined): void;
  /**
   * Moves the clock forward `ms` as time passes for real: what the bridges
   * were asked before lands first, and the native Environment's bridge
   * answers each ping it is sent on the way, so it isn't taken for frozen.
   */
  elapse(ms: number): Promise<void>;
  /** Shuts main down; the harness also does this after each test. */
  close(): Promise<void>;
}

// Undone last first after each test, so a folder is removed only once every
// main started after it has closed: Windows can't remove a database in use.
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

/** A temporary folder for a test, removed after the mains started after it close. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  open.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A Machine a test shares between mains, removed after they close. */
export function tempMachine(): Machine {
  const machine = new Machine();
  open.push(async () => machine.remove());
  return machine;
}

/** A desktop notification main showed. */
export interface ShownNotification {
  title: string;
  body: string;
  click(): void;
}

export async function startMain(
  options: {
    userDataDir?: string;
    bridgePath?: string;
    appVersion?: string;
    machine?: Machine;
    maxUntrackedCounted?: number;
    /** An agent standing in for OpenCode over ACP, for what no ACP agent does yet. */
    adapter?: AgentAdapter;
    /** The clock time main starts at. */
    now?: number;
    /** The system's regional format, as Electron reports it. */
    systemLocale?: string;
  } = {},
): Promise<MainHarness> {
  const ownDir = !options.userDataDir;
  const machine = options.machine ?? new Machine();
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'loom-seam-a-'));
  const clock = new ManualClock(options.now);
  let bridge: ChildProcess | undefined;
  let bridgeStarts = 0;
  let bridgePath: string | undefined;
  const opened: string[] = [];
  const notifications: ShownNotification[] = [];
  let windowFocused = false;
  const loom: Loom = await createLoom({
    userDataDir,
    appVersion: options.appVersion ?? appVersion,
    clock,
    maxUntrackedCounted: options.maxUntrackedCounted,
    adapter: options.adapter,
    systemLocale: options.systemLocale,
    bridgePath: options.bridgePath ?? realBridgePath,
    spawnBridge: (command, args) => {
      bridgeStarts++;
      return (bridge = spawn(bridgePath ?? command, args, { stdio: 'pipe', env: machine.bridgeEnv() }));
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    notify: ({ title, body, onClick }) => notifications.push({ title, body, click: onClick }),
    windowFocused: () => windowFocused,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await loom.close();
    if (ownDir) rmSync(userDataDir, { recursive: true, force: true });
    if (!options.machine) machine.remove();
  };
  open.push(close);
  return {
    api: loom.api,
    clock,
    userDataDir,
    machine,
    opened,
    notifications,
    setWindowFocused: (focused) => (windowFocused = focused),
    bridge: () => {
      if (!bridge) throw new Error('the bridge has not been spawned');
      return bridge;
    },
    bridgeStarts: () => bridgeStarts,
    setBridgePath: (path) => (bridgePath = path),
    elapse: async (ms) => {
      // Bridge requests still going (such as the ack of a write to an agent,
      // which may come after the agent's answer to it) time out on this clock:
      // they land first, as they would long before that much time had passed.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const end = clock.now() + ms;
      while (clock.now() < end) {
        const native = (await loom.api.invoke('environments.list')).find((e) => e.id === 'native');
        // A ping goes PING_INTERVAL_MS after the last one answered: the clock stops there until it is answered.
        if (native && native.state !== 'connected') throw new Error(`elapse: the native Environment is ${native.state}`);
        const ping = native?.lastSeenAt !== undefined ? native.lastSeenAt + PING_INTERVAL_MS : Infinity;
        const to = Math.min(end, ping);
        clock.advance(to - clock.now());
        if (to === ping) await waitFor(loom.api, 'environments', (envs) => envs.some((e) => e.id === 'native' && e.lastSeenAt === ping));
      }
    },
    close,
  };
}

/** Resolves with the first value of `topic` that satisfies `predicate`. */
export function waitFor<T extends TopicName>(
  api: LoomApi,
  topic: T,
  predicate: (value: Topics[T]) => boolean,
  ...params: TopicArgs<T>
): Promise<Topics[T]> {
  const timeoutMs = 5000;
  return new Promise((resolve, reject) => {
    let last: Topics[T] | undefined;
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting on "${topic}"; last value: ${JSON.stringify(last)}`));
    }, timeoutMs);
    let done = false;
    unsubscribe = api.subscribe(
      topic,
      (value) => {
        last = value;
        if (done || !predicate(value)) return;
        done = true;
        clearTimeout(timer);
        queueMicrotask(() => unsubscribe());
        resolve(value);
      },
      ...params,
    );
    if (done) unsubscribe();
  });
}

/** Resolves once the process with `pid` has exited. */
export async function processEnded(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`process ${pid} still running`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
