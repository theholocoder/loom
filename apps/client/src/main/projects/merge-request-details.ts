// A Merge request as its Panel shows it, read through the Forge's CLI and the
// user's login (ADR 0002) when the Panel asks: its title, state, branches,
// commits and changes, its description and reviewers, its checks, and
// everyone's reviews and comments.
import type { ForgeStatus, MergeRequestComment, MergeRequestDetails, MergeRequestReview, ReviewVerdict } from '../../shared/api';
import type { BridgeCall } from '../environments/exec';
import { authorOf, gitHubCi, gitHubState, gitLabCi, gitLabState, lineOf, runJson, type GitHubAuthored, type GitHubContext, type GitLabMergeRequest } from './merge-request-activity';
import { mergeRequestForge } from './merge-requests';

/** How many commits, files and notes one call lists, on GitLab: past that many commits or files, Loom says there are more. */
const PER_PAGE = 100;

/** Reads Merge request `number` from `forge`, running glab in `workingCopy`; rejects when the Forge can't say. */
export async function readMergeRequestDetails(call: BridgeCall, forge: ForgeStatus | undefined, workingCopy: string, number: number): Promise<MergeRequestDetails> {
  const { kind } = mergeRequestForge(forge);
  return kind === 'github' ? readGitHub(call, forge!.host!, forge!.repository!, number) : readGitLab(call, forge!.repository!, workingCopy, number);
}

// No newline or & in an argument: see merge-request-activity.ts.
const GITHUB_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url title body state isDraft headRefName baseRefName author { login }
      reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { combinedSlug } } } }
      additions deletions changedFiles
      totalCommits: commits { totalCount }
      reviews(last: 100) { nodes { state body url submittedAt author { login } comments(first: 100) { nodes { path line originalLine body url createdAt author { login } } } } }
      comments(last: 100) { nodes { body url createdAt author { login } } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl createdAt }
      } } } } } }
    }
  }
}`.replace(/\s*\n\s*/g, ' ');

interface GitHubComment extends GitHubAuthored {
  body: string;
  url: string;
  createdAt?: string | null;
  path?: string;
  line?: number | null;
  originalLine?: number | null;
}
interface GitHubPullRequest extends GitHubAuthored {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  totalCommits: { totalCount: number };
  /** Those asked to review it who haven't yet: GitHub drops a request once its reviewer has reviewed. */
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; combinedSlug?: string } | null }[] };
  reviews: { nodes: (GitHubAuthored & { state: string; body: string; url: string; submittedAt?: string | null; comments: { nodes: GitHubComment[] } })[] };
  comments: { nodes: GitHubComment[] };
  commits: { nodes: { commit: { oid: string; statusCheckRollup: { state: string; contexts: { nodes: GitHubContext[] } } | null } }[] };
}

const GITHUB_VERDICTS: Record<string, ReviewVerdict> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', COMMENTED: 'commented', DISMISSED: 'dismissed' };

async function readGitHub(call: BridgeCall, host: string, repository: string, number: number): Promise<MergeRequestDetails> {
  const slash = repository.indexOf('/');
  const args = ['api', 'graphql', '--hostname', host, '-f', `query=${GITHUB_QUERY}`, '-f', `owner=${repository.slice(0, slash)}`, '-f', `name=${repository.slice(slash + 1)}`, '-F', `number=${number}`];
  const response = (await runJson(call, 'github', args)) as { data?: { repository?: { pullRequest?: GitHubPullRequest | null } } };
  const pull = response.data?.repository?.pullRequest;
  if (!pull) throw new Error(`GitHub has no pull request #${number} in ${repository}.`);
  const commit = pull.commits.nodes[0]?.commit;
  const ci = gitHubCi(commit?.oid ?? '', commit?.statusCheckRollup ?? undefined);
  const comment = (c: GitHubComment): MergeRequestComment => ({
    author: authorOf(c),
    body: c.body,
    ...(c.path ? { path: c.path, ...lineOf(c.line ?? c.originalLine) } : {}),
    ...timeOf(c.createdAt),
    url: c.url,
  });
  const reviews: MergeRequestReview[] = pull.reviews.nodes.flatMap((review) => {
    const verdict = GITHUB_VERDICTS[review.state];
    // A draft review is no one's but its author's; an empty comment holds only replies to a thread.
    if (!verdict) return [];
    const comments = review.comments.nodes.map(comment);
    if (verdict === 'commented' && !review.body.trim() && !comments.length) return [];
    return [{ author: authorOf(review), verdict, body: review.body, ...timeOf(review.submittedAt), url: review.url, comments }];
  });
  const author = authorOf(pull);
  const requested = pull.reviewRequests.nodes.flatMap(({ requestedReviewer: r }) => {
    const name = r?.login ?? r?.combinedSlug;
    return name ? [name] : [];
  });
  return {
    number: pull.number,
    url: pull.url,
    title: pull.title,
    state: gitHubState(pull.state),
    draft: pull.isDraft,
    sourceBranch: pull.headRefName,
    targetBranch: pull.baseRefName,
    author,
    description: pull.body,
    // Those who reviewed, then those still asked to.
    reviewers: reviewersOf(author, [...reviews.map((review) => review.author), ...requested]),
    commits: pull.totalCommits.totalCount,
    files: pull.changedFiles,
    added: pull.additions,
    removed: pull.deletions,
    ...(ci.status ? { ci: ci.status } : {}),
    checks: ci.checks,
    reviews,
    comments: pull.comments.nodes.map(comment),
  };
}

