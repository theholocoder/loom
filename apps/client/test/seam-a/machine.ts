// The user's machine as the bridge sees it: a temporary folder with a
// stand-in login shell, stand-in tools and real git repositories. Shared by
// seam A and the Electron smoke tests, so it imports no test runner.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the scripted `opencode` stand-in reports (see stand-ins/opencode.mjs). */
export interface OpencodeScript {
  /** What `opencode --version` prints. */
  version: string;
  /** What `GET /api/integration` lists. */
  integrations?: Array<{ id: string; name: string; connections: unknown[] }>;
  /**
   * The models the user's providers offer, in the order `GET /api/model`
   * lists them; `opencode acp`'s `model` and `effort` config options offer
   * them too, the first being the current one of a new session.
   */
  models?: StandInModel[];
  /**
   * The commands `GET /api/command` lists; `opencode acp` announces them in
   * an `available_commands_update` after `session/new`, with its own
   * `compact`, as OpenCode does.
   */
  commands?: Array<{ name: string; description?: string }>;
  /**
   * The skills `GET /api/skill` lists, each with its `path` (by default under
   * `/home/dev/.agents/skills`) and a `content`, as OpenCode's do. Like OpenCode, it lists none before the process has
   * loaded the checkout: before `GET /api/model`.
   */
  skills?: Array<{ id: string; name: string; description?: string; path?: string }>;
  /** `GET /api/command` and `GET /api/skill` answer 404, as an OpenCode without them would. */
  noCatalog?: boolean;
  /** What `opencode acp` does. */
  acp?: {
    /** Each process plays one turn per `session/prompt`, in order; past the end, a turn that says nothing. */
    turns: AcpTurn[];
    /** A file each process writes in its working copy as its stdin closes. */
    writeOnExit?: string;
    /** Each process answers `session/new` only once the test calls `machine.release(holdNew)`: an agent slow to start. */
    holdNew?: string;
    /** Each process answers `session/set_config_option` only once the test calls `machine.release(holdConfig)`. */
    holdConfig?: string;
    /** Each process says in `initialize` that it takes images in prompts (`promptCapabilities.image`). */
    images?: boolean;
    /** What a process that resumed or loaded a session plays instead of `turns`. */
    resumedTurns?: AcpTurn[];
    /** The ways of taking up a session each process turns down, as OpenCode does one it doesn't know. */
    refuse?: Array<'session/resume' | 'session/load'>;
  };
}

/** A model as the stand-in reports it, in OpenCode's terms. */
export interface StandInModel {
  providerID: string;
  id: string;
  name: string;
  /** Its variants, which ACP offers as Effort levels (with `default`). */
  variants?: string[];
  /** Its context window, in tokens: `usage_update`'s `size`. */
  context?: number;
  /** False for a model the user turned off; listed all the same. */
  enabled?: boolean;
}

/** An HTTP request the `opencode serve` stand-in answered. */
export interface OpencodeRequest {
  method: string;
  path: string;
  /** Its `x-opencode-directory` header, written like `folder()` paths. */
  directory?: string;
}

/** One run of the `opencode acp` stand-in. */
export interface AcpTurn {
  /**
   * The agent's reply, sent as one `agent_message_chunk` each; a `{ hold }`
   * waits for `machine.release(hold)`, an `{ update }` is sent as a
   * `session/update` as is, and a `{ bigOutput }` completes a tool call with
   * an output of that many bytes, `HEAD>` x's `<TAIL`. An `{ elicit }` sends
   * `elicitation/create` (form mode, with these params) and waits for Loom's
   * response, which the ACP log records.
   */
  chunks?: Array<
    | string
    | { hold: string }
    | { update: Record<string, unknown> }
    | { bigOutput: { toolCallId: string; bytes: number } }
    | { elicit: { message: string; requestedSchema: Record<string, unknown>; toolCallId?: string } }
    | { permission: PermissionToolCall }
  >;
  /** After the chunks, the run holds until the test calls `machine.release(hold)`. */
  hold?: string;
  /** The run fails with this JSON-RPC error message, as a provider error does. */
  error?: string;
  /** The run ends with a `usage_update` of this many context tokens used, out of the current model's `context`. */
  used?: number;
  /** The session's cumulative cost after the run, in USD, which its `usage_update` carries. */
  cost?: number;
  /** The run's token usage, which the `session/prompt` response carries (cancelled or not). */
  tokens?: { inputTokens: number; outputTokens: number; thoughtTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number };
}

