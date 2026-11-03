// The Working copy service: making a worktree Session's git worktree, checking
// it for unsaved work, and removing it on archive while keeping its branch.
// Everything runs in the Project's Environment, through its bridge (ADR 0008).
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';
import { GIT_TIMEOUT_MS } from '../projects/forge';
import type { Branches, ExistingBranch, UnsavedWork } from '../../shared/api';
import { checkWorktreeRoot } from '../settings';

/** What the Working copy service needs from an Environment. */
export interface GitEnvironment extends GitRunner {
  /** The user's home there, once the bridge has said. */
  home(): string | undefined;
}

/** What running git in an Environment needs. */
export interface GitRunner {
  label: string;
  request: BridgeCall;
}

export interface NewWorktree {
  /** The Project's checkout, which the worktree is added to. */
  checkout: string;
  projectName: string;
  branchPrefix: string;
  /** The worktree root setting, perhaps starting with `~`. */
  root: string;
  /**
   * A new branch to create, `-2`, `-3`, … added if it is taken, from `base`
   * (an `origin` branch, `origin`'s default if absent); or an existing branch
   * to check out as-is.
   */
  branch: { new: string; base?: string } | { existing: ExistingBranch };
}

const FETCH_TIMEOUT_MS = 120_000;
const FILES_TIMEOUT_MS = 60_000;
/** How many paths one `git ls-files` is given, to stay under command-line limits. */
const IGNORED_BATCH = 500;
const MAX_SUFFIX = 100;

/**
 * Adds a worktree under `<root>/<project>/<branch slug>` and copies in the
 * files `.worktreeinclude` asks for. Resolves with where it is and its branch.
 * The checkout's own branch and changes play no part.
 *
 * A new branch is made from a freshly fetched `origin/<base>`, not tracking
 * it. An existing local branch is checked out as it is; an existing `origin`
 * branch is fetched and checked out on its same-named local branch, which is
 * created to track it if there is none.
 */
export async function createWorktree(environment: GitEnvironment, worktree: NewWorktree): Promise<{ path: string; branch: string }> {
  const { checkout } = worktree;
  const root = expandRoot(environment, worktree.root);
  let branch: string;
  let path: string;
  // Whether the branch is Loom's own, to be deleted again if the worktree can't be made.
  let created: boolean;
  if ('new' in worktree.branch) {
    await checkBranchName(environment, worktree.branch.new);
    await fetchOrigin(environment, checkout);
    const base = `origin/${worktree.branch.base ?? (await originDefaultBranch(environment, checkout))}`;
    if (worktree.branch.base !== undefined && !(await hasRef(environment, checkout, `refs/remotes/${base}`))) throw new Error(`origin has no branch "${worktree.branch.base}"`);
    ({ branch, path } = await freeName(environment, worktree, worktree.branch.new, root));
    await gitOrThrow(environment, ['-C', checkout, 'worktree', 'add', '--quiet', '--no-track', '-b', branch, path, base], "Couldn't create the worktree");
    created = true;
    // Where the Session's diff starts from, whatever `origin/HEAD` says later; local config only.
    await git(environment, ['-C', checkout, 'config', '--local', `branch.${branch}.loomBase`, base]).catch(() => {});
  } else {
    const { name, remote } = worktree.branch.existing;
    branch = name;
    if (remote) await fetchOrigin(environment, checkout);
    const local = await hasRef(environment, checkout, `refs/heads/${name}`);
    if (!local && !(remote && (await hasRef(environment, checkout, `refs/remotes/origin/${name}`)))) {
      throw new Error(remote ? `origin has no branch "${name}"` : `There's no local branch "${name}"`);
    }
    path = await freeFolder(environment, worktree, name, root);
    const add = local ? [path, name] : ['--track', '-b', name, path, `origin/${name}`];
    await gitOrThrow(environment, ['-C', checkout, 'worktree', 'add', '--quiet', ...add], "Couldn't create the worktree");
    created = !local;
  }
  try {
    await copyIncluded(environment, checkout, path);
  } catch (error) {
    // Undone so it can be tried again; nothing has happened in it yet.
    await git(environment, ['-C', checkout, 'worktree', 'remove', '--force', path]).catch(() => {});
    if (created) await git(environment, ['-C', checkout, 'branch', '-D', branch]).catch(() => {});
    throw error;
  }
  return { path, branch };
}

/**
 * Fetches `origin`, then lists its branches, and the branches git can still
 * check out: local ones not checked out in the checkout or any of its
 * worktrees, and `origin`'s whose local namesake isn't either.
 */
