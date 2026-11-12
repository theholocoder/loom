// A scripted stand-in for the user's `gh` or `glab`, put on the Environment's
// PATH by the seam A harness. Usage: node forge-cli.mjs <script.json> <args...>
// The script lists the hosts the CLI is signed in to; every invocation is
// appended to <script.json>.log, one JSON argv per line.
//
// It fakes what Loom's Forge detection uses: `auth status --hostname <host>`,
// which exits 0 when signed in to that host and 1 otherwise, as both CLIs do.
// `repo view --output json`, answered from the script's `repoView` (the
// CLI resolving the repository from the working directory); each
// invocation's cwd is appended to <script.json>.cwd.
// And the issue picker's `issue list`: the script's open `issues`, filtered by
// `--search` (case-insensitive, in title or body), printed as JSON the way the
// CLI it stands in for (named by the script file, gh.json or glab.json) does;
// and the Issue Panel's read of one in any state, `api repos/<owner>/<repo>/
// issues/<n>` for gh and `api projects/<id>/issues/<n>` for glab, failing
// with a 404 like the real API when the script has none.
// And Merge request linking: `pr list --head <branch>` / `mr list
// --source-branch <branch>` list the script's open `mergeRequests` on that
// branch, and `pr view <n>` / `mr view <n>` print one of them in any state,
// failing like the real CLI when there is none.
// And Babysit's polls of a Merge request's activity (see `activity` in
// machine.ts): `api graphql` for gh, `api user`, `api …/notes`, `api
// …/approvals` and `api …/jobs` for glab. They all fail, as an unreachable
// Forge would, while the script's `offline` is set.
// And the Merge request Panel's read of one: the same `api graphql` for gh,
// with its title, branches, author, description, reviewers asked (`reviewers`,
// a name with a slash being a team on GitHub), commits and changes; `mr
// view`, `api …/reviewers` (those of its `reviewers` in `requestedChanges`
// asking for changes), `api …/commits` and `api …/diffs` for glab. And its Diff tab's:
// `api …/pulls/<n>/files` for gh (the script's `files`), `api …/diffs` for glab.
// And review threads (the script's `threads`): in the same `api graphql` for
// gh, as GitLab discussions in `api …/discussions` for glab (each of the
// script's `comments` a discussion of its own); replying to one (`api
// graphql` with addPullRequestReviewThreadReply, `api …/discussions/<id>/notes
// --method POST`) adds the viewer's comment to it, its body read from the
// file `-F body=@<file>` names, resolving one (`api graphql`
// with resolveReviewThread, `api …/discussions/<id> --method PUT`) marks it
// resolved, both written back to the script; one not in the script fails.
// And Squash and merge: `pr merge <n>` / `mr merge <n>`, which fail like the
// real CLI when the head commit given isn't the Merge request's `oid` or the
// script has a `mergeRefusal`, and otherwise mark it merged in the script
// (left open with `mergeLater`, as a merge queue would).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [scriptPath, ...args] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
appendFileSync(`${scriptPath}.log`, JSON.stringify(args) + '\n');
appendFileSync(`${scriptPath}.cwd`, process.cwd() + '\n');

