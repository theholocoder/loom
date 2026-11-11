// The Diff service: what a Session's branch changed, against the merge-base of
// its HEAD and its start base, an `origin/…` branch as the local ref has it:
// recorded, else the one the branch was created from, else origin's default. Runs git in the Session's Environment through its bridge (ADR 0008) and
// never fetches.
import { exec, type ExecResult } from '../environments/exec';
import { GIT_TIMEOUT_MS } from '../projects/forge';
import type { DiffBaseSource, DiffFile, DiffStat, DiffSummary, FileDiff } from '../../shared/api';
import type { GitEnvironment } from './working-copies';

/** A file's diff text is cut short past this many characters. */
export const MAX_FILE_DIFF_CHARS = 512 * 1024;
/** A file with more changed lines than this has its text left out, so it isn't read whole. */
const MAX_FILE_DIFF_LINES = 20_000;
/** Untracked files beyond this many count as files but not lines (each costs a git process, which is slow on Windows/WSL). */
const MAX_UNTRACKED_COUNTED = 50;

/** What git compares in a working copy: the working tree against `from`, or `from` against `to`. */
export interface DiffTarget {
  /** The repository git runs in. */
  repo: string;
  /** The branch an archived worktree Session left, compared without a working tree. */
  branch?: string;
}

const BASE_FLAGS = ['--no-color', '--no-ext-diff'];
/** Files past 1 MB are binary to git, so it doesn't read them whole. */
const BIG_FILE = ['-c', 'core.bigFileThreshold=1m'];
/** How many untracked files are counted at once. */
const UNTRACKED_CONCURRENCY = 8;

/** The Diff service for one working copy (or one archived branch) in an Environment. */
export class WorkingCopyDiff {
  constructor(
    private readonly environment: GitEnvironment,
    private readonly target: DiffTarget,
    private readonly maxUntrackedCounted = MAX_UNTRACKED_COUNTED,
  ) {}