export async function listBranches(environment: GitRunner, checkout: string): Promise<Branches> {
  await fetchOrigin(environment, checkout);
  const defaultBranch = await originDefaultBranch(environment, checkout);
  const { local, remote } = await branchesOf(environment, checkout);
  const busy = await checkedOut(environment, checkout);
  const free = (name: string) => !busy.has(name);
  return {
    defaultBranch,
    remote,
    existing: [...local.filter(free).map((name) => ({ name, remote: false })), ...remote.filter(free).map((name) => ({ name, remote: true }))],
  };
}

/** The checkout's local branches and its `origin` ones (without `origin/`, `HEAD` left out), each sorted. */
async function branchesOf(environment: GitRunner, checkout: string): Promise<{ local: string[]; remote: string[] }> {
  const refs = await gitOrThrow(environment, ['-C', checkout, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], "Couldn't list the branches");
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of refs.stdout.split('\n').filter(Boolean)) {
    if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
    else if (ref !== 'refs/remotes/origin/HEAD') remote.push(ref.slice('refs/remotes/origin/'.length));
  }
  return { local: local.sort(), remote: remote.sort() };
}

/** The local branches checked out in the checkout or any of its worktrees. */
async function checkedOut(environment: GitRunner, checkout: string): Promise<Set<string>> {
  const list = await gitOrThrow(environment, ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], "Couldn't list the worktrees");
  return new Set(
    list.stdout
      .split('\0')
      .filter((line) => line.startsWith('branch refs/heads/'))
      .map((line) => line.slice('branch refs/heads/'.length)),
  );
}

/** Whether the worktree's folder is still there. */
export async function worktreeExists(environment: GitEnvironment, path: string): Promise<boolean> {
  return pathExists(environment, path);
}

/**
 * What removing the worktree would lose or leave only on its local branch:
 * uncommitted changes and commits on no remote branch. Undefined if none. On a
 * detached HEAD those commits are on no branch at all, and would be lost.
 */
export async function unsavedWork(environment: GitEnvironment, path: string): Promise<UnsavedWork | undefined> {
  const status = await gitOrThrow(environment, ['-C', path, 'status', '--porcelain'], "Couldn't check the worktree for changes");
  const unpushed = await gitOrThrow(environment, ['-C', path, 'rev-list', '--count', 'HEAD', '--not', '--remotes'], "Couldn't check the worktree for unpushed commits");
  const branch = await git(environment, ['-C', path, 'symbolic-ref', '--quiet', 'HEAD']);
  const work = { uncommitted: status.stdout.trim() !== '', unpushedCommits: Number(unpushed.stdout.trim()) || 0, detached: branch.exitCode !== 0 };
  return work.uncommitted || work.unpushedCommits > 0 ? work : undefined;
}

/**
 * Removes the worktree from the checkout, keeping its branch; `force` discards
 * its changes. A worktree already gone is only forgotten. The remote is never
 * touched.
 */
export async function removeWorktree(environment: GitEnvironment, { checkout, path, force }: { checkout: string; path: string; force: boolean }): Promise<void> {
  if (!(await worktreeExists(environment, path))) {
    await gitOrThrow(environment, ['-C', checkout, 'worktree', 'prune'], "Couldn't forget the missing worktree");
    return;
  }
  await gitOrThrow(environment, ['-C', checkout, 'worktree', 'remove', ...(force ? ['--force'] : []), path], "Couldn't remove the worktree");
}

/** Fetches `origin` into the checkout. */
async function fetchOrigin(environment: GitRunner, checkout: string): Promise<void> {
  await gitOrThrow(environment, ['-C', checkout, 'fetch', '--quiet', 'origin'], "Couldn't fetch origin", FETCH_TIMEOUT_MS);
}

/** The root with a leading `~` replaced by the Environment's home. */
function expandRoot(environment: GitEnvironment, root: string): string {
  const checked = checkWorktreeRoot(root).replace(/[/\\]+$/, '');
  if (!checked.startsWith('~')) return checked;
  const home = environment.home();
  if (!home) throw new Error(`Loom doesn't know your home folder in ${environment.label}, so can't place worktrees under ~`);
  return `${home.replace(/[/\\]+$/, '')}${checked.slice(1).replaceAll('\\', '/')}`;
}

async function checkBranchName(environment: GitEnvironment, branch: string): Promise<void> {
  const result = await git(environment, ['check-ref-format', '--branch', branch]);
  if (result.exitCode !== 0 || branch.startsWith('-')) throw new Error(`"${branch}" can't be a branch name`);
}