/**
 * The tool call of a `session/request_permission` the stand-in sends, as
 * OpenCode 2.2.5 does: `{ permission }` chunks wait for Loom's answer, and a
 * reject ends the turn as cancelled.
 */
export interface PermissionToolCall {
  toolCallId: string;
  name: string;
  title: string;
  kind: string;
  locations: Array<{ path: string }>;
  rawInput: Record<string, unknown>;
}

/** An ACP message the `opencode acp` stand-in received. */
export interface AcpMessage {
  pid: number;
  cwd: string;
  /** The process's OPENCODE_CONFIG_CONTENT. */
  config?: string;
  message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };
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
  /** The Merge requests `pr`/`mr list` and `view` know of; `state` defaults to open. */
  mergeRequests?: ({ number: number; url: string; branch: string; state?: 'open' | 'merged' | 'closed' } & ScriptedActivity)[];
  /** The account signed in, whose comments are the user's own (default: `octocat`). */
  viewer?: string;
  /** Set when Babysit's polls should fail, as with an unreachable Forge. */
  offline?: boolean;
}

/** What Babysit's polls see of a Merge request, in terms common to both stand-ins. */
export interface ScriptedActivity {
  /** GitHub's issue comments, or GitLab's notes (`system` ones and `path`/`line` diff notes too). */
  comments?: { id: number; author: string | null; body: string; url?: string; path?: string; line?: number; system?: boolean }[];
  /** GitHub's reviews with their inline comments. */
  reviews?: { id: number; author: string | null; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'; body?: string; url: string; comments?: { path: string; line?: number; originalLine?: number; body: string; url: string }[] }[];
  /** GitHub's check runs (`id`) and commit statuses (`context`) on the head commit. */
  checks?: ({ id: number; name: string; status?: string; conclusion?: string; url?: string; context?: undefined } | { context: string; state: string; url?: string; createdAt?: string })[];
  /** What GitHub sums the checks up as, when it isn't what they say (a suite with no runs yet). */
  rollupState?: string;
  /** The head commit, which a new push changes. */
  oid?: string;
  /** Absent while the Forge hasn't worked it out. */
  conflicts?: boolean;
  /** GitLab's head pipeline. */
  pipeline?: { id: number; status: string; failedJobs?: { id: number; name: string; url: string }[]; jobs?: { id: number; name: string; status: string; url: string }[] };
  /** Who approved it on GitLab. */
  approvedBy?: string[];
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

  /** The HTTP requests the `opencode serve` stand-ins answered, in order. */
  opencodeRequests(): OpencodeRequest[] {
    return this.scripts
      .filter((script) => basename(script) === 'opencode.json')
      .flatMap((script) => readLines(`${script}.http.log`).map((line) => JSON.parse(line) as OpencodeRequest))
      .map((r) => (process.platform === 'win32' && r.directory ? { ...r, directory: r.directory.replaceAll('\\', '/') } : r));
  }

  /** Lets an `opencode acp` stand-in run holding on `name` finish. */
  release(name: string): void {
    for (const script of this.scripts) writeFileSync(join(dirname(script), `release-${name}`), '');
  }

  /** The file whose existence releases the hold `name` of the `opencode` stand-in, for a process other than the test to write. */
  releaseFile(name: string): string {
    const script = this.scripts.find((s) => basename(s) === 'opencode.json');
    if (!script) throw new Error('no opencode stand-in installed');
    return join(dirname(script), `release-${name}`);
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
    // Main may be running the stand-in right now (Babysit polls in the background):
    // it reads a whole script, the old or the new, and its launcher is left alone.
    writeFileSync(`${scriptPath}.tmp`, JSON.stringify(script));
    renameSync(`${scriptPath}.tmp`, scriptPath);
    // Installed again, it is the same script: its logs must be read once.
    if (!this.scripts.includes(scriptPath)) this.scripts.push(scriptPath);
    if (process.platform === 'win32') {
      const launcher = join(binDir, `${name}.cmd`);
      if (!existsSync(launcher)) writeFileSync(launcher, `@"${process.execPath}" "${standIn}" "${scriptPath}" %*\r\n`);
    } else {
      const launcher = join(binDir, name);
      if (!existsSync(launcher)) writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${standIn}' '${scriptPath}' "$@"\n`, { mode: 0o755 });
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