  /** Lists the changed files; `uncommittedOnly` compares the working tree with HEAD instead. */
  async summary(uncommittedOnly = false): Promise<DiffSummary> {
    const head = uncommittedOnly && !this.target.branch;
    // The start base is only resolved when something is compared with it.
    const base = head ? undefined : await this.base();
    const from = base ? await this.mergeBase(base.ref) : 'HEAD';
    const range = this.range(from);
    const listed = parseNumstat((await this.gitOrThrow(['diff', '--numstat', '-z', '-M', ...BASE_FLAGS, ...range])).stdout);
    const files: DiffFile[] = [];
    if (this.target.branch) {
      for (const file of listed) files.push({ ...file, status: 'committed' });
    } else {
      const uncommitted = uncommittedOnly
        ? undefined
        : new Set(splitZ((await this.gitOrThrow(['diff', '--name-only', '-z', ...BASE_FLAGS, 'HEAD'])).stdout));
      for (const file of listed) files.push({ ...file, status: !uncommitted || uncommitted.has(file.path) ? 'modified' : 'committed' });
      files.push(...(await this.untracked()));
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { available: true, readOnly: !!this.target.branch, ...(base ? { base: base.ref, baseSource: base.source } : { base: 'HEAD' }), files };
  }

  /** The Glance strip's diff stat, from a summary of the whole diff. */
  static stat(files: DiffFile[]): DiffStat {
    return { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
  }

  /** One file's unified diff, cut short past MAX_FILE_DIFF_CHARS; none for one too big to read. */
  async file(file: DiffFile, uncommittedOnly = false): Promise<FileDiff> {
    if (file.binary) return { text: '', truncated: false };
    if (file.uncounted) return { text: '', truncated: true };
    if (file.added + file.removed > MAX_FILE_DIFF_LINES) return { text: '', truncated: true };
    let result: ExecResult;
    if (file.status === 'untracked' && !this.target.branch) {
      result = await this.git([...BIG_FILE, 'diff', '--no-index', ...BASE_FLAGS, '--', '/dev/null', file.path]);
    } else {
      const from = uncommittedOnly && !this.target.branch ? 'HEAD' : await this.mergeBase((await this.base()).ref);
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      result = await this.git(['--literal-pathspecs', 'diff', '-M', ...BASE_FLAGS, ...this.range(from), '--', ...paths]);
    }
    // `--no-index` exits 1 when the files differ.
    if (result.exitCode > 1) throw new Error(`Couldn't read the diff of ${file.path}: ${message(result)}`);
    const text = result.stdout;
    return text.length > MAX_FILE_DIFF_CHARS ? { text: text.slice(0, MAX_FILE_DIFF_CHARS), truncated: true } : { text, truncated: false };
  }

  /**
   * The `origin/…` branches a diff can be against, as the local refs have
   * them, by name; `origin/HEAD` left out.
   */
  async bases(): Promise<string[]> {
    const refs = await this.gitOrThrow(['for-each-ref', '--format=%(refname:strip=2)', 'refs/remotes/origin']);
    return refs.stdout.split('\n').filter((ref) => ref && ref !== 'origin/HEAD').sort();
  }

  /**
   * Records `base`, an `origin/…` branch the local refs have, as the start
   * base of the working copy's branch, in the repository's local config.
   */
  async setBase(base: string): Promise<void> {
    if (!base.startsWith('origin/') || !(await this.hasRemoteRef(base)) || base === 'origin/HEAD') {
      throw new Error(`${base} isn't one of origin's branches here; fetch origin if it is new.`);
    }
    const branch = await this.branch();
    if (!branch) throw new Error("This Session's working copy isn't on a branch, so its diff has no base to keep.");
    await this.gitOrThrow(['config', '--local', `branch.${branch}.loomBase`, base]);
  }

  /**
   * The start base, and where it came from: the one recorded for the branch
   * (by `createWorktree` or setBase), else the `origin` branch its reflog
   * says it was created from, else `origin/HEAD`'s branch as the local ref
   * names it, else `origin/main` or `origin/master`.
   */
  private async base(): Promise<{ ref: string; source: DiffBaseSource }> {
    const branch = await this.branch();
    const recorded = branch ? await this.git(['config', '--get', `branch.${branch}.loomBase`]) : undefined;
    const head = await this.originHead();
    const candidates: Array<{ ref: string; source: DiffBaseSource }> = [
      ...(recorded?.exitCode === 0 && recorded.stdout.trim() ? [{ ref: recorded.stdout.trim(), source: 'recorded' as const }] : []),
      ...(branch ? (await this.createdFrom(branch, head)).map((ref) => ({ ref, source: 'created-from' as const })) : []),
      ...[head, 'origin/main', 'origin/master'].flatMap((ref) => (ref ? [{ ref, source: 'default' as const }] : [])),
    ];
    for (const candidate of candidates) {
      if (await this.hasRemoteRef(candidate.ref)) return candidate;
    }
    throw new Error("There's no local origin/main or origin/master to compare with; fetch origin to see this diff.");
  }

  /** The branch compared: the archived one, else the working copy's; undefined on a detached HEAD. */
  private async branch(): Promise<string | undefined> {
    return this.target.branch ?? ((await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || undefined);
  }

  /** `origin/HEAD`'s branch as the local ref names it, e.g. `origin/main`. */
  private async originHead(): Promise<string | undefined> {
    const head = await this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    return head.exitCode === 0 ? head.stdout.trim() : undefined;
  }

  /**
   * The `origin` branch the branch's reflog says it was created from (`git
   * branch`, `switch -c`, `worktree add -b` all note it), while that entry
   * lasts: `origin/HEAD` as its branch, a local branch as its `origin`
   * namesake. None when it was created from HEAD or a commit, or from its
   * own `origin` branch, which it tracks rather than started from.
   */
  private async createdFrom(branch: string, originHead: string | undefined): Promise<string[]> {
    const reflog = await this.git(['reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--']);
    if (reflog.exitCode !== 0) return [];
    const first = reflog.stdout.trim().split('\n').at(-1) ?? '';
    const from = /^branch: Created from (.+)$/.exec(first)?.[1]?.replace(/^refs\/(remotes\/|heads\/)?/, '');
    if (!from || from === 'HEAD') return [];
    const base = from === 'origin/HEAD' ? originHead : from.startsWith('origin/') ? from : `origin/${from}`;
    return base && base !== `origin/${branch}` ? [base] : [];
  }

  private async hasRemoteRef(ref: string): Promise<boolean> {
    return (await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`])).exitCode === 0;
  }

  private async mergeBase(base: string): Promise<string> {
    const result = await this.git(['merge-base', this.target.branch ?? 'HEAD', base]);
    if (result.exitCode !== 0) throw new Error(`This branch has no commit in common with ${base}.`);
    return result.stdout.trim();
  }

  /** What `git diff` compares: the working tree with `from`, or `from` with the archived branch. */
  private range(from: string): string[] {
    return this.target.branch ? [from, `refs/heads/${this.target.branch}`] : [from];
  }

  /** Untracked files git doesn't ignore, as additions. */
  private async untracked(): Promise<DiffFile[]> {
    const paths = splitZ((await this.gitOrThrow(['ls-files', '-z', '--others', '--exclude-standard'])).stdout);
    const files: DiffFile[] = paths.map((path, index) => ({ path, status: 'untracked', added: 0, removed: 0, binary: false, ...(index < this.maxUntrackedCounted ? {} : { uncounted: true }) }));
    const counted = files.filter((f) => !f.uncounted);
    let next = 0;
    const worker = async () => {
      while (next < counted.length) {
        const file = counted[next++]!;
        const result = await this.git([...BIG_FILE, 'diff', '--no-index', '--numstat', '-z', ...BASE_FLAGS, '--', '/dev/null', file.path]);
        const [found] = parseNumstat(result.stdout);
        if (found) Object.assign(file, { added: found.added, binary: found.binary });
      }
    };
    await Promise.all(Array.from({ length: Math.min(UNTRACKED_CONCURRENCY, counted.length) }, worker));
    return files;
  }

  private git(args: string[]): Promise<ExecResult> {
    return exec(this.environment.request, 'git', ['-C', this.target.repo, '-c', 'core.quotepath=off', ...args], GIT_TIMEOUT_MS);
  }

  private async gitOrThrow(args: string[]): Promise<ExecResult> {
    const result = await this.git(args);
    if (result.exitCode !== 0) throw new Error(`Couldn't work out the diff: ${message(result)}`);
    return result;
  }
}

function splitZ(text: string): string[] {
  return text.split('\0').filter(Boolean);
}

/** Parses `git diff --numstat -z`: `added\tremoved\tpath\0`, or `added\tremoved\t\0old\0new\0` for a rename. */
export function parseNumstat(text: string): Omit<DiffFile, 'status'>[] {
  const parts = text.split('\0');
  const files: Omit<DiffFile, 'status'>[] = [];
  for (let i = 0; i < parts.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]!.replace(/^\n/, ''));
    if (!match) continue;
    const binary = match[1] === '-';
    const counts = { added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary };
    if (match[3]) {
      // `--no-index` against /dev/null may name the file `/dev/null => path`; only the path matters.
      files.push({ path: match[3].replace(/^.* => /, ''), ...counts });
    } else {
      const oldPath = parts[++i]!;
      const path = parts[++i]!;
      files.push(oldPath === '/dev/null' ? { path, ...counts } : { path, oldPath, ...counts });
    }
  }
  return files;
}

/** Parses `git diff --shortstat`: ` 3 files changed, 10 insertions(+), 2 deletions(-)`. */
export function parseShortstat(text: string): DiffStat {
  const count = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);
  return { files: count(/(\d+) files? changed/), added: count(/(\d+) insertions?\(\+\)/), removed: count(/(\d+) deletions?\(-\)/) };
}

function message(result: ExecResult): string {
  return (result.stderr || result.stdout).trim() || `git exited with code ${result.exitCode}`;
}