/** `origin`'s default branch, as `origin` itself says. */
async function originDefaultBranch(environment: GitRunner, checkout: string): Promise<string> {
  const result = await gitOrThrow(environment, ['-C', checkout, 'ls-remote', '--symref', 'origin', 'HEAD'], "Couldn't find origin's default branch");
  const head = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(result.stdout);
  if (!head) throw new Error("Couldn't find origin's default branch: origin has no HEAD");
  return head[1]!;
}

/**
 * The first of `branch`, `branch-2`, `branch-3`, … that is neither a local nor
 * an `origin` branch (nor clashes with one as a folder of refs), and whose
 * worktree folder is free.
 */
async function freeName(environment: GitEnvironment, worktree: NewWorktree, wanted: string, root: string): Promise<{ branch: string; path: string }> {
  const { local, remote } = await branchesOf(environment, worktree.checkout);
  const branches = [...local, ...remote];
  const clashes = (name: string) => branches.some((b) => b === name || b.startsWith(`${name}/`) || name.startsWith(`${b}/`));
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const branch = n === 1 ? wanted : `${wanted}-${n}`;
    if (clashes(branch)) continue;
    const path = folderOf(worktree, branch, root);
    if (!(await pathExists(environment, path))) return { branch, path };
  }
  throw new Error(`"${wanted}" and its next ${MAX_SUFFIX - 1} variants are all taken`);
}

/** The first of the branch's worktree folder, then that with `-2`, `-3`, …, that is free. */
async function freeFolder(environment: GitEnvironment, worktree: NewWorktree, branch: string, root: string): Promise<string> {
  const folder = folderOf(worktree, branch, root);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const path = n === 1 ? folder : `${folder}-${n}`;
    if (!(await pathExists(environment, path))) return path;
  }
  throw new Error(`The folder for "${branch}" and its next ${MAX_SUFFIX - 1} variants are all taken`);
}

/** `<root>/<project>/<branch without the prefix, / as ->`. */
function folderOf(worktree: NewWorktree, branch: string, root: string): string {
  const prefix = `${worktree.branchPrefix}/`;
  const folder = (branch.startsWith(prefix) ? branch.slice(prefix.length) : branch).replaceAll('/', '-');
  return `${root}/${worktree.projectName}/${folder}`;
}

/** Whether anything is at `path` in the Environment. */
async function pathExists(environment: GitEnvironment, path: string): Promise<boolean> {
  const { exists } = await environment.request<{ exists: boolean }>('files.exists', GIT_TIMEOUT_MS, { path });
  return exists;
}

/** Whether `ref` names a commit in the checkout. */
async function hasRef(environment: GitEnvironment, checkout: string, ref: string): Promise<boolean> {
  return (await git(environment, ['-C', checkout, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).exitCode === 0;
}

/**
 * Copies into the worktree every file in the checkout that a `.worktreeinclude`
 * (gitignore syntax, in any folder) matches and git ignores.
 */
async function copyIncluded(environment: GitEnvironment, checkout: string, worktree: string): Promise<void> {
  const listed = await gitOrThrow(
    environment,
    ['-C', checkout, 'ls-files', '-z', '--others', '--ignored', '--exclude-per-directory=.worktreeinclude'],
    "Couldn't list the files .worktreeinclude asks for",
  );
  const matching = listed.stdout.split('\0').filter(Boolean);
  const ignored: string[] = [];
  for (let i = 0; i < matching.length; i += IGNORED_BATCH) {
    const batch = matching.slice(i, i + IGNORED_BATCH);
    const result = await gitOrThrow(
      environment,
      ['--literal-pathspecs', '-C', checkout, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...batch],
      "Couldn't tell which files git ignores",
    );
    ignored.push(...result.stdout.split('\0').filter(Boolean));
  }
  if (ignored.length) await environment.request('files.copy', FILES_TIMEOUT_MS, { from: checkout, to: worktree, paths: ignored });
}

async function git(environment: GitRunner, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<ExecResult> {
  try {
    return await exec(environment.request, 'git', args, timeoutMs);
  } catch (error) {
    if (isNotFound(error)) throw new Error(`git isn't installed in ${environment.label}, or isn't on your shell's PATH`);
    throw error;
  }
}

/** Runs git, rejecting with `what` and git's message if it fails. */
async function gitOrThrow(environment: GitRunner, args: string[], what: string, timeoutMs?: number): Promise<ExecResult> {
  const result = await git(environment, args, timeoutMs);
  if (result.exitCode !== 0) throw new Error(`${what}: ${message(result)}`);
  return result;
}

function message(result: ExecResult): string {
  return (result.stderr || result.stdout).trim() || `git exited with code ${result.exitCode}`;
}
