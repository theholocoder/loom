// Seam A: drives main in-process through the same typed API the renderer
// uses. Everything below the API is real: SQLite in a temporary userData and
// the real loom-bridge binary. Time is a manual clock the test advances, and
// the user's machine is a temporary one (see Machine).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { createLoom, type Loom } from '../../src/main/loom';
import type { Clock, TimerHandle } from '../../src/main/clock';
import type { LoomApi, TopicArgs, TopicName, Topics } from '../../src/shared/api';
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
  /** What `opencode acp` does. */
  acp?: {
    /** Each process plays one turn per `session/prompt`, in order; past the end, a turn that says nothing. */
    turns: AcpTurn[];
  };
}

/** One run of the `opencode acp` stand-in. */
export interface AcpTurn {
  /** The agent's reply, sent as one `agent_message_chunk` each. */
  chunks?: string[];
  /** After the chunks, the run holds until the test calls `machine.release(hold)`. */
  hold?: string;
  /** The run fails with this JSON-RPC error message, as a provider error does. */
  error?: string;
}

/** An ACP message the `opencode acp` stand-in received. */
export interface AcpMessage {
  pid: number;
  cwd: string;
  message: { id?: number; method?: string; params?: Record<string, unknown> };
}

/** What a scripted `gh` or `glab` stand-in reports (see stand-ins/forge-cli.mjs). */
export interface ForgeCliScript {
  /** The hosts `auth status --hostname <host>` says it is signed in to. */
  signedInHosts: string[];
  /**
   * Exactly what `auth status --hostname <host>` prints and exits with, per
   * host, overriding `signedInHosts` (real CLIs vary: glab writes to stderr,
   * and some versions exit 0 when signed out or 1 on a mere warning).
   */
  authStatus?: Record<string, { stdout?: string; stderr?: string; exitCode: number }>;
  /** What `repo view --output json` prints and exits with (default: fails, not a repository). */
  repoView?: { stdout?: string | object; stderr?: string; exitCode?: number };
  /** The open issues `issue list` lists. */
  issues?: { number: number; title: string; body: string; url: string }[];
}

export type ForgeCli = 'gh' | 'glab';

const opencodeStandIn = fileURLToPath(new URL('./stand-ins/opencode.mjs', import.meta.url));
const forgeCliStandIn = fileURLToPath(new URL('./stand-ins/forge-cli.mjs', import.meta.url));
const editorStandIn = fileURLToPath(new URL('./stand-ins/editor.mjs', import.meta.url));