interface GitLabView extends GitLabMergeRequest {
  iid: number;
  title: string;
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch: string;
  target_branch: string;
  author?: { username: string } | null;
  description?: string | null;
  reviewers?: { username: string }[] | null;
}
interface GitLabNote {
  body: string;
  system: boolean;
  created_at?: string;
  id: number;
  author: { username: string };
  position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null };
}

async function readGitLab(call: BridgeCall, repository: string, workingCopy: string, number: number): Promise<MergeRequestDetails> {
  const project = `projects/${encodeURIComponent(repository)}`;
  const run = (args: string[]) => runJson(call, 'gitlab', args, workingCopy);
  const path = `${project}/merge_requests/${number}`;
  const [request, notes, approvals, commits, diffs] = (await Promise.all([
    run(['mr', 'view', String(number), '--output', 'json']),
    run(['api', `${path}/notes?per_page=${PER_PAGE}`]),
    run(['api', `${path}/approvals`]),
    run(['api', `${path}/commits?per_page=${PER_PAGE}`]),
    run(['api', `${path}/diffs?per_page=${PER_PAGE}`]),
  ])) as [GitLabView, GitLabNote[], { approved_by: { user: { username: string } }[] }, unknown[], { diff: string }[]];
  const ci = await gitLabCi(run, project, request.head_pipeline ?? undefined);
  let added = 0;
  let removed = 0;
  // GitLab's diffs have no file headers: every line that starts with + or - is a change.
  for (const { diff } of diffs) {
    for (const line of diff.split('\n')) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  const url = request.web_url;
  const author = request.author?.username ?? 'ghost';
  const approvers = approvals.approved_by.map(({ user }) => user.username);
  const comments: MergeRequestComment[] = notes
    .filter((note) => !note.system)
    // Newest first, as GitLab returns them by default.
    .reverse()
    .map((note) => {
      const at = note.position?.new_path ?? note.position?.old_path;
      return { author: note.author.username, body: note.body, ...(at ? { path: at, ...lineOf(note.position?.new_line ?? note.position?.old_line) } : {}), ...timeOf(note.created_at), url: `${url}#note_${note.id}` };
    });
  return {
    number: request.iid,
    url,
    title: request.title,
    state: gitLabState(request.state),
    draft: !!(request.draft ?? request.work_in_progress),
    sourceBranch: request.source_branch,
    targetBranch: request.target_branch,
    author,
    description: request.description ?? '',
    // Those asked to review it, then those who approved it without being asked.
    reviewers: reviewersOf(author, [...(request.reviewers ?? []).map((reviewer) => reviewer.username), ...approvers]),
    commits: commits.length,
    ...(commits.length >= PER_PAGE ? { moreCommits: true } : {}),
    files: diffs.length,
    ...(diffs.length >= PER_PAGE ? { moreFiles: true } : {}),
    added,
    removed,
    ...(ci.status ? { ci: ci.status } : {}),
    checks: ci.checks,
    // GitLab's reviews are its approvals.
    reviews: approvers.map((approver) => ({ author: approver, verdict: 'approved', body: '', url, comments: [] })),
    comments,
  };
}

/** `names` once each, in order, without the Merge request's `author`: replying to a thread makes them a reviewer on GitHub. */
function reviewersOf(author: string, names: string[]): string[] {
  return [...new Set(names)].filter((name) => name !== author);
}

function timeOf(iso: string | null | undefined): { at?: number } {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? { at } : {};
}
