// What is going on on a Merge request, read through the Forge's CLI and the
// user's login (ADR 0002), in terms Babysit needs: who said what, its CI, and
// whether it conflicts. The user's own comments are already left out.
import { FORGE_CLI, type BabysitCheck, type BabysitCheckState, type BabysitCi, type FeedbackCheck, type FeedbackItem, type ForgeStatus, type MergeRequestState, type ReviewCount, type ReviewThread } from '../../shared/api';
import { exec, type BridgeCall } from '../environments/exec';

const ACTIVITY_TIMEOUT_MS = 30_000;
/** How much of a comment Loom quotes: the agent gets a link to the rest. */
const EXCERPT_LENGTH = 400;

/** One piece of a Merge request's activity, with what tells it from the others across polls. */
export interface KeyedFeedback {
  key: string;
  item: FeedbackItem;
}

export interface MergeRequestApproval {
  key: string;
  author: string;
  url: string;
}

export interface MergeRequestActivity {
  state: MergeRequestState;
  feedback: KeyedFeedback[];
  approvals: MergeRequestApproval[];
  ci: {
    status?: BabysitCi;
    /** Tells this run of the CI from others: a finished run is reported once. */
    key?: string;
    /** What failed, once it has finished. */
    failing: FeedbackCheck[];
    /** Every check, however far along. */
    checks: BabysitCheck[];
  };
  /** Absent while the Forge hasn't worked it out. */
  conflicts?: boolean;
  /** The reviews and comments of others. */
  reviews: ReviewCount;
  /** The review threads on the code, not resolved, that others wrote in. */
  threads: ReviewThread[];
}

/** Reads a Merge request's activity from `forge`; rejects when the Forge can't say. */
export async function readMergeRequestActivity(call: BridgeCall, forge: ForgeStatus | undefined, workingCopy: string, number: number): Promise<MergeRequestActivity> {
  if (forge?.state !== 'available' || !forge.kind || !forge.host || !forge.repository) throw new Error("Babysit needs the Project's Forge, which is off.");
  return forge.kind === 'github' ? readGitHub(call, forge.host, forge.repository, number) : readGitLab(call, forge.repository, workingCopy, number);
}

// A CLI installed as a .cmd shim runs through cmd.exe, which stops at a newline
// and splits at an &: no argument here may have either.