/** One run of a stub editor (see stand-ins/editor.mjs). */
export interface EditorInvocation {
  args: string[];
  /** The folder it ran in, written like `folder()` paths. */
  cwd: string;
}

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

  /** The user's home folder, empty to start with. */
  get home(): string {
    const dir = join(this.dir, 'home');
    mkdirSync(dir, { recursive: true });
    const real = realpathSync.native(dir);
    return process.platform === 'win32' ? real.replaceAll('\\', '/') : real;
  }

  /** The bridge's environment, as a desktop launcher gives it. */
  bridgeEnv(): NodeJS.ProcessEnv {
    const home = { HOME: this.home, USERPROFILE: this.home };
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      return { ...process.env, ...home, PATH: [...this.shellPath, dirname(onHostPath('git')), join(systemRoot, 'System32'), systemRoot].join(delimiter) };
    }
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
    return { ...process.env, ...home, SHELL: shell };
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
    this.installStandIn('opencode', opencodeStandIn, script, binDir);
  }

  /** Every argv the installed `opencode` stand-ins were run with. */
  opencodeInvocations(): string[][] {
    return this.invocations('opencode');
  }

  /** Every ACP message the `opencode acp` stand-ins received, in order. */
  /** What the `opencode acp` stand-ins received, with `cwd` written like `folder()` paths. */
  acpMessages(): AcpMessage[] {
    return this.scripts
      .filter((script) => basename(script) === 'opencode.json')
      .flatMap((script) => readLines(`${script}.acp.log`).map((line) => JSON.parse(line) as AcpMessage))
      .map((m) => (process.platform === 'win32' ? { ...m, cwd: m.cwd.replaceAll('\\', '/') } : m));
  }

  /** Lets an `opencode acp` stand-in run holding on `name` finish. */
  release(name: string): void {
    for (const script of this.scripts) writeFileSync(join(dirname(script), `release-${name}`), '');
  }

  /** Installs a scripted `gh` or `glab` stand-in into `binDir`. */
  installForgeCli(cli: ForgeCli, script: ForgeCliScript, binDir = this.binDir()): void {
    this.installStandIn(cli, forgeCliStandIn, script, binDir);
  }

  /** Every argv the installed `gh` or `glab` stand-ins were run with. */
  forgeCliInvocations(cli: ForgeCli): string[][] {
    return this.invocations(cli);
  }

  /** The working directory of every run of the `gh` or `glab` stand-in, in order, written like `folder()` paths. */
  forgeCliCwds(cli: ForgeCli): string[] {
    const cwds = readLines(join(this.binDir(), `${cli}.json.cwd`));
    return process.platform === 'win32' ? cwds.map((cwd) => cwd.replaceAll('\\', '/')) : cwds;
  }

  /**
   * Installs a stub editor (or terminal) named `name` into `binDir`, which
   * records how it was run and exits.
   */
  installEditor(name: string, binDir = this.binDir()): void {
    this.installStandIn(name, editorStandIn, null, binDir);
  }

  /** Every run of the stub editor `name` so far, in order. */
  editorInvocations(name: string): EditorInvocation[] {
    return readLines(join(this.binDir(), `${name}.json.log`)).map((line) => JSON.parse(line) as EditorInvocation);
  }

  /**
   * A real git repository in a new folder, with `origin` set to `origin` if
   * given. Returns its path as git reports it.
   */
  gitRepo(name: string, options: { origin?: string } = {}): string {
    const dir = this.folder(name);
    execFileSync('git', ['init', '--quiet', dir]);
    if (options.origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', options.origin]);
    return dir;
  }

  /**
   * A bare repository standing in for a Forge's, whose default branch
   * `defaultBranch` has one commit adding `README.md`. Returns its path.
   */
  gitOrigin(name: string, defaultBranch = 'main'): string {
    const dir = this.folder(`${name}.git`);
    execFileSync('git', ['init', '--quiet', '--bare', `--initial-branch=${defaultBranch}`, dir]);
    const seed = this.folder(`${name}-seed`);
    execFileSync('git', ['clone', '--quiet', dir, seed], { stdio: 'ignore' });
    this.commit(seed, 'README.md', `# ${name}\n`);
    git(seed, 'push', '--quiet', 'origin', `HEAD:${defaultBranch}`);
    rmSync(seed, { recursive: true, force: true });
    return dir;
  }

  /** A clone of `origin`, as a user's checkout. Returns its path as git reports it. */
  gitClone(origin: string, name: string): string {
    const dir = this.folder(name);
    execFileSync('git', ['clone', '--quiet', origin, dir], { stdio: 'ignore' });
    return dir;
  }

  /** Writes `file` in the checkout `repo` and commits it. Returns the new commit. */
  commit(repo: string, file: string, content: string): string {
    writeFileSync(join(repo, file), content);
    git(repo, 'add', file);
    git(repo, 'commit', '--quiet', '-m', `Change ${file}`);
    return git(repo, 'rev-parse', 'HEAD');
  }

  /** A new empty folder, with its real path (git reports real paths). */
  folder(name: string): string {
    const dir = join(this.dir, 'code', name);
    mkdirSync(dir, { recursive: true });
    const real = realpathSync.native(dir);
    return process.platform === 'win32' ? real.replaceAll('\\', '/') : real;
  }

  private installStandIn(name: string, standIn: string, script: unknown, binDir: string): void {
    const scriptPath = join(binDir, `${name}.json`);
    writeFileSync(scriptPath, JSON.stringify(script));
    this.scripts.push(scriptPath);
    if (process.platform === 'win32') {
      writeFileSync(join(binDir, `${name}.cmd`), `@"${process.execPath}" "${standIn}" "${scriptPath}" %*\r\n`);
    } else {
      writeFileSync(join(binDir, name), `#!/bin/sh\nexec '${process.execPath}' '${standIn}' '${scriptPath}' "$@"\n`, { mode: 0o755 });
    }
  }

  private invocations(name: string): string[][] {
    return this.scripts
      .filter((script) => basename(script) === `${name}.json`)
      .flatMap((script) => readLines(`${script}.log`).map((line) => JSON.parse(line) as string[]));
  }

  private writeShellPath(): void {
    writeFileSync(join(this.dir, 'shell-path'), [...this.shellPath, this.systemBin()].join(':'));
  }

  /**
   * The rest of the login shell's PATH: links to the few system tools the
   * bridge and the stand-ins need, and nothing else, so the host's own `gh`,
   * `glab` or `opencode` are never found.
   */
  private systemBin(): string {
    const dir = join(this.dir, 'system-bin');
    if (!existsSync(dir)) {
      mkdirSync(dir);
      for (const tool of ['env', 'git', 'sh']) symlinkSync(onHostPath(tool), join(dir, tool));
    }
    return dir;
  }

  remove(): void {
    // Retries: on Windows, a stub editor that has just exited may still hold its folder.
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 10 });
  }
}

/** Runs git in `repo` on this test's machine, as a set-up step; returns what it prints, trimmed. */
export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The non-empty lines of a log file, none if it doesn't exist yet. */
function readLines(file: string): string[] {
  let log: string;
  try {
    log = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return log.split('\n').filter(Boolean);
}

/** Where `tool` is on the PATH this test process was started with. */
function onHostPath(tool: string): string {
  const names = process.platform === 'win32' ? [`${tool}.exe`, `${tool}.cmd`] : [tool];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`${tool} is not on this machine's PATH`);
}

export interface MainHarness {
  api: LoomApi;
  clock: ManualClock;
  userDataDir: string;
  machine: Machine;
  /** Every URL main has opened in the user's browser, in order. */
  opened: string[];
  /** The native Environment's bridge process. */
  bridge(): ChildProcess;
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

export async function startMain(
  options: { userDataDir?: string; bridgePath?: string; appVersion?: string; machine?: Machine } = {},
): Promise<MainHarness> {
  const ownDir = !options.userDataDir;
  const machine = options.machine ?? new Machine();
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'loom-seam-a-'));
  const clock = new ManualClock();
  let bridge: ChildProcess | undefined;
  const opened: string[] = [];
  const loom: Loom = await createLoom({
    userDataDir,
    appVersion: options.appVersion ?? appVersion,
    clock,
    bridgePath: options.bridgePath ?? bridgeBinaryPath(fileURLToPath(new URL('../../../../bridge/dist', import.meta.url))),
    spawnBridge: (command, args) => (bridge = spawn(command, args, { stdio: 'pipe', env: machine.bridgeEnv() })),
    openExternal: async (url) => {
      opened.push(url);
    },
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
