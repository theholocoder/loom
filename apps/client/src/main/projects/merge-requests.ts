// Finding a Session's Merge request on its Project's Forge, through the
// Forge's CLI and the user's login (ADR 0002): the open one whose source
// branch is a given branch (`gh pr list --head`, `glab mr list
// --source-branch`), or one by its number (`gh pr view`, `glab mr view`);
// squashing and merging one when the user asks (`gh pr merge`, `glab mr
// merge`); and replying to or resolving one of its review threads, as the
// user asks from a note on the diff. Loom never creates a Merge request itself.
import { randomUUID } from 'node:crypto';
import { FORGE_CLI, type ForgeKind, type ForgeLink, type ForgeStatus, type MergeRequestState } from '../../shared/api';
import { exec, type BridgeCall } from '../environments/exec';
import { describeFailure } from '../environments/failures';

const MERGE_REQUEST_TIMEOUT_MS = 20_000;
/** Merging waits on the Forge, which may take a while over a big Merge request. */
const MERGE_TIMEOUT_MS = 60_000;
/** Writing a reply's file into the Environment. */
const WRITE_TIMEOUT_MS = 30_000;

/** A Merge request as the Forge has it now. */
export interface FoundMergeRequest extends ForgeLink {
  state: MergeRequestState;
  /** Its source branch. */
  branch: string;
}

/** The open Merge request whose source branch is `branch`, if there is one; the lowest-numbered of several. */
export async function findMergeRequest(call: BridgeCall, forge: ForgeStatus | undefined, workingCopy: string, branch: string): Promise<FoundMergeRequest | undefined> {
  const { kind, repo } = mergeRequestForge(forge);
  const args =
    kind === 'github'
      ? ['pr', 'list', ...repo, '--head', branch, '--state', 'open', '--json', 'number,url,state,headRefName', '--limit', '20']
      : ['mr', 'list', '--source-branch', branch, '--output', 'json', '--per-page', '20'];
  const listed = await run(call, kind, args, workingCopy);
  if (!Array.isArray(listed)) throw new Error(`${FORGE_CLI[kind]} ${args[0]} list printed something other than a list.`);
  return listed
    .map((item) => mergeRequestOf(kind, item))
    .filter((found): found is FoundMergeRequest => !!found && found.state === 'open' && found.branch === branch)
    .sort((a, b) => a.number - b.number)[0];
}

/** The Merge request numbered `number`, in whatever state; rejects when the Forge has none. */
export async function viewMergeRequest(call: BridgeCall, forge: ForgeStatus | undefined, workingCopy: string, number: number): Promise<FoundMergeRequest> {
  const { kind, repo } = mergeRequestForge(forge);
  const args = kind === 'github' ? ['pr', 'view', String(number), ...repo, '--json', 'number,url,state,headRefName'] : ['mr', 'view', String(number), '--output', 'json'];
  const found = mergeRequestOf(kind, await run(call, kind, args, workingCopy));
  if (!found || found.number !== number) throw new Error(`${FORGE_CLI[kind]} ${args[0]} view printed something unexpected.`);
  return found;
}

/**
 * Squashes and merges Merge request `number` into one commit titled `title`,
 * only while its source branch is at `head`: what the user saw when they
 * confirmed. Whether the source branch goes too is the Forge's own setting;
 * the working copy is left as it is. Rejects with what the Forge said when
 * it won't.
 */
export async function squashAndMerge(call: BridgeCall, forge: ForgeStatus | undefined, workingCopy: string, number: number, { title, head }: { title: string; head: string }): Promise<void> {
  const { kind, repo } = mergeRequestForge(forge);
  // The title is the user's own text, & and all: gh and glab install as executables, not the .cmd shims cmd.exe would split it in.
  const args =
    kind === 'github'
      ? ['pr', 'merge', String(number), ...repo, '--squash', '--subject', title, '--match-head-commit', head]
      : ['mr', 'merge', String(number), '--squash', '--squash-message', title, '--sha', head, '--yes'];
  await runCli(call, kind, args, workingCopy, MERGE_TIMEOUT_MS);
}

/** What a review thread is named by: a GitHub node id, or a GitLab discussion id. */
const THREAD_ID = /^[\w=-]+$/;

/**
 * Posts `body` as a reply in review thread `thread` of Merge request
 * `number`; rejects with what the Forge said when it won't. The reply is the
 * user's own text, newlines, & and all, and maybe long: the CLI reads it from
 * a file written under `tempDir` in the Environment, as no argument may hold
 * it whole (a .cmd shim runs through cmd.exe, which stops at a newline and
 * splits at an &, and a command line has a length limit).
 */
export async function replyToReviewThread(call: BridgeCall, forge: ForgeStatus | undefined, workingCopy: string, tempDir: string, number: number, thread: string, body: string): Promise<void> {
  const { kind, host, repository } = threadForge(forge, thread);
  const file = `${tempDir}/loom-replies/${randomUUID()}.md`;
  await call('files.write', WRITE_TIMEOUT_MS, { path: file, data: Buffer.from(body, 'utf8').toString('base64') });
  // `-F name=@file`: both CLIs read the field's value from the file.
  const args =
    kind === 'github'
      ? ['api', 'graphql', '--hostname', host, '-f', `query=${GITHUB_REPLY}`, '-f', `thread=${thread}`, '-F', `body=@${file}`]
      : ['api', `${gitLabDiscussion(repository, number, thread)}/notes`, '--method', 'POST', '-F', `body=@${file}`];
  await runCli(call, kind, args, workingCopy, MERGE_REQUEST_TIMEOUT_MS);
}