// One query, so a poll is one process. `last`: the newest, should there be more.
const GITHUB_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      mergeable
      reviews(last: 100) { nodes { databaseId state body url author { login } comments(first: 100) { nodes { path line originalLine body url } } } }
      comments(last: 100) { nodes { databaseId body url author { login } } }
      reviewThreads(last: 100) { nodes { id isResolved isOutdated path line originalLine diffSide viewerCanResolve
        comments(first: 50) { nodes { body url createdAt diffHunk author { login } pullRequestReview { state } } } } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl createdAt }
      } } } } } }
    }
  }
}`.replace(/\s*\n\s*/g, ' ');

export interface GitHubAuthored {
  author: { login: string } | null;
}
interface GitHubReview extends GitHubAuthored {
  databaseId: number;
  state: string;
  body: string;
  url: string;
  comments: { nodes: { path: string; line: number | null; originalLine: number | null; body: string; url: string }[] };
}
interface GitHubComment extends GitHubAuthored {
  databaseId: number;
  body: string;
  url: string;
}
interface GitHubThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  viewerCanResolve: boolean;
  comments: { nodes: (GitHubAuthored & { body: string; url: string; createdAt: string | null; diffHunk?: string; pullRequestReview: { state: string } | null })[] };
}
export type GitHubContext = { __typename: 'CheckRun'; databaseId: number; name: string; status: string; conclusion: string | null; detailsUrl: string | null } | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string | null; createdAt: string };
interface GitHubResponse {
  data: {
    viewer: { login: string };
    repository: {
      pullRequest: {
        state: string;
        mergeable: string;
        reviews: { nodes: GitHubReview[] };
        comments: { nodes: GitHubComment[] };
        reviewThreads: { nodes: GitHubThread[] };
        commits: { nodes: { commit: { oid: string; statusCheckRollup: { state: string; contexts: { nodes: GitHubContext[] } } | null } }[] };
      };
    };
  };
}

async function readGitHub(call: BridgeCall, host: string, repository: string, number: number): Promise<MergeRequestActivity> {
  const slash = repository.indexOf('/');
  const args = ['api', 'graphql', '--hostname', host, '-f', `query=${GITHUB_QUERY}`, '-f', `owner=${repository.slice(0, slash)}`, '-f', `name=${repository.slice(slash + 1)}`, '-F', `number=${number}`];
  const { data } = (await runJson(call, 'github', args)) as GitHubResponse;
  const pull = data.repository.pullRequest;
  const own = data.viewer.login.toLowerCase();
  const others = <T extends GitHubAuthored>(list: T[]) => list.filter((entry) => entry.author?.login.toLowerCase() !== own);

  const reviews = others(pull.reviews.nodes);
  const feedback: KeyedFeedback[] = reviews.flatMap((review) => {
    if (review.state !== 'CHANGES_REQUESTED' && review.state !== 'COMMENTED') return [];
    const comments = review.comments.nodes.map((c) => ({ path: c.path, ...lineOf(c.line ?? c.originalLine), excerpt: excerptOf(c.body), url: c.url }));
    if (review.state === 'COMMENTED' && !review.body.trim() && !comments.length) return [];
    return [{ key: `review:${review.databaseId}`, item: { kind: 'review', author: authorOf(review), verdict: review.state === 'CHANGES_REQUESTED' ? 'changes-requested' : 'commented', excerpt: excerptOf(review.body), url: review.url, comments } }];
  });
  for (const comment of others(pull.comments.nodes)) feedback.push({ key: `comment:${comment.databaseId}`, item: { kind: 'comment', author: authorOf(comment), excerpt: excerptOf(comment.body), url: comment.url } });

  const approvals = reviews.filter((r) => r.state === 'APPROVED').map((r) => ({ key: `review:${r.databaseId}`, author: authorOf(r), url: r.url }));
  const commit = pull.commits.nodes[0]?.commit;
  // A reviewer's verdict is their latest one: a comment leaves it as it was.
  const verdicts = new Map<string, string>();
  for (const review of reviews) if (review.state !== 'COMMENTED' && review.state !== 'PENDING') verdicts.set(authorOf(review), review.state);
  return {
    reviews: {
      reviews: approvals.length + feedback.filter(({ item }) => item.kind === 'review').length,
      comments: feedback.filter(({ item }) => item.kind === 'comment').length,
      changesRequested: [...verdicts.values()].includes('CHANGES_REQUESTED'),
    },
    state: gitHubState(pull.state),
    feedback,
    approvals,
    ci: gitHubCi(commit?.oid ?? '', commit?.statusCheckRollup ?? undefined),
    conflicts: pull.mergeable === 'CONFLICTING' ? true : pull.mergeable === 'MERGEABLE' ? false : undefined,
    threads: pull.reviewThreads.nodes.flatMap((thread) => {
      const comments = thread.comments.nodes;
      if (thread.isResolved || !comments.some((c) => c.author?.login.toLowerCase() !== own)) return [];
      return [
        {
          id: thread.id,
          path: thread.path,
          // An outdated thread's line is on a diff the Merge request has moved on from.
          ...lineOf(thread.isOutdated ? undefined : thread.line),
          side: thread.diffSide === 'LEFT' ? 'old' : 'new',
          ...codeOf(comments[0]?.diffHunk),
          ...(comments.some((c) => c.pullRequestReview?.state === 'CHANGES_REQUESTED') ? { changesRequested: true } : {}),
          comments: comments.map((c) => ({ author: authorOf(c), body: c.body, ...timeOf(c.createdAt), url: c.url })),
          canResolve: thread.viewerCanResolve,
        } satisfies ReviewThread,
      ];
    }),
  };
}

const GITHUB_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'ERROR']);
const GITHUB_PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/**
 * The whole of a commit's checks and statuses: pending until GitHub says all
 * of it has finished, which covers suites with no runs yet and contexts past
 * the first 100. A failure's key has each failed run in it, so a re-run that
 * fails again is reported again.
 */
export function gitHubCi(oid: string, rollup: { state: string; contexts: { nodes: GitHubContext[] } } | undefined): MergeRequestActivity['ci'] {
  if (!rollup) return { failing: [], checks: [] };
  const results = rollup.contexts.nodes.map((c) =>
    c.__typename === 'CheckRun'
      ? { run: `${c.name}#${c.databaseId}`, name: c.name, url: c.detailsUrl, result: c.status === 'COMPLETED' ? (c.conclusion ?? '') : undefined }
      : { run: `${c.context}@${c.createdAt}`, name: c.context, url: c.targetUrl, result: c.state === 'PENDING' || c.state === 'EXPECTED' ? undefined : c.state },
  );
  const checks = results.map((r) => listedCheck(r.name, gitHubCheckState(r.result), r.url));
  if (rollup.state === 'PENDING' || rollup.state === 'EXPECTED') return { status: 'pending', failing: [], checks };
  if (!results.length) return { failing: [], checks };
  if (results.some((r) => r.result === undefined)) return { status: 'pending', failing: [], checks };
  const failing = results.filter((r) => GITHUB_FAILED.has(r.result!));
  if (failing.length) return { status: 'failed', key: `failed:${oid}:${failing.map((r) => r.run).sort().join(',')}`, failing: failing.map(checkOf), checks };
  return results.every((r) => GITHUB_PASSED.has(r.result!)) ? { status: 'passed', key: `passed:${oid}`, failing: [], checks } : { failing: [], checks };
}

