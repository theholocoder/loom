// The Diff service: what a Session's branch changed, against the merge-base of
// its HEAD and its start base, `origin/<default branch>` as the local ref has
// it. Runs git in the Session's Environment through its bridge (ADR 0008) and
// never fetches.
import { exec, type ExecResult } from '../environments/exec';
import { GIT_TIMEOUT_MS } from '../projects/forge';
import type { DiffFile, DiffStat, DiffSummary, FileDiff } from '../../shared/api';
import type { GitEnvironment } from './working-copies';

/** A file's diff text is cut short past this many characters. */
export const MAX_FILE_DIFF_CHARS = 512 * 1024;
/** A file with more changed lines than this has its text left out, so it isn't read whole. */
const MAX_FILE_DIFF_LINES = 20_000;
/** Untracked files beyond this many count as files but not lines. */
const MAX_UNTRACKED_COUNTED = 200;

/** What git compares in a working copy: the working tree against `from`, or `from` against `to`. */
export interface DiffTarget {
  /** The repository git runs in. */
  repo: string;
  /** The branch an archived worktree Session left, compared without a working tree. */
  branch?: string;
}

const BASE_FLAGS = ['--no-color', '--no-ext-diff'];

/** The Diff service for one working copy (or one archived branch) in an Environment. */
export class WorkingCopyDiff {
  constructor(
    private readonly environment: GitEnvironment,
    private readonly target: DiffTarget,
  ) {}

  /** Lists the changed files; `uncommittedOnly` compares the working tree with HEAD instead. */
  async summary(uncommittedOnly = false): Promise<DiffSummary> {
    const base = await this.base();
    const from = uncommittedOnly && !this.target.branch ? 'HEAD' : await this.mergeBase(base);
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
    return { available: true, readOnly: !!this.target.branch, base, files };
  }

  /** The rail badge: `git diff --shortstat` against the merge-base, plus untracked files as additions. */
  async stat(): Promise<DiffStat> {
    const from = await this.mergeBase(await this.base());
    const result = await this.gitOrThrow(['diff', '--shortstat', ...BASE_FLAGS, ...this.range(from)]);
    const stat = parseShortstat(result.stdout);
    if (this.target.branch) return stat;
    for (const file of await this.untracked()) {
      stat.files += 1;
      stat.added += file.added;
    }
    return stat;
  }

  /** One file's unified diff, cut short past MAX_FILE_DIFF_CHARS; none for one too big to read. */
  async file(file: DiffFile, uncommittedOnly = false): Promise<FileDiff> {
    if (file.binary) return { text: '', truncated: false };
    if (file.added + file.removed > MAX_FILE_DIFF_LINES) return { text: '', truncated: true };
    let result: ExecResult;
    if (file.status === 'untracked' && !this.target.branch) {
      result = await this.git(['diff', '--no-index', ...BASE_FLAGS, '--', '/dev/null', file.path]);
    } else {
      const from = uncommittedOnly && !this.target.branch ? 'HEAD' : await this.mergeBase(await this.base());
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      result = await this.git(['diff', '-M', ...BASE_FLAGS, ...this.range(from), '--', ...paths]);
    }
    // `--no-index` exits 1 when the files differ.
    if (result.exitCode > 1) throw new Error(`Couldn't read the diff of ${file.path}: ${message(result)}`);
    const text = result.stdout;
    return text.length > MAX_FILE_DIFF_CHARS ? { text: text.slice(0, MAX_FILE_DIFF_CHARS), truncated: true } : { text, truncated: false };
  }

  /** The start base: `origin/HEAD`'s branch as the local ref names it, else `origin/main` or `origin/master`. */
  private async base(): Promise<string> {
    const head = await this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const candidates = head.exitCode === 0 ? [head.stdout.trim()] : ['origin/main', 'origin/master'];
    for (const ref of candidates) {
      const found = await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`]);
      if (found.exitCode === 0) return ref;
    }
    throw new Error(`There's no local ${candidates.join(' or ')} to compare with; fetch origin to see this diff.`);
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
    const files: DiffFile[] = [];
    for (const [index, path] of paths.entries()) {
      const file: DiffFile = { path, status: 'untracked', added: 0, removed: 0, binary: false };
      if (index < MAX_UNTRACKED_COUNTED) {
        const result = await this.git(['diff', '--no-index', '--numstat', '-z', ...BASE_FLAGS, '--', '/dev/null', path]);
        const [counted] = parseNumstat(result.stdout);
        if (counted) Object.assign(file, { added: counted.added, binary: counted.binary });
      }
      files.push(file);
    }
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
