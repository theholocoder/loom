// The Working copy service: making a worktree Session's git worktree, and
// reading which branch a working copy has checked out. Everything runs in the
// Project's Environment, through its bridge (ADR 0008).
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';
import { GIT_TIMEOUT_MS } from '../projects/forge';
import { checkWorktreeRoot } from '../settings';

/** What the Working copy service needs from an Environment. */
export interface GitEnvironment {
  label: string;
  request: BridgeCall;
  /** The user's home there, once the bridge has said. */
  home(): string | undefined;
}

export interface NewWorktree {
  /** The Project's checkout, which the worktree is added to. */
  checkout: string;
  projectName: string;
  branchPrefix: string;
  /** The branch to create; `-2`, `-3`, … is added if it is taken. */
  branch: string;
  /** The worktree root setting, perhaps starting with `~`. */
  root: string;
}

const FETCH_TIMEOUT_MS = 120_000;
const FILES_TIMEOUT_MS = 60_000;
/** How many paths one `git ls-files` is given, to stay under command-line limits. */
const IGNORED_BATCH = 500;
const MAX_SUFFIX = 100;

/**
 * Fetches `origin`, then adds a worktree on a new branch from
 * `origin/<default branch>`, under `<root>/<project>/<branch slug>`, and copies
 * in the files `.worktreeinclude` asks for. Resolves with where it is and its
 * branch. The checkout's own branch and changes play no part.
 */
export async function createWorktree(environment: GitEnvironment, worktree: NewWorktree): Promise<{ path: string; branch: string }> {
  const { checkout } = worktree;
  const root = expandRoot(environment, worktree.root);
  await checkBranchName(environment, worktree.branch);
  await gitOrThrow(environment, ['-C', checkout, 'fetch', '--quiet', 'origin'], "Couldn't fetch origin", FETCH_TIMEOUT_MS);
  const base = `origin/${await defaultBranch(environment, checkout)}`;
  const { branch, path } = await freeName(environment, worktree, root);
  await gitOrThrow(environment, ['-C', checkout, 'worktree', 'add', '--quiet', '--no-track', '-b', branch, path, base], "Couldn't create the worktree");
  try {
    await copyIncluded(environment, checkout, path);
  } catch (error) {
    // Undone so the name is free to try again; nothing has happened in it yet.
    await git(environment, ['-C', checkout, 'worktree', 'remove', '--force', path]).catch(() => {});
    await git(environment, ['-C', checkout, 'branch', '-D', branch]).catch(() => {});
    throw error;
  }
  return { path, branch };
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
async function defaultBranch(environment: GitEnvironment, checkout: string): Promise<string> {
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
async function freeName(environment: GitEnvironment, worktree: NewWorktree, root: string): Promise<{ branch: string; path: string }> {
  const refs = await gitOrThrow(
    environment,
    ['-C', worktree.checkout, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'],
    "Couldn't list the branches",
  );
  const branches = refs.stdout
    .split('\n')
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/(heads|remotes\/origin)\//, ''));
  const clashes = (name: string) => branches.some((b) => b === name || b.startsWith(`${name}/`) || name.startsWith(`${b}/`));
  const prefix = `${worktree.branchPrefix}/`;
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const branch = n === 1 ? worktree.branch : `${worktree.branch}-${n}`;
    if (clashes(branch)) continue;
    const folder = (branch.startsWith(prefix) ? branch.slice(prefix.length) : branch).replaceAll('/', '-');
    const path = `${root}/${worktree.projectName}/${folder}`;
    const { exists } = await environment.request<{ exists: boolean }>('files.exists', GIT_TIMEOUT_MS, { path });
    if (!exists) return { branch, path };
  }
  throw new Error(`"${worktree.branch}" and its next ${MAX_SUFFIX - 1} variants are all taken`);
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

async function git(environment: GitEnvironment, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<ExecResult> {
  try {
    return await exec(environment.request, 'git', args, timeoutMs);
  } catch (error) {
    if (isNotFound(error)) throw new Error(`git isn't installed in ${environment.label}, or isn't on your shell's PATH`);
    throw error;
  }
}

/** Runs git, rejecting with `what` and git's message if it fails. */
async function gitOrThrow(environment: GitEnvironment, args: string[], what: string, timeoutMs?: number): Promise<ExecResult> {
  const result = await git(environment, args, timeoutMs);
  if (result.exitCode !== 0) throw new Error(`${what}: ${message(result)}`);
  return result;
}

function message(result: ExecResult): string {
  return (result.stderr || result.stdout).trim() || `git exited with code ${result.exitCode}`;
}