function gitHubCheckState(result: string | undefined): BabysitCheckState {
  if (result === undefined) return 'pending';
  return GITHUB_FAILED.has(result) ? 'failed' : GITHUB_PASSED.has(result) ? 'passed' : 'not-run';
}

export interface GitLabMergeRequest {
  state: string;
  has_conflicts?: boolean;
  head_pipeline?: { id: number; status: string } | null;
  web_url: string;
}
interface GitLabNote {
  id: number;
  body: string;
  system: boolean;
  author: { username: string };
  created_at?: string;
  position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null };
  resolvable?: boolean;
  resolved?: boolean;
}
interface GitLabDiscussion {
  id: string;
  notes: GitLabNote[];
}

async function readGitLab(call: BridgeCall, repository: string, workingCopy: string, number: number): Promise<MergeRequestActivity> {
  const project = `projects/${encodeURIComponent(repository)}`;
  const run = (args: string[]) => runJson(call, 'gitlab', args, workingCopy);
  const [request, user, discussions, approvals] = (await Promise.all([
    run(['mr', 'view', String(number), '--output', 'json']),
    run(['api', 'user']),
    // Each with its notes: a comment outside a thread is a discussion of its own.
    run(['api', `${project}/merge_requests/${number}/discussions?per_page=100`]),
    run(['api', `${project}/merge_requests/${number}/approvals`]),
  ])) as [GitLabMergeRequest, { username: string }, GitLabDiscussion[], { approved_by: { user: { username: string } }[] }];
  const own = user.username.toLowerCase();
  const url = request.web_url;
  const byOthers = (note: GitLabNote) => !note.system && note.author.username.toLowerCase() !== own;

  const feedback: KeyedFeedback[] = discussions
    .flatMap((discussion) => discussion.notes)
    .filter(byOthers)
    // Oldest first.
    .sort((a, b) => a.id - b.id)
    .map((note) => {
      const path = note.position?.new_path ?? note.position?.old_path;
      return { key: `note:${note.id}`, item: { kind: 'comment', author: note.author.username, ...(path ? { path } : {}), ...lineOf(note.position?.new_line ?? note.position?.old_line), excerpt: excerptOf(note.body), url: `${url}#note_${note.id}` } };
    });

  const approved = approvals.approved_by.filter(({ user: u }) => u.username.toLowerCase() !== own);
  return {
    state: gitLabState(request.state),
    feedback,
    // GitLab's reviews are its approvals.
    reviews: { reviews: approved.length, comments: feedback.length, changesRequested: false },
    approvals: approved.map(({ user: u }) => ({ key: `approval:${u.username}`, author: u.username, url })),
    ci: await gitLabCi(run, project, request.head_pipeline ?? undefined),
    conflicts: request.has_conflicts,
    threads: discussions.flatMap((discussion) => {
      const notes = discussion.notes.filter((note) => !note.system);
      const first = notes[0];
      const path = first?.position?.new_path ?? first?.position?.old_path;
      if (!first || !path || first.resolved || !notes.some(byOthers)) return [];
      const onOld = !first.position?.new_line && !!first.position?.old_line;
      return [
        {
          id: discussion.id,
          path: onOld ? (first.position?.old_path ?? path) : path,
          ...lineOf(onOld ? first.position?.old_line : first.position?.new_line),
          side: onOld ? 'old' : 'new',
          comments: notes.map((note) => ({ author: note.author.username, body: note.body, ...timeOf(note.created_at), url: `${url}#note_${note.id}` })),
          canResolve: first.resolvable !== false,
        } satisfies ReviewThread,
      ];
    }),
  };
}

