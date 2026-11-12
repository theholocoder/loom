// Listing a Project's open issues for the issue picker, through its Forge's
// CLI and the user's login (ADR 0002): `gh issue list` or `glab issue list`
// on the repository `origin` is on. Any open issue, not only the user's.
// And reading one, for the Issue Panel: `gh api` or `glab api` on its issue.
import type { ForgeKind, ForgeStatus, Issue, IssueDetails } from '../../shared/api';
import { FORGE_CLI } from '../../shared/api';
import { exec, type BridgeCall } from '../environments/exec';
import { runJson, timeOf } from './merge-request-activity';

const ISSUE_LIST_TIMEOUT_MS = 20_000;

/** The Project's Forge, for issues: its kind, host and repository. Rejects a Forge not checked yet, or off. */
function issueForge(forge: ForgeStatus | undefined): { kind: ForgeKind; host: string; repository: string } {
  if (forge?.state === 'unknown') throw new Error("Loom hasn't checked this Project's Forge yet.");
  if (forge?.state !== 'available' || !forge.kind || !forge.host || !forge.repository) throw new Error("Issues need the Project's Forge, which is off.");
  return { kind: forge.kind, host: forge.host, repository: forge.repository };
}

export async function listIssues(call: BridgeCall, status: ForgeStatus, checkoutPath?: string, search?: string): Promise<Issue[]> {
  const forge = issueForge(status);
  const query = search?.trim() ? ['--search', search.trim()] : [];
  const cli = FORGE_CLI[forge.kind];
  const args =
    forge.kind === 'github'
      ? ['issue', 'list', '--repo', `${forge.host}/${forge.repository}`, '--state', 'open', '--json', 'number,title,body,url', '--limit', '100', ...query]
      : ['issue', 'list', ...(checkoutPath ? [] : ['--repo', `https://${forge.host}/${forge.repository}`]), '--output', 'json', '--per-page', '100', ...query];
  // glab resolves the repository from the checkout when given one; it knows the SSH/web host mapping.
  const result = await exec(call, cli, args, ISSUE_LIST_TIMEOUT_MS, forge.kind === 'gitlab' ? checkoutPath : undefined);
  if (result.exitCode !== 0) {
    throw new Error(`${cli} issue list exited with code ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
  }
  let listed: unknown;
  try {
    listed = JSON.parse(result.stdout || '[]');
  } catch {
    throw new Error(`${cli} issue list printed something other than JSON: ${result.stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(listed)) throw new Error(`${cli} issue list printed something other than a list.`);
  return listed
    .filter((item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) =>
      forge.kind === 'github'
        ? { number: Number(item.number), title: String(item.title ?? ''), body: String(item.body ?? ''), url: String(item.url ?? '') }
        : { number: Number(item.iid), title: String(item.title ?? ''), body: String(item.description ?? ''), url: String(item.web_url ?? '') },
    )
    // Skips what Loom couldn't link a Session to.
    .filter((issue) => Number.isInteger(issue.number) && issue.number > 0 && /^https?:\/\//i.test(issue.url));
}

/** An issue as GitHub's REST API gives it, of what Loom reads. */
interface GitHubIssue {
  number: number;
  html_url: string;
  title: string;
  state: string;
  body?: string | null;
  labels: (string | { name?: string })[];
  user?: { login: string } | null;
  created_at?: string;
  comments: number;
  /** Set when it is a pull request. */
  pull_request?: unknown;
}

/** An issue as GitLab's REST API gives it, of what Loom reads. */
interface GitLabIssue {
  iid: number;
  web_url: string;
  title: string;
  /** `opened` or `closed`. */
  state: string;
  description?: string | null;
  labels: string[];
  author?: { username: string } | null;
  created_at?: string;
  user_notes_count: number;
}

/** Reads issue `number` from `forge`, in any state, running glab in `workingCopy`; rejects when the Forge can't say. */
export async function readIssue(call: BridgeCall, status: ForgeStatus | undefined, workingCopy: string, number: number): Promise<IssueDetails> {
  const forge = issueForge(status);
  if (forge.kind === 'github') {
    const issue = (await runJson(call, 'github', ['api', `repos/${forge.repository}/issues/${number}`, '--hostname', forge.host])) as GitHubIssue;
    // GitHub's issues API gives its pull requests too.
    if (issue.pull_request) throw new Error(`#${number} is a pull request on GitHub, not an issue.`);
    return {
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: issue.labels.flatMap((label) => (typeof label === 'string' ? [label] : label.name ? [label.name] : [])),
      author: issue.user?.login ?? 'ghost',
      ...timeOf(issue.created_at),
      comments: issue.comments,
      body: issue.body ?? '',
    };
  }
  // glab resolves the host from the working copy, knowing the SSH/web host mapping.
  const issue = (await runJson(call, 'gitlab', ['api', `projects/${encodeURIComponent(forge.repository)}/issues/${number}`], workingCopy)) as GitLabIssue;
  return {
    number: issue.iid,
    url: issue.web_url,
    title: issue.title,
    state: issue.state === 'closed' ? 'closed' : 'open',
    labels: issue.labels,
    author: issue.author?.username ?? 'ghost',
    ...timeOf(issue.created_at),
    comments: issue.user_notes_count,
    body: issue.description ?? '',
  };
}
