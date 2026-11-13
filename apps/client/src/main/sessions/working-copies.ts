// The Working copy service: making a worktree Session's git worktree, checking
// it for unsaved work, and removing it on archive while keeping its branch.
// Everything runs in the Project's Environment, through its bridge (ADR 0008).
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';
import { describeFailure } from '../environments/failures';
import { GIT_TIMEOUT_MS } from '../projects/forge';
import type { Branches, ExistingBranch, ExistingWorktree, UnsavedWork } from '../../shared/api';
import { checkWorktreeRoot } from '../settings';
import { branchName } from '../../shared/branches';

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

/** Where a Project's new worktrees go: `<root>/<project>/<branch without the prefix>`. */
export interface WorktreePlace {
  projectName: string;
  branchPrefix: string;
  /** The worktree root setting, perhaps starting with `~`. */
  root: string;
}

export interface NewWorktree extends WorktreePlace {
  /** The Project's checkout, which the worktree is added to. */
  checkout: string;
  /**
   * A new branch to create, `-2`, `-3`, … added if it is taken, from `base`
   * (an `origin` branch or a local one, the default base if absent; see
   * defaultBase); or an existing branch to check out as-is.
   */
  branch: { new: string; base?: ExistingBranch } | { existing: ExistingBranch };
  /** Where to make it, for an existing branch, instead of a free folder under the root: a reopened Session's old place. */
  at?: string;
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
 * `origin` is fetched first, if there is one; if it can't be, its branches
 * are as the checkout last fetched them. A new branch is made from its base,
 * not tracking it. An existing local branch is checked out as it is; an
 * existing `origin` branch is checked out on its same-named local branch,
 * which is created to track it if there is none. Neither records a start
 * base: its diff is against `origin/HEAD`, as Loom can't know where it
 * started.
 * Rejects an existing branch checked out in another worktree, naming it;
 * one whose folder was deleted outside git is pruned first, unless locked.
 */
export async function createWorktree(environment: GitEnvironment, worktree: NewWorktree): Promise<{ path: string; branch: string }> {
  const { checkout } = worktree;
  const place = { ...worktree, root: expandRoot(environment, worktree.root) };
  let branch: string;
  let path: string;
  // Whether the branch is Loom's own, to be deleted again if the worktree can't be made.
  let created: boolean;
  if ('new' in worktree.branch) {
    await checkBranchName(environment, worktree.branch.new);
    const fetched = await tryFetchOrigin(environment, checkout);
    const picked = worktree.branch.base ?? (await defaultBase(environment, checkout, fetched));
    if (!picked) throw new Error("There's no branch to start the worktree from: commit on a branch first");
    if (!(await hasRef(environment, checkout, refOf(picked)))) throw missingBranch(picked, fetched);
    const base = branchName(picked);
    ({ branch, path } = await freeName(environment, checkout, place, worktree.branch.new));
    await gitOrThrow(environment, ['-C', checkout, 'worktree', 'add', '--quiet', '--no-track', '-b', branch, path, refOf(picked)], "Couldn't create the worktree");
    created = true;
    // Where the Session's diff starts from, whatever `origin/HEAD` says later, as git names it
    // (`origin/<name>`, or a local branch's name: see the diff's base); local config only.
    await git(environment, ['-C', checkout, 'config', '--local', `branch.${branch}.loomBase`, base]).catch(() => {});
  } else {
    const { name, remote } = worktree.branch.existing;
    branch = name;
    const fetched: Fetched = remote ? await tryFetchOrigin(environment, checkout) : { state: 'none' };
    const local = await hasRef(environment, checkout, refOf({ name, remote: false }));
    if (!local && !(remote && (await hasRef(environment, checkout, refOf({ name, remote: true }))))) throw missingBranch(worktree.branch.existing, fetched);
    let holder = (await worktreesOf(environment, checkout)).find((listed) => listed.branch === name);
    // A worktree deleted outside git still holds its branch until git forgets it.
    if (holder?.gone && !holder.locked) {
      await gitOrThrow(environment, ['-C', checkout, 'worktree', 'prune'], "Couldn't prune the deleted worktrees");
      holder = (await worktreesOf(environment, checkout)).find((listed) => listed.branch === name);
    }
    if (holder) throw new Error(`"${name}" is checked out in ${holder.path}; work there instead`);
    path = worktree.at ?? (await freeFolder(environment, place, name));
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
 * Fetches `origin` if there is one (as the checkout last fetched it if it
 * can't be, saying why), then lists the bases a new branch can start from:
 * its branches, then the local ones, and the default one (see defaultBase);
 * the branches git can still check out in a new worktree: local ones not
 * checked out in the checkout or any of its worktrees, and `origin`'s with no
 * local namesake (which would be reused, so is listed instead); and the
 * worktrees a Session can work in (see workable).
 */
export async function listBranches(environment: GitRunner, checkout: string): Promise<Branches> {
  const fetched = await tryFetchOrigin(environment, checkout);
  const base = await defaultBase(environment, checkout, fetched);
  const { local, remote } = await branchesOf(environment, checkout);
  const all = await worktreesOf(environment, checkout);
  const head = await git(environment, ['-C', checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  const checkoutBranch = head.exitCode === 0 ? head.stdout.trim() : '';
  const busy = new Set(all.flatMap((worktree) => (worktree.branch ? [worktree.branch] : [])));
  const locals = new Set(local);
  return {
    ...(base && { defaultBase: base }),
    bases: [...remote.map((name) => ({ name, remote: true })), ...local.map((name) => ({ name, remote: false }))],
    existing: [
      ...local.filter((name) => !busy.has(name)).map((name) => ({ name, remote: false })),
      ...remote.filter((name) => !locals.has(name)).map((name) => ({ name, remote: true })),
    ],
    worktrees: workable(all, checkout)
      .filter((worktree) => !worktree.locked)
      .map(({ path, branch }) => (branch ? { path, branch } : { path })),
    ...(checkoutBranch && { checkoutBranch }),
    ...(fetched.state === 'failed' && { fetchError: `Couldn't fetch origin: ${fetched.error}` }),
  };
}

/**
 * The worktree at `path` a Session can work in, as it is now. Rejects a
 * folder that isn't one (see workable), and a locked one.
 */
export async function findWorktree(environment: GitRunner, checkout: string, path: string, projectName: string): Promise<ExistingWorktree> {
  const found = workable(await worktreesOf(environment, checkout), checkout).find((worktree) => worktree.path === path);
  if (!found) throw new Error(`${path} isn't a worktree of ${projectName}`);
  if (found.locked) throw new Error(`${path} is locked; unlock it with \`git worktree unlock\` to work in it`);
  return found.branch ? { path, branch: found.branch } : { path };
}

/** A worktree as `git worktree list --porcelain` describes it. */
interface ListedWorktree extends ExistingWorktree {
  /** The main working tree, which git always lists first. */
  main: boolean;
  /** Bare, or its folder is gone: nothing can work in it. */
  unusable: boolean;
  /** Locked: git won't remove it, so archiving its Session would fail. */
  locked: boolean;
  /** Its folder is gone, deleted outside git: `git worktree prune` forgets it, unless it is locked. */
  gone: boolean;
}

/** Every worktree of the checkout, the main one first, as git lists them. */
async function worktreesOf(environment: GitRunner, checkout: string): Promise<ListedWorktree[]> {
  const list = await gitOrThrow(environment, ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], "Couldn't list the worktrees");
  const worktrees: ListedWorktree[] = [];
  // One `worktree <path>` line starts each, its other lines follow.
  for (const line of list.stdout.split('\0')) {
    const current = worktrees.at(-1);
    if (line.startsWith('worktree ')) worktrees.push({ path: line.slice('worktree '.length), main: worktrees.length === 0, unusable: false, locked: false, gone: false });
    else if (!current) continue;
    else if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
    else if (line === 'bare') current.unusable = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) current.unusable = current.gone = true;
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true;
  }
  return worktrees;
}

/**
 * The linked worktrees a Session could work in: neither the main working
 * tree nor the Project's checkout (which may be a linked worktree itself),
 * nor bare or missing ones. Locked ones are kept, flagged.
 */
function workable(worktrees: ListedWorktree[], checkout: string): ListedWorktree[] {
  return worktrees.filter((worktree) => !worktree.main && !worktree.unusable && worktree.path !== checkout);
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
 * Commits everything uncommitted in the worktree, untracked files included,
 * to the branch it is on, as `message`, skipping the hooks: a commit kept so
 * that removing the worktree loses nothing. Nothing to commit commits nothing.
 */
export async function commitWork(environment: GitEnvironment, path: string, message: string): Promise<void> {
  const status = await gitOrThrow(environment, ['-C', path, 'status', '--porcelain'], "Couldn't check the worktree for changes");
  if (status.stdout.trim() === '') return;
  await gitOrThrow(environment, ['-C', path, 'add', '--all'], "Couldn't stage the worktree's changes");
  await gitOrThrow(environment, ['-C', path, 'commit', '--quiet', '--no-verify', '-m', message], "Couldn't commit the worktree's changes");
}

/**
 * Removes the worktree from the checkout, keeping its branch; `force` discards
 * its changes. A worktree already gone is only forgotten. The remote is never
 * touched.
 */
export async function removeWorktree(environment: GitEnvironment, { checkout, path, force }: { checkout: string; path: string; force: boolean }): Promise<void> {
  if (!(await pathExists(environment, path))) {
    await gitOrThrow(environment, ['-C', checkout, 'worktree', 'prune'], "Couldn't forget the missing worktree");
    return;
  }
  await gitOrThrow(environment, ['-C', checkout, 'worktree', 'remove', ...(force ? ['--force'] : []), path], "Couldn't remove the worktree");
}

/** How fetching `origin` went: fetched, failed with git's message saying why, or not tried as there's no `origin`. */
type Fetched = { state: 'fetched' } | { state: 'failed'; error: string } | { state: 'none' };

/** Fetches `origin` into the checkout, if it has one; a failure is reported, not thrown, as the checkout's refs will do. */
async function tryFetchOrigin(environment: GitRunner, checkout: string): Promise<Fetched> {
  if ((await git(environment, ['-C', checkout, 'remote', 'get-url', 'origin'])).exitCode !== 0) return { state: 'none' };
  const result = await git(environment, ['-C', checkout, 'fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
  return result.exitCode === 0 ? { state: 'fetched' } : { state: 'failed', error: describeFailure('git', result) };
}

/** The ref an `origin` or a local branch has in the checkout. */
function refOf(branch: ExistingBranch): string {
  return branch.remote ? `refs/remotes/origin/${branch.name}` : `refs/heads/${branch.name}`;
}

/** The error for a branch the checkout hasn't got, saying why `origin`'s may be out of date. */
function missingBranch({ name, remote }: ExistingBranch, fetched: Fetched): Error {
  if (!remote) return new Error(`There's no local branch "${name}"`);
  return new Error(fetched.state === 'failed' ? `origin has no branch "${name}" here, and couldn't be fetched: ${fetched.error}` : `origin has no branch "${name}"`);
}

/**
 * Rejects, saying why, unless the worktree root is a folder in the
 * Environment, or one that could be made there, so a root no worktree could go
 * under is refused when it is set. Nothing is made.
 */
export async function checkWorktreeRootFolder(environment: GitEnvironment, root: string): Promise<void> {
  const path = expandRoot(environment, root);
  try {
    await environment.request('files.checkFolder', GIT_TIMEOUT_MS, { path });
  } catch (error) {
    throw new Error(`"${root.trim()}" can't be the worktree root: there can't be a folder there in ${environment.label} (${(error as Error).message})`);
  }
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

/**
 * What a new branch starts from unless another base is picked: `origin`'s
 * default branch, as `origin` itself says once fetched, else as the checkout
 * last heard (`origin/HEAD`); else the local default branch: `origin/HEAD`'s
 * namesake, `init.defaultBranch`, `main` or `master`, or the checkout's own
 * branch, the first the checkout has. Undefined with none of them, as in a
 * repository with no commit.
 */
async function defaultBase(environment: GitRunner, checkout: string, fetched: Fetched): Promise<ExistingBranch | undefined> {
  const remote: string[] = [];
  if (fetched.state === 'fetched') {
    const said = await git(environment, ['-C', checkout, 'ls-remote', '--symref', 'origin', 'HEAD'], FETCH_TIMEOUT_MS);
    const head = said.exitCode === 0 ? /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(said.stdout)?.[1] : undefined;
    if (head) remote.push(head);
  }
  const known = await git(environment, ['-C', checkout, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (known.exitCode === 0) remote.push(known.stdout.trim().replace(/^origin\//, ''));
  for (const name of remote) {
    if (await hasRef(environment, checkout, refOf({ name, remote: true }))) return { name, remote: true };
  }
  const configured = (await git(environment, ['-C', checkout, 'config', '--get', 'init.defaultBranch'])).stdout.trim();
  const current = (await git(environment, ['-C', checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  for (const name of new Set([...remote, configured, 'main', 'master', current].filter(Boolean))) {
    if (await hasRef(environment, checkout, refOf({ name, remote: false }))) return { name, remote: false };
  }
  return undefined;
}

/**
 * The first of `branch`, `branch-2`, `branch-3`, … that is neither a local nor
 * an `origin` branch (nor clashes with one as a folder of refs), and whose
 * worktree folder is free.
 */
async function freeName(environment: GitRunner, checkout: string, place: WorktreePlace, wanted: string): Promise<{ branch: string; path: string }> {
  const { local, remote } = await branchesOf(environment, checkout);
  const branches = [...local, ...remote];
  const clashes = (name: string) => branches.some((b) => b === name || b.startsWith(`${name}/`) || name.startsWith(`${b}/`));
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const branch = withSuffix(wanted, n);
    if (clashes(branch)) continue;
    const path = folderOf(place, branch);
    if (!(await pathExists(environment, path))) return { branch, path };
  }
  throw new Error(`"${wanted}" and its next ${MAX_SUFFIX - 1} variants are all taken`);
}

/** The first of the branch's worktree folder, then that with `-2`, `-3`, …, that is free. */
async function freeFolder(environment: GitRunner, place: WorktreePlace, branch: string): Promise<string> {
  const folder = folderOf(place, branch);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const path = withSuffix(folder, n);
    if (!(await pathExists(environment, path))) return path;
  }
  throw new Error(`The folder for "${branch}" and its next ${MAX_SUFFIX - 1} variants are all taken`);
}

/** `name`, then `name-2`, `name-3`, … for n = 1, 2, 3, … */
function withSuffix(name: string, n: number): string {
  return n === 1 ? name : `${name}-${n}`;
}

/** `<root>/<project>/<branch without the prefix, / as ->`. */
function folderOf({ root, projectName, branchPrefix }: WorktreePlace, branch: string): string {
  const prefix = `${branchPrefix}/`;
  const folder = (branch.startsWith(prefix) ? branch.slice(prefix.length) : branch).replaceAll('/', '-');
  return `${root}/${projectName}/${folder}`;
}

/** Whether anything is at `path` in the Environment, such as a worktree's folder. */
export async function pathExists(environment: GitRunner, path: string): Promise<boolean> {
  const { exists } = await environment.request<{ exists: boolean }>('files.exists', GIT_TIMEOUT_MS, { path });
  return exists;
}

/** Whether `ref` names a commit in the checkout. */
async function hasRef(environment: GitRunner, checkout: string, ref: string): Promise<boolean> {
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
  if (result.exitCode !== 0) throw new Error(`${what}: ${describeFailure('git', result)}`);
  return result;
}

/** What the bridge keeps of a command's stdout (`maxOutput` in bridge/protocol/exec.go), past which the listing is cut short. */
const BRIDGE_MAX_OUTPUT = 1 << 20;

/**
 * The files in the working copy at `path`, for @-mentions: tracked ones and
 * untracked ones git doesn't ignore, relative to it with `/`, by path, at
 * most `limit`. With `ref`, the files git has at that commit instead.
 */
export async function listFiles(environment: GitRunner, path: string, limit: number, ref?: string): Promise<string[]> {
  const args = ref === undefined ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard'] : ['ls-tree', '-r', '-z', '--name-only', '--end-of-options', ref];
  const result = await gitOrThrow(environment, ['-C', path, ...args], "Couldn't list the working copy's files");
  const listed = result.stdout.split('\0');
  // Cut short by the bridge, the last path may be part of one; and the list ends with an empty one anyway.
  listed.pop();
  if (Buffer.byteLength(result.stdout) >= BRIDGE_MAX_OUTPUT) listed.pop();
  return [...new Set(listed.filter(Boolean))].sort().slice(0, limit);
}
