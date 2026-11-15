// Listing a Project's open issues for the issue picker, through its Forge's
// CLI and the user's login (ADR 0002): `gh issue list` or `glab issue list`
// on the repository `origin` is on. Any open issue, not only the user's.
// And reading one, for the Issue Panel: `gh api` or `glab api` on its issue.
// A search that names an issue (its number, or its URL pasted) reads that
// issue, whatever its state, rather than looking for the words.
import type { ForgeKind, ForgeStatus, Issue, IssueDetails } from '../../shared/api';
import { FORGE_CLI } from '../../shared/api';
import { exec, type BridgeCall } from '../environments/exec';
import { describeFailure } from '../environments/failures';
import { forgeItemNamed, isPageOf, isWebLink, type ForgeItemName } from './merge-requests';
import { runJson, timeOf } from './merge-request-activity';

const ISSUE_LIST_TIMEOUT_MS = 20_000;

/** The Project's Forge, for issues: its kind, host and repository. Rejects a Forge not checked yet, or off. */
function issueForge(forge: ForgeStatus | undefined): { kind: ForgeKind; host: string; repository: string } {
  if (forge?.state === 'unknown') throw new Error("Loom hasn't checked this Project's Forge yet.");
  if (forge?.state !== 'available' || !forge.kind || !forge.host || !forge.repository) throw new Error("Issues need the Project's Forge, which is off.");
  return { kind: forge.kind, host: forge.host, repository: forge.repository };
}

/**
 * The issues the picker shows for `search`: the open ones it finds; when it
 * is an issue's number, that issue first, whatever its state; when it is an
 * issue's URL, only that issue. Rejects a URL that isn't one of the
 * repository's issues.
 */
export async function searchIssues(call: BridgeCall, status: ForgeStatus, checkoutPath: string, search?: string): Promise<Issue[]> {
  // A Forge that's off says so first, before what the search names.
  issueForge(status);
  const named = search === undefined ? undefined : issueNamed(search);
  if (named?.url) return [pickable(await readNamedIssue(call, status, checkoutPath, named))];
  if (!named) {
    if (search !== undefined && isWebLink(search.trim())) throw new Error(`${search.trim()} isn't an issue's page.`);
    return listIssues(call, status, checkoutPath, search);
  }
  const [read, listed] = await Promise.all([
    // Not an issue: only the words are searched for. A Forge that can't be reached fails the list too.
    readIssue(call, status, checkoutPath, named.number).then(pickable, () => undefined),
    listIssues(call, status, checkoutPath, search),
  ]);
  return read ? [read, ...listed.filter((issue) => issue.number !== read.number)] : listed;
}

/** An issue as the user or the agent names it: `12`, `#12`, or its URL (`…/issues/12`, GitLab's `…/-/issues/12` or `…/-/work_items/12`). */
export function issueNamed(text: unknown): ForgeItemName | undefined {
  return forgeItemNamed(text, '#', ['issues', 'work_items']);
}

/** Reads the issue `named` names, in any state; rejects a URL that isn't one of the repository's issues. */
export async function readNamedIssue(call: BridgeCall, status: ForgeStatus | undefined, workingCopy: string, named: ForgeItemName): Promise<IssueDetails> {
  const elsewhere = () => new Error(`${named.url} isn't an issue of this Project's repository.`);
  // Another repository's is refused before reading this one's issue of the same number.
  if (named.url && !inRepository(named.url, issueForge(status).repository)) throw elsewhere();
  const found = await readIssue(call, status, workingCopy, named.number);
  // GitLab gives an issue's page as `…/-/issues/<n>`, whichever page of it was given.
  if (named.url && !isPageOf(named.url.replace(/\/work_items\//i, '/issues/'), found.url)) throw elsewhere();
  return found;
}

/** Whether `url`'s path is in `repository` (`owner/name`, or a GitLab group path), whatever its host and the path it is served under. */
function inRepository(url: string, repository: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().includes(`/${repository.toLowerCase()}/`);
  } catch {
    return false;
  }
}

/** An issue read, as the picker lists it. */
function pickable({ number, title, body, url }: IssueDetails): Issue {
  return { number, title, body, url };
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
    throw new Error(`${cli} issue list failed: ${describeFailure(cli, result)}`);
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