const GITLAB_PENDING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled']);

export async function gitLabCi(run: (args: string[]) => Promise<unknown>, project: string, pipeline: GitLabMergeRequest['head_pipeline']): Promise<MergeRequestActivity['ci']> {
  if (!pipeline) return { failing: [], checks: [] };
  const all = (await run(['api', `${project}/pipelines/${pipeline.id}/jobs?per_page=100`])) as { id: number; name: string; status: string; web_url: string }[];
  const checks = all.map((job) => listedCheck(job.name, gitLabCheckState(job.status), job.web_url));
  if (GITLAB_PENDING.has(pipeline.status)) return { status: 'pending', failing: [], checks };
  if (pipeline.status === 'success') return { status: 'passed', key: `passed:${pipeline.id}`, failing: [], checks };
  if (pipeline.status !== 'failed') return { failing: [], checks };
  const jobs = all.filter((job) => job.status === 'failed');
  // A retried job keeps its pipeline but not its id: failing again is news.
  return { status: 'failed', key: `failed:${pipeline.id}:${jobs.map((job) => job.id).sort((a, b) => a - b).join(',')}`, failing: jobs.map((job) => ({ name: job.name, url: job.web_url })), checks };
}

function gitLabCheckState(status: string): BabysitCheckState {
  if (GITLAB_PENDING.has(status)) return 'pending';
  return status === 'failed' ? 'failed' : status === 'success' || status === 'skipped' ? 'passed' : 'not-run';
}

/** Who wrote something on GitHub: `ghost` for a deleted account. */
export function authorOf({ author }: GitHubAuthored): string {
  return author?.login ?? 'ghost';
}

/** A pull request's state as GitHub's GraphQL API gives it. */
export function gitHubState(state: string): MergeRequestState {
  return state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : 'closed';
}

/** A merge request's state as GitLab gives it: `locked` is an open one being merged. */
export function gitLabState(state: string): MergeRequestState {
  return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open';
}

export function listedCheck(name: string, state: BabysitCheckState, url: string | null): BabysitCheck {
  return { name, state, ...(url ? { url } : {}) };
}

function checkOf({ name, url }: { name: string; url: string | null }): FeedbackCheck {
  return { name, ...(url ? { url } : {}) };
}

/** The line a GitHub review comment is on, as its hunk's last line holds it, without its diff marker. */
function codeOf(hunk: string | undefined): { code?: string } {
  const last = hunk?.trimEnd().split('\n').at(-1);
  return last && /^[ +-]/.test(last) ? { code: last.slice(1) } : {};
}

/** A time as the Forge writes it, as clock time; none when it gives none, or one that doesn't parse. */
export function timeOf(text: string | null | undefined): { at?: number } {
  const at = text ? Date.parse(text) : NaN;
  return Number.isNaN(at) ? {} : { at };
}

export function lineOf(line: number | null | undefined): { line?: number } {
  return line ? { line } : {};
}

function excerptOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > EXCERPT_LENGTH ? `${oneLine.slice(0, EXCERPT_LENGTH)}…` : oneLine;
}

export async function runJson(call: BridgeCall, kind: keyof typeof FORGE_CLI, args: string[], workingCopy?: string): Promise<unknown> {
  const cli = FORGE_CLI[kind];
  const result = await exec(call, cli, args, ACTIVITY_TIMEOUT_MS, workingCopy);
  const what = `${cli} ${args[0]} ${args[1]}`;
  if (result.exitCode !== 0) throw new Error(`${what} exited with code ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${what} printed something other than JSON: ${result.stdout.slice(0, 200)}`);
  }
}