/** Resolves review thread `thread` of Merge request `number`; rejects with what the Forge said when it won't. */
export async function resolveReviewThread(call: BridgeCall, forge: ForgeStatus | undefined, workingCopy: string, number: number, thread: string): Promise<void> {
  const { kind, host, repository } = threadForge(forge, thread);
  const args =
    kind === 'github'
      ? ['api', 'graphql', '--hostname', host, '-f', `query=${GITHUB_RESOLVE}`, '-f', `thread=${thread}`]
      : ['api', gitLabDiscussion(repository, number, thread), '--method', 'PUT', '-F', 'resolved=true'];
  await runCli(call, kind, args, workingCopy, MERGE_REQUEST_TIMEOUT_MS);
}

const GITHUB_REPLY = 'mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { url } } }';
const GITHUB_RESOLVE = 'mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }';

/** The Project's Forge, to act on review thread `thread` there; rejects a Forge that's off, and what names no thread. */
function threadForge(forge: ForgeStatus | undefined, thread: string): { kind: ForgeKind; host: string; repository: string } {
  const { kind } = mergeRequestForge(forge);
  if (!THREAD_ID.test(thread)) throw new Error(`${JSON.stringify(thread)} isn't a review thread of this Merge request.`);
  // mergeRequestForge rejects a Forge without them.
  return { kind, host: forge!.host!, repository: forge!.repository! };
}

/** The GitLab API path of a Merge request's discussion. */
function gitLabDiscussion(repository: string, number: number, thread: string): string {
  return `projects/${encodeURIComponent(repository)}/merge_requests/${number}/discussions/${thread}`;
}

/**
 * The Project's Forge, for Merge requests: its kind, and the `--repo` gh
 * needs. Rejects a Forge not checked yet, or off.
 */
export function mergeRequestForge(forge: ForgeStatus | undefined): { kind: ForgeKind; repo: string[] } {
  if (forge?.state === 'unknown') throw new Error("Loom hasn't checked this Project's Forge yet.");
  if (forge?.state !== 'available' || !forge.kind || !forge.host || !forge.repository) throw new Error("Merge requests need the Project's Forge, which is off.");
  // glab resolves the repository from the working copy it runs in, knowing the SSH/web host mapping.
  return { kind: forge.kind, repo: forge.kind === 'github' ? ['--repo', `${forge.host}/${forge.repository}`] : [] };
}

/** Runs the Forge's CLI, in the working copy for glab, and parses the JSON it prints. */
async function run(call: BridgeCall, kind: ForgeKind, args: string[], workingCopy: string): Promise<unknown> {
  const stdout = await runCli(call, kind, args, workingCopy, MERGE_REQUEST_TIMEOUT_MS);
  try {
    return JSON.parse(stdout || 'null');
  } catch {
    throw new Error(`${FORGE_CLI[kind]} ${args[0]} ${args[1]} printed something other than JSON: ${stdout.slice(0, 200)}`);
  }
}

/** Runs the Forge's CLI, in the working copy for glab, and gives what it printed; rejects with what it said when it fails. */
async function runCli(call: BridgeCall, kind: ForgeKind, args: string[], workingCopy: string, timeoutMs: number): Promise<string> {
  const cli = FORGE_CLI[kind];
  const result = await exec(call, cli, args, timeoutMs, kind === 'gitlab' ? workingCopy : undefined);
  if (result.exitCode !== 0) throw new Error(`${cli} ${args[0]} ${args[1]} failed: ${describeFailure(cli, result)}`);
  return result.stdout;
}

/** A Merge request in the JSON `gh` or `glab` prints; undefined if Loom couldn't link to it. */
function mergeRequestOf(kind: ForgeKind, value: unknown): FoundMergeRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const raw =
    kind === 'github'
      ? { number: item.number, url: item.url, state: String(item.state ?? '').toLowerCase(), branch: item.headRefName }
      : // glab's `locked` is an open merge request being merged.
        { number: item.iid, url: item.web_url, state: item.state === 'opened' || item.state === 'locked' ? 'open' : String(item.state ?? ''), branch: item.source_branch };
  const number = Number(raw.number);
  const url = String(raw.url ?? '');
  if (!Number.isInteger(number) || number <= 0 || !/^https?:\/\//i.test(url)) return undefined;
  const state: MergeRequestState = raw.state === 'open' ? 'open' : raw.state === 'merged' ? 'merged' : 'closed';
  return { number, url, state, branch: String(raw.branch ?? '') };
}

/** A Merge request as the user or the agent names it: `12`, `#12`, `!12`, or its URL (`…/pull/12`, `…/merge_requests/12`). */
export function mergeRequestNamed(text: unknown): { number: number; url?: string } | undefined {
  if (typeof text !== 'string' && typeof text !== 'number') return undefined;
  const trimmed = String(text).trim();
  const plain = /^[#!]?(\d+)$/.exec(trimmed);
  if (plain) return Number(plain[1]) > 0 ? { number: Number(plain[1]) } : undefined;
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  const inUrl = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(trimmed);
  return inUrl && Number(inUrl[1]) > 0 ? { number: Number(inUrl[1]), url: trimmed } : undefined;
}

/** Whether the URL the user gave is of the Merge request the Forge found: its page, or one under it. */
export function isPageOf(given: string, found: string): boolean {
  const normal = (url: string) => url.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const a = normal(given);
  const b = normal(found);
  return a === b || a.startsWith(`${b}/`);
}