const hostname = args[args.indexOf('--hostname') + 1];
if (args[0] === 'auth' && args[1] === 'status' && args.includes('--hostname') && script.authStatus?.[hostname]) {
  const { stdout = '', stderr = '', exitCode } = script.authStatus[hostname];
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exit(exitCode);
} else if (args[0] === 'repo' && args[1] === 'view') {
  // What the CLI resolves from the checkout it runs in; exits like the real one on failure.
  const { stdout = '', stderr = '', exitCode = 0 } = script.repoView ?? { exitCode: 1, stderr: 'fatal: not a git repository' };
  process.stdout.write(typeof stdout === 'string' ? stdout : JSON.stringify(stdout));
  process.stderr.write(stderr);
  process.exit(exitCode);
} else if (args[0] === 'auth' && args[1] === 'status' && args.includes('--hostname')) {
  if (script.signedInHosts.includes(hostname)) {
    process.stdout.write(`${hostname}\n  ✓ Logged in to ${hostname} account octocat\n`);
  } else {
    process.stderr.write(`You are not logged into any accounts on ${hostname}\n`);
    process.exit(1);
  }
} else if (args[0] === 'issue' && args[1] === 'list') {
  const search = args.includes('--search') ? args[args.indexOf('--search') + 1].toLowerCase() : '';
  const issues = (script.issues ?? []).filter((i) => (i.state ?? 'open') === 'open' && (!search || `${i.title}\n${i.body}`.toLowerCase().includes(search)));
  const json =
    basename(scriptPath, '.json') === 'glab'
      ? issues.map((i) => ({ id: 9000 + i.number, iid: i.number, title: i.title, description: i.body, state: 'opened', web_url: i.url }))
      : issues.map((i) => ({ number: i.number, title: i.title, body: i.body, url: i.url }));
  process.stdout.write(JSON.stringify(json));
} else if (args[0] === 'api' && /^(repos\/[^/]+\/[^/]+|projects\/[^/]+)\/issues\/\d+$/.test(args[1])) {
  const number = Number(/\/issues\/(\d+)$/.exec(args[1])[1]);
  const found = (script.issues ?? []).find((i) => i.number === number);
  const glab = basename(scriptPath, '.json') === 'glab';
  if (!found) {
    process.stderr.write(glab ? '404 Not found\n' : 'gh: Not Found (HTTP 404)\n');
    process.exit(1);
  }
  const { title, body, url, state = 'open', labels = [], author = 'octocat', createdAt = '2026-11-01T00:00:00Z', comments = 0, pullRequest = false } = found;
  process.stdout.write(
    JSON.stringify(
      glab
        ? { id: 9000 + number, iid: number, title, description: body, state: state === 'open' ? 'opened' : 'closed', labels, author: { username: author }, created_at: createdAt, user_notes_count: comments, web_url: url }
        : { number, title, body, state, labels: labels.map((name, n) => ({ id: n + 1, name })), user: { login: author }, created_at: createdAt, comments, html_url: url, ...(pullRequest ? { pull_request: { html_url: url } } : {}) },
    ),
  );
} else if (args[0] === 'api' && script.offline) {
  process.stderr.write('error connecting to the Forge\n');
  process.exit(1);
} else if (args[0] === 'api' && args[1] === 'graphql' && args.some((a) => a.startsWith('query=mutation'))) {
  const query = args.find((a) => a.startsWith('query='));
  const id = args.find((a) => a.startsWith('thread=')).slice('thread='.length);
  const thread = (script.mergeRequests ?? []).flatMap((m) => m.threads ?? []).find((t) => t.id === id);
  if (!thread) {
    process.stderr.write(`GraphQL: Could not resolve to a node with the global id of '${id}'\n`);
    process.exit(1);
  }
  if (query.includes('resolveReviewThread')) thread.resolved = true;
  else thread.comments.push({ author: script.viewer ?? 'octocat', body: fieldValue('body') });
  writeFileSync(scriptPath, JSON.stringify(script));
  process.stdout.write(JSON.stringify({ data: {} }));
} else if (args[0] === 'api' && /\/merge_requests\/\d+\/discussions\/[^/?]+(\/notes)?$/.test(args[1])) {
  const [, id, notes] = /\/discussions\/([^/?]+)(\/notes)?$/.exec(args[1]);
  const thread = (mergeRequestIn(args[1])?.threads ?? []).find((t) => t.id === id);
  if (!thread) {
    process.stderr.write('404 Not found\n');
    process.exit(1);
  }
  if (notes) thread.comments.push({ author: script.viewer ?? 'octocat', body: fieldValue('body') });
  else thread.resolved = true;
  writeFileSync(scriptPath, JSON.stringify(script));
  process.stdout.write('{}');
} else if (args[0] === 'api' && args[1] === 'graphql') {
  const number = args.find((a) => a.startsWith('number=')).slice('number='.length);
  const found = (script.mergeRequests ?? []).find((m) => String(m.number) === number);
  process.stdout.write(JSON.stringify({ data: { viewer: { login: script.viewer ?? 'octocat' }, repository: { pullRequest: found ? asPullRequest(found) : null } } }));
} else if (args[0] === 'api' && args.some((a) => /\/pulls\/\d+\/files(\?|$)/.test(a))) {
  const number = /\/pulls\/(\d+)\/files/.exec(args.find((a) => /\/pulls\/\d+\/files/.test(a)))[1];
  const found = (script.mergeRequests ?? []).find((m) => String(m.number) === number);
  if (!found) {
    process.stderr.write('gh: Not Found (HTTP 404)\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(found.files ?? []));
} else if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write(JSON.stringify({ username: script.viewer ?? 'octocat' }));
} else if (args[0] === 'api' && /\/merge_requests\/\d+\/notes(\?|$)/.test(args[1])) {
  const found = mergeRequestIn(args[1]);
  process.stdout.write(JSON.stringify((found.comments ?? []).map(asNote)));
} else if (args[0] === 'api' && /\/merge_requests\/\d+\/discussions(\?|$)/.test(args[1])) {
  const found = mergeRequestIn(args[1]);
  const single = (found.comments ?? []).map((c) => ({ id: `d${c.id}`, individual_note: !c.path, notes: [asNote(c)] }));
  process.stdout.write(JSON.stringify([...single, ...(found.threads ?? []).map(asDiscussion)]));
} else if (args[0] === 'api' && /\/merge_requests\/\d+\/approvals$/.test(args[1])) {
  const found = mergeRequestIn(args[1]);
  process.stdout.write(JSON.stringify({ approved_by: (found.approvedBy ?? []).map((username) => ({ user: { username } })) }));
} else if (args[0] === 'api' && /\/merge_requests\/\d+\/reviewers$/.test(args[1])) {
  const found = mergeRequestIn(args[1]);
  process.stdout.write(JSON.stringify((found.reviewers ?? []).map((username) => ({ user: { username }, state: (found.requestedChanges ?? []).includes(username) ? 'requested_changes' : 'unreviewed' }))));
} else if (args[0] === 'api' && /\/merge_requests\/\d+\/commits(\?|$)/.test(args[1])) {
  const found = mergeRequestIn(args[1]);
  process.stdout.write(JSON.stringify(Array.from({ length: found.commits ?? 1 }, (_, i) => ({ id: `commit-${i + 1}` }))));
} else if (args[0] === 'api' && /\/merge_requests\/\d+\/diffs(\?|$)/.test(args[1])) {
  const found = mergeRequestIn(args[1]);
  process.stdout.write(JSON.stringify(found.diffs ?? []));
} else if (args[0] === 'api' && /\/pipelines\/\d+\/jobs(\?|$)/.test(args[1])) {
  const id = /\/pipelines\/(\d+)\/jobs/.exec(args[1])[1];
  const found = (script.mergeRequests ?? []).find((m) => String(m.pipeline?.id) === id);
  const failed = (found?.pipeline.failedJobs ?? []).map((job) => ({ id: job.id, name: job.name, status: 'failed', web_url: job.url }));
  const jobs = found?.pipeline.jobs?.map((job) => ({ id: job.id, name: job.name, status: job.status, web_url: job.url }));
  process.stdout.write(JSON.stringify(jobs ?? [{ id: 1, name: 'lint', status: 'success', web_url: 'https://ci/lint' }, ...failed]));
} else if ((args[0] === 'pr' || args[0] === 'mr') && args[1] === 'list') {
  const flag = args[0] === 'pr' ? '--head' : '--source-branch';
  const branch = args[args.indexOf(flag) + 1];
  const listed = (script.mergeRequests ?? []).filter((m) => m.branch === branch && (m.state ?? 'open') === 'open');
  process.stdout.write(JSON.stringify(listed.map(asCli)));
} else if ((args[0] === 'pr' || args[0] === 'mr') && args[1] === 'merge') {
  const found = (script.mergeRequests ?? []).find((m) => String(m.number) === args[2]);
  const head = args[args.indexOf(args[0] === 'pr' ? '--match-head-commit' : '--sha') + 1];
  if (!found) {
    process.stderr.write(args[0] === 'pr' ? `GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}.\n` : '404 Not Found\n');
    process.exit(1);
  }
  if (found.mergeRefusal) {
    process.stderr.write(`${found.mergeRefusal}\n`);
    process.exit(1);
  }
  if (head !== (found.oid ?? 'commit-1')) {
    process.stderr.write(args[0] === 'pr' ? 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\n' : 'ERROR: 409 Conflict: SHA does not match HEAD of source branch\n');
    process.exit(1);
  }
  if (!found.mergeLater) found.state = 'merged';
  writeFileSync(scriptPath, JSON.stringify(script));
  process.stdout.write(args[0] === 'pr' ? `✓ Squashed and merged pull request #${found.number}\n` : `✓ Merged!\n`);
} else if ((args[0] === 'pr' || args[0] === 'mr') && args[1] === 'view') {
  const found = (script.mergeRequests ?? []).find((m) => String(m.number) === args[2]);
  if (!found) {
    process.stderr.write(args[0] === 'pr' ? `GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}.\n` : '404 Not Found\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(asCli(found)));
} else {
  process.stderr.write(`forge CLI stand-in: unscripted command ${JSON.stringify(args)}\n`);
  process.exit(1);
}

/** The value of field `name` (`-f`/`-F name=value`), read from the file a `-F name=@file` names, as both CLIs do. */
function fieldValue(name) {
  const at = args.findIndex((a, i) => (args[i - 1] === '-f' || args[i - 1] === '-F') && a.startsWith(`${name}=`));
  const value = args[at].slice(name.length + 1);
  return args[at - 1] === '-F' && value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value;
}

/** A scripted Merge request as `gh` or `glab` prints it in JSON. */
function asCli({ number, url, branch, state = 'open', conflicts, pipeline, title = `Merge request ${number}`, draft = false, author = 'octocat', target = 'main', description = '', reviewers = [], oid = 'commit-1' }) {
  return basename(scriptPath, '.json') === 'glab'
    ? { id: 5000 + number, iid: number, web_url: url, sha: oid, title, description, draft, author: { username: author }, reviewers: reviewers.map((username) => ({ username })), source_branch: branch, target_branch: target, state: state === 'open' ? 'opened' : state, has_conflicts: conflicts ?? false, head_pipeline: pipeline ? { id: pipeline.id, status: pipeline.status } : null }
    : { number, url, headRefName: branch, state: state.toUpperCase() };
}

/** The Merge request a `glab api …/merge_requests/<n>/…` path names. */
function mergeRequestIn(path) {
  const number = /\/merge_requests\/(\d+)\//.exec(path)[1];
  return (script.mergeRequests ?? []).find((m) => String(m.number) === number);
}

/** A scripted comment as GitLab's notes API returns it. */
function asNote({ id, author, body, path, line, system = false, createdAt }) {
  return { id, body, system, author: { username: author }, ...(createdAt ? { created_at: createdAt } : {}), ...(path ? { type: 'DiffNote', position: { new_path: path, new_line: line } } : { type: null }) };
}

/** A scripted review thread as GitLab's discussions API returns it: its notes numbered from 1000 unless they say. */
function asDiscussion({ id, path, line, side = 'new', resolved = false, canResolve = true, comments }, at) {
  const position = side === 'old' ? { old_path: path, new_path: path, old_line: line ?? null, new_line: null } : { old_path: path, new_path: path, old_line: null, new_line: line ?? null };
  return {
    id,
    individual_note: false,
    notes: comments.map((c, n) => ({ id: c.id ?? 1000 + at * 100 + n, body: c.body, system: false, author: { username: c.author }, ...(c.createdAt ? { created_at: c.createdAt } : {}), type: 'DiffNote', position, resolvable: canResolve, resolved })),
  };
}

/** A scripted review thread as Loom's GraphQL query gets it from GitHub. */
function asThread({ id, path, line, side = 'new', outdated = false, resolved = false, canResolve = true, changesRequested = false, code, comments }) {
  return {
    id,
    isResolved: resolved,
    isOutdated: outdated,
    path,
    line: outdated ? null : (line ?? null),
    originalLine: line ?? null,
    diffSide: side === 'old' ? 'LEFT' : 'RIGHT',
    viewerCanResolve: canResolve,
    comments: { nodes: comments.map((c, n) => ({ body: c.body, url: c.url ?? `https://github.com/thread/${id}#${n}`, createdAt: c.createdAt ?? null, diffHunk: code === undefined ? '@@ -1,1 +1,1 @@' : `@@ -1,1 +1,1 @@\n${side === 'old' ? '-' : '+'}${code}`, author: c.author ? { login: c.author } : null, pullRequestReview: changesRequested && n === 0 ? { state: 'CHANGES_REQUESTED' } : { state: 'COMMENTED' } })) },
  };
}

/** The state GitHub sums a commit's checks up as. */
function rollupOf(checks) {
  if (checks.some((c) => (c.context ? c.state === 'PENDING' : (c.status ?? 'COMPLETED') !== 'COMPLETED'))) return 'PENDING';
  return checks.some((c) => (c.context ? c.state !== 'SUCCESS' : c.conclusion === 'FAILURE')) ? 'FAILURE' : 'SUCCESS';
}

/** A scripted Merge request as Loom's GraphQL query gets it from GitHub. */
function asPullRequest({ number, url, branch, state = 'open', reviews = [], comments = [], threads = [], checks = [], conflicts, oid = 'commit-1', rollupState, title = `Merge request ${number}`, draft = false, author = 'octocat', target = 'main', commits = 1, additions = 0, deletions = 0, changedFiles = 0, description = '', reviewers = [] }) {
  return {
    number,
    url,
    title,
    body: description,
    reviewRequests: { nodes: reviewers.map((name) => ({ requestedReviewer: name.includes('/') ? { __typename: 'Team', combinedSlug: name } : { __typename: 'User', login: name } })) },
    isDraft: draft,
    headRefName: branch,
    baseRefName: target,
    author: author ? { login: author } : null,
    additions,
    deletions,
    changedFiles,
    totalCommits: { totalCount: commits },
    state: state.toUpperCase(),
    mergeable: conflicts === undefined ? 'UNKNOWN' : conflicts ? 'CONFLICTING' : 'MERGEABLE',
    reviews: {
      nodes: reviews.map((r) => ({
        databaseId: r.id,
        state: r.state,
        body: r.body ?? '',
        url: r.url,
        submittedAt: r.submittedAt ?? null,
        author: r.author ? { login: r.author } : null,
        comments: { nodes: (r.comments ?? []).map((c) => ({ path: c.path, line: c.line ?? null, originalLine: c.originalLine ?? null, body: c.body, url: c.url, createdAt: c.createdAt ?? null, author: r.author ? { login: r.author } : null })) },
      })),
    },
    comments: { nodes: comments.map((c) => ({ databaseId: c.id, body: c.body, url: c.url, createdAt: c.createdAt ?? null, author: c.author ? { login: c.author } : null })) },
    reviewThreads: { nodes: threads.map(asThread) },
    commits: {
      nodes: [
        {
          commit: {
            oid,
            statusCheckRollup: checks.length
              ? { state: rollupState ?? rollupOf(checks), contexts: { nodes: checks.map((c) => (c.context ? { __typename: 'StatusContext', context: c.context, state: c.state, targetUrl: c.url ?? null, createdAt: c.createdAt ?? '2026-11-01T00:00:00Z' } : { __typename: 'CheckRun', databaseId: c.id, name: c.name, status: c.status ?? 'COMPLETED', conclusion: c.conclusion ?? null, detailsUrl: c.url ?? null })) } }
              : null,
          },
        },
      ],
    },
  };
}
