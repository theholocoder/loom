// The Diff service: what a Session's branch changed, against the merge-base of
// its HEAD and its start base, an `origin/…` branch as the local ref has it:
// recorded, else the one the branch was created from, else origin's default. Runs git in the Session's Environment through its bridge (ADR 0008) and
// never fetches.
import { createHash } from 'node:crypto';
import { exec, type ExecResult } from '../environments/exec';
import { describeFailure } from '../environments/failures';
import { GIT_TIMEOUT_MS } from '../projects/forge';
import type { DiffBaseSource, DiffCounts, DiffFile, DiffFileChange, DiffScope, DiffStat, DiffSummary, FileDiff } from '../../shared/api';
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

/** Whatever the user's git config says (diff.mnemonicPrefix, diff.noprefix), a diff's paths start `a/` and `b/`, as its parser expects. */
const BASE_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
/** At most this many changed files have their size and time read for a fingerprint. */
const MAX_FINGERPRINT_STATS = 2_000;
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

  /**
   * Lists the changed files of `scope`. An archived branch has only its
   * commits, whatever the scope. Throws when a scope with a start base has
   * none to compare with; `uncommitted` never needs one.
   */
  async summary(scope: DiffScope = 'all'): Promise<DiffSummary> {
    const archived = !!this.target.branch;
    const uncommitted = scope === 'uncommitted' && !archived;
    // The start base is only resolved when something is compared with it.
    const base = uncommitted ? undefined : await this.base();
    const from = base ? await this.mergeBase(base.ref) : 'HEAD';
    const listed = parseRawNumstat((await this.gitOrThrow(['diff', '--raw', '--numstat', '-z', '-M', ...BASE_FLAGS, ...this.range(from, scope)])).stdout);
    const files: DiffFile[] = [];
    if (archived || scope === 'committed') {
      for (const file of listed) files.push({ ...file, status: 'committed' });
    } else {
      const changed = uncommitted ? undefined : new Set(await this.uncommittedPaths());
      for (const file of listed) files.push({ ...file, status: !changed || changed.has(file.path) ? 'modified' : 'committed' });
      files.push(...(await this.untracked()));
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { available: true, readOnly: archived, ...(base ? { base: base.ref, baseSource: base.source } : { base: 'HEAD' }), files };
  }

  /**
   * How many files each scope of a working copy holds, from file names
   * alone: none for the scopes with a start base when there is none to
   * compare with.
   */
  async counts(): Promise<DiffCounts> {
    const untracked = await this.untrackedPaths();
    const counts: DiffCounts = { uncommitted: (await this.uncommittedPaths()).length + untracked.length };
    const base = await this.base().catch(() => undefined);
    if (!base) return counts;
    const from = await this.mergeBase(base.ref);
    const names = async (range: string[]) => splitZ((await this.gitOrThrow(['diff', '--name-only', '-z', '-M', ...BASE_FLAGS, ...range])).stdout).length;
    return { ...counts, all: (await names([from])) + untracked.length, committed: await names([from, 'HEAD']) };
  }

  /**
   * What the working copy holds now, hashed: its HEAD and `git status`, and
   * the size and modification time of each file that lists (so a second
   * edit to a file already changed shows too). Takes no lock, so it never
   * gets in the agent's way.
   */
  async fingerprint(): Promise<string> {
    const hash = createHash('sha1');
    if (this.target.branch) {
      hash.update((await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${this.target.branch}`])).stdout);
      return hash.digest('hex');
    }
    const status = await this.git(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
    hash.update(`${status.exitCode}\0${status.stdout}`);
    // Its paths are from the repository's top level, which a working copy always is.
    const paths = statusPaths(status.stdout).slice(0, MAX_FINGERPRINT_STATS);
    if (paths.length > 0) {
      // A bridge older than files.stat has the status alone to go on.
      const stats = await this.environment.request<{ files: unknown[] }>('files.stat', GIT_TIMEOUT_MS, { root: this.target.repo, paths }).catch(() => undefined);
      if (stats) hash.update(JSON.stringify(stats.files));
    }
    return hash.digest('hex');
  }

  /** The Glance strip's diff stat, from a summary of the whole diff. */
  static stat(files: DiffFile[]): DiffStat {
    return { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
  }

  /** One file's unified diff in `scope`, cut short past MAX_FILE_DIFF_CHARS; none for one too big to read. */
  async file(file: DiffFile, scope: DiffScope = 'all'): Promise<FileDiff> {
    if (file.binary) return { text: '', truncated: false };
    if (file.uncounted) return { text: '', truncated: true };
    if (file.added + file.removed > MAX_FILE_DIFF_LINES) return { text: '', truncated: true };
    const archived = !!this.target.branch;
    let result: ExecResult;
    if (file.status === 'untracked' && !archived) {
      result = await this.git([...BIG_FILE, 'diff', '--no-index', ...BASE_FLAGS, '--', '/dev/null', file.path]);
    } else {
      const from = scope === 'uncommitted' && !archived ? 'HEAD' : await this.mergeBase((await this.base()).ref);
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      result = await this.git(['--literal-pathspecs', 'diff', '-M', ...BASE_FLAGS, ...this.range(from, scope), '--', ...paths]);
    }
    // `--no-index` exits 1 when the files differ.
    if (result.exitCode > 1) throw new Error(`Couldn't read the diff of ${file.path}: ${describeFailure('git', result)}`);
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
   * names it, else `origin/main` or `origin/master`; and with none of those
   * here (no `origin`, or never fetched), the local default branch.
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
      // A recorded base may be a local branch: one Loom made the branch from.
      if ((await this.hasRemoteRef(candidate.ref)) || (candidate.source === 'recorded' && (await this.hasLocalBranch(candidate.ref)))) return candidate;
    }
    const local = await this.localDefault(head);
    if (local) return { ref: local, source: 'local' };
    throw new Error("There's no origin/main or origin/master here, nor a local main or master, to compare with: fetch origin to see this diff. Uncommitted shows what changed since the last commit.");
  }

  /**
   * The local default branch: `origin/HEAD`'s namesake, else
   * `init.defaultBranch`, else `main` or `master`, the first one the
   * repository has.
   */
  private async localDefault(originHead: string | undefined): Promise<string | undefined> {
    const configured = (await this.git(['config', '--get', 'init.defaultBranch'])).stdout.trim();
    const names = [originHead?.replace(/^origin\//, ''), configured, 'main', 'master'].filter((name): name is string => !!name);
    for (const name of new Set(names)) {
      if ((await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`])).exitCode === 0) return name;
    }
    return undefined;
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

  private async hasLocalBranch(name: string): Promise<boolean> {
    return (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`])).exitCode === 0;
  }

  private async hasRemoteRef(ref: string): Promise<boolean> {
    return (await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`])).exitCode === 0;
  }

  private async mergeBase(base: string): Promise<string> {
    const result = await this.git(['merge-base', this.target.branch ?? 'HEAD', base]);
    if (result.exitCode !== 0) throw new Error(`This branch has no commit in common with ${base}.`);
    return result.stdout.trim();
  }

  /**
   * What `git diff` compares: `from` with the archived branch, with HEAD for
   * committed changes only, else with the working tree.
   */
  private range(from: string, scope: DiffScope): string[] {
    if (this.target.branch) return [from, `refs/heads/${this.target.branch}`];
    return scope === 'committed' ? [from, 'HEAD'] : [from];
  }

  /** The tracked files changed since HEAD, by path (a rename by its new one). */
  private async uncommittedPaths(): Promise<string[]> {
    return splitZ((await this.gitOrThrow(['diff', '--name-only', '-z', '-M', ...BASE_FLAGS, 'HEAD'])).stdout);
  }

  /** The untracked files git doesn't ignore, by path. */
  private async untrackedPaths(): Promise<string[]> {
    return splitZ((await this.gitOrThrow(['ls-files', '-z', '--others', '--exclude-standard'])).stdout);
  }

  /** Untracked files git doesn't ignore, as additions. */
  private async untracked(): Promise<DiffFile[]> {
    const paths = await this.untrackedPaths();
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
    if (result.exitCode !== 0) throw new Error(`Couldn't work out the diff: ${describeFailure('git', result)}`);
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

/**
 * Parses `git diff --raw --numstat -z`: the raw entries (`:modes hashes
 * STATUS\0path\0`, or `…\0old\0new\0` for a rename or copy), then the
 * numstat ones, each file's counts marked deleted or renamed as its raw
 * entry says.
 */
export function parseRawNumstat(text: string): Omit<DiffFile, 'status'>[] {
  const parts = text.split('\0');
  const changes = new Map<string, DiffFileChange>();
  let i = 0;
  for (; i < parts.length && parts[i]!.replace(/^\n/, '').startsWith(':'); i++) {
    const letter = parts[i]!.trim().split(' ').at(-1)?.[0];
    if (letter === 'R' || letter === 'C') {
      i += 2;
      if (letter === 'R') changes.set(parts[i]!, 'renamed');
    } else {
      i += 1;
      if (letter === 'D') changes.set(parts[i]!, 'deleted');
    }
  }
  return parseNumstat(parts.slice(i).join('\0')).map((file) => {
    const change = changes.get(file.path);
    return change ? { ...file, change } : file;
  });
}

/**
 * The paths `git status --porcelain=v2 -z` lists: each changed, unmerged or
 * untracked file (a rename by its new path).
 */
export function statusPaths(text: string): string[] {
  const parts = text.split('\0');
  const paths: string[] = [];
  // Fields before the path: ordinary `1` entries have 8, renames `2` 9, unmerged `u` 10.
  const fields: Record<string, number> = { '1': 8, '2': 9, u: 10 };
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.startsWith('? ')) {
      paths.push(entry.slice(2));
      continue;
    }
    const skip = fields[entry[0] ?? ''];
    if (skip === undefined || entry[1] !== ' ') continue;
    let at = 0;
    for (let n = 0; n < skip && at !== -1; n++) at = entry.indexOf(' ', at + 1);
    if (at !== -1) paths.push(entry.slice(at + 1));
    // A rename's old path follows as its own part.
    if (entry[0] === '2') i++;
  }
  return paths;
}

/** Parses `git diff --shortstat`: ` 3 files changed, 10 insertions(+), 2 deletions(-)`. */
export function parseShortstat(text: string): DiffStat {
  const count = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);
  return { files: count(/(\d+) files? changed/), added: count(/(\d+) insertions?\(\+\)/), removed: count(/(\d+) deletions?\(-\)/) };
}
