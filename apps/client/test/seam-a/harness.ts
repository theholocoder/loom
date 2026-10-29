// Seam A: drives main in-process through the same typed API the renderer
// uses. Everything below the API is real: SQLite in a temporary userData and
// the real loom-bridge binary. Time is a manual clock the test advances, and
// the user's machine is a temporary one (see Machine).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

/** What the scripted `opencode` stand-in reports (see stand-ins/opencode.mjs). */
export interface OpencodeScript {
  /** What `opencode --version` prints. */
  version: string;
  /** What `GET /api/integration` lists. */
  integrations?: Array<{ id: string; name: string; connections: unknown[] }>;
}

const opencodeStandIn = fileURLToPath(new URL('./stand-ins/opencode.mjs', import.meta.url));

/**
 * The user's machine as the native bridge sees it. The bridge is launched the
 * way a desktop launcher would, without the user's shell PATH additions, and
 * finds tools through a stand-in login shell whose PATH the test controls.
 * Native Windows has no login shell: there the bridge's own PATH is used.
 */
export class Machine {
  readonly dir = mkdtempSync(join(tmpdir(), 'loom-machine-'));
  private shellPath: string[] = [];
  private scripts: string[] = [];

  constructor() {
    this.addToShellPath(this.binDir());
  }

  /** The bridge's environment, as a desktop launcher gives it. */
  bridgeEnv(): NodeJS.ProcessEnv {
    if (process.platform === 'win32') return { ...process.env, PATH: [...this.shellPath, process.env.PATH].join(delimiter) };
    const shell = join(this.dir, 'login-shell');
    writeFileSync(
      shell,
      `#!/bin/sh
# Stands in for the user's login shell: the bridge runs it as \`-ilc <command>\`.
PATH="$(cat '${join(this.dir, 'shell-path')}')" exec /bin/sh -c "$2"
`,
      { mode: 0o755 },
    );
    this.writeShellPath();
    return { ...process.env, SHELL: shell };
  }

  /** Adds `dir` to the PATH the login shell reports from now on. */
  addToShellPath(dir: string): void {
    this.shellPath.unshift(dir);
    this.writeShellPath();
  }

  /** A directory for stand-in executables; `name` makes a separate one. */
  binDir(name = 'bin'): string {
    const dir = join(this.dir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Installs the scripted `opencode` stand-in into `binDir`. */
  installOpencode(script: OpencodeScript, binDir = this.binDir()): void {
    const scriptPath = join(binDir, 'opencode.json');
    writeFileSync(scriptPath, JSON.stringify(script));
    this.scripts.push(scriptPath);
    if (process.platform === 'win32') {
      writeFileSync(join(binDir, 'opencode.cmd'), `@"${process.execPath}" "${opencodeStandIn}" "${scriptPath}" %*\r\n`);
    } else {
      writeFileSync(join(binDir, 'opencode'), `#!/bin/sh\nexec '${process.execPath}' '${opencodeStandIn}' '${scriptPath}' "$@"\n`, { mode: 0o755 });
    }
  }

  /** Every argv the installed `opencode` stand-ins were run with. */
  opencodeInvocations(): string[][] {
    return this.scripts.flatMap((script) => {
      let log: string;
      try {
        log = readFileSync(`${script}.log`, 'utf8');
      } catch {
        return [];
      }
      return log.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
    });
  }

  private writeShellPath(): void {
    // The rest of the PATH lets the stand-ins find /bin/sh and friends.
    writeFileSync(join(this.dir, 'shell-path'), [...this.shellPath, '/usr/local/bin', '/usr/bin', '/bin'].join(':'));
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export interface MainHarness {
  api: LoomApi;
  clock: ManualClock;
  userDataDir: string;
  machine: Machine;
  /** The native Environment's bridge process. */
  bridge(): ChildProcess;
  /** Shuts main down; the harness also does this after each test. */
  close(): Promise<void>;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

export async function startMain(
  options: { userDataDir?: string; bridgePath?: string; appVersion?: string; machine?: Machine } = {},
): Promise<MainHarness> {
  const ownDir = !options.userDataDir;
  const machine = options.machine ?? new Machine();
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'loom-seam-a-'));
  const clock = new ManualClock();
  let bridge: ChildProcess | undefined;
  const loom: Loom = await createLoom({
    userDataDir,
    appVersion: options.appVersion ?? appVersion,
    clock,
    bridgePath: options.bridgePath ?? bridgeBinaryPath(fileURLToPath(new URL('../../../../bridge/dist', import.meta.url))),
    spawnBridge: (command, args) => (bridge = spawn(command, args, { stdio: 'pipe', env: machine.bridgeEnv() })),
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
