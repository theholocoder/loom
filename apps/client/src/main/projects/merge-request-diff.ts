// A Merge request's diff as its Panel's Diff tab shows it, read through the
// Forge's CLI and the user's login (ADR 0002) when the tab asks: each file it
// changes, with its unified diff, as the Forge lists them (`pulls/<n>/files`
// on GitHub, `merge_requests/<n>/diffs` on GitLab). Neither gives a diff's
// file headers, so Loom writes them, as git would.
import type { ForgeStatus, MergeRequestDiff, MergeRequestDiffFile } from '../../shared/api';
import type { BridgeCall } from '../environments/exec';
import { MAX_FILE_DIFF_CHARS } from '../sessions/diff';
import { runJson } from './merge-request-activity';
import { mergeRequestForge } from './merge-requests';

/** How many files one call lists: past that many, Loom says there are more. */
export const MAX_MERGE_REQUEST_DIFF_FILES = 100;

/** Reads Merge request `number`'s diff from `forge`, running glab in `workingCopy`; rejects when the Forge can't say. */
export async function readMergeRequestDiff(call: BridgeCall, forge: ForgeStatus | undefined, workingCopy: string, number: number): Promise<MergeRequestDiff> {
  const { kind } = mergeRequestForge(forge);
  const files = kind === 'github' ? await readGitHub(call, forge!.host!, forge!.repository!, number) : await readGitLab(call, forge!.repository!, workingCopy, number);
  return { files, ...(files.length >= MAX_MERGE_REQUEST_DIFF_FILES ? { moreFiles: true } : {}) };
}

/** A file as GitHub's `pulls/<n>/files` lists it. */
interface GitHubFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  /** Absent for a binary file, an empty one, and one too large for GitHub to show. */
  patch?: string;
}

async function readGitHub(call: BridgeCall, host: string, repository: string, number: number): Promise<MergeRequestDiffFile[]> {
  // No & in an argument: see merge-request-activity.ts.
  const listed = (await runJson(call, 'github', ['api', '--hostname', host, `repos/${repository}/pulls/${number}/files?per_page=${MAX_MERGE_REQUEST_DIFF_FILES}`])) as GitHubFile[];
  if (!Array.isArray(listed)) throw new Error(`GitHub listed something other than the files of pull request #${number}.`);
  return listed.map((file) => {
    const oldPath = file.status === 'renamed' || file.status === 'copied' ? file.previous_filename : undefined;
    const change = file.status === 'removed' ? 'deleted' : file.status === 'renamed' ? 'renamed' : undefined;
    const counted = file.additions + file.deletions > 0;
    // With no patch: too large to show when it changes lines, else binary, but for a rename or mode change alone.
    const binary = file.patch === undefined && !counted && (file.status === 'added' || file.status === 'removed' || file.status === 'modified');
    return diffFile({
      path: file.filename,
      oldPath,
      change,
      added: file.additions,
      removed: file.deletions,
      binary,
      patch: file.patch,
      tooLarge: file.patch === undefined && counted,
      created: file.status === 'added',
    });
  });
}

/** A file as GitLab's `merge_requests/<n>/diffs` lists it. */
interface GitLabDiff {
  old_path: string;
  new_path: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  a_mode?: string;
  b_mode?: string;
  diff: string;
  /** Set when GitLab leaves its diff out, as too large. */
  too_large?: boolean;
}

async function readGitLab(call: BridgeCall, repository: string, workingCopy: string, number: number): Promise<MergeRequestDiffFile[]> {
  // No & in an argument: see merge-request-activity.ts.
  const path = `projects/${encodeURIComponent(repository)}/merge_requests/${number}/diffs?per_page=${MAX_MERGE_REQUEST_DIFF_FILES}`;
  const listed = (await runJson(call, 'gitlab', ['api', path], workingCopy)) as GitLabDiff[];
  if (!Array.isArray(listed)) throw new Error(`GitLab listed something other than the diffs of merge request !${number}.`);
  return listed.map((file) => {
    let added = 0;
    let removed = 0;
    // GitLab's diffs have no file headers: every line that starts with + or - is a change.
    for (const line of file.diff.split('\n')) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
    const tooLarge = !!file.too_large;
    const modeOnly = !!file.a_mode && !!file.b_mode && file.a_mode !== file.b_mode;
    const binary = !tooLarge && (file.diff.startsWith('Binary files') || (!file.diff.trim() && !file.renamed_file && !modeOnly));
    return diffFile({
      path: file.new_path,
      oldPath: file.renamed_file ? file.old_path : undefined,
      change: file.deleted_file ? 'deleted' : file.renamed_file ? 'renamed' : undefined,
      added: binary ? 0 : added,
      removed: binary ? 0 : removed,
      binary,
      patch: binary || tooLarge ? undefined : file.diff,
      tooLarge,
      created: !!file.new_file,
    });
  });
}

/** A file of the diff, its hunks under the headers git would give them, cut short past MAX_FILE_DIFF_CHARS. */
function diffFile(file: {
  path: string;
  oldPath: string | undefined;
  change: MergeRequestDiffFile['change'];
  added: number;
  removed: number;
  binary: boolean;
  patch: string | undefined;
  tooLarge: boolean;
  /** Whether the Merge request adds it. */
  created: boolean;
}): MergeRequestDiffFile {
  const { path, oldPath, change, added, removed, binary, patch, tooLarge, created } = file;
  const listed = { path, ...(oldPath ? { oldPath } : {}), status: 'committed' as const, ...(change ? { change } : {}), added, removed, binary };
  if (binary) return { ...listed, text: '', truncated: false };
  if (tooLarge) return { ...listed, text: '', truncated: true };
  const before = oldPath ?? path;
  const head = [`diff --git a/${before} b/${path}`, created ? '--- /dev/null' : `--- a/${before}`, change === 'deleted' ? '+++ /dev/null' : `+++ b/${path}`];
  const body = patch?.trim() ? `${patch.replace(/\n$/, '')}\n` : '';
  const text = `${head.join('\n')}\n${body}`;
  return text.length > MAX_FILE_DIFF_CHARS ? { ...listed, text: text.slice(0, MAX_FILE_DIFF_CHARS), truncated: true } : { ...listed, text, truncated: false };
}
