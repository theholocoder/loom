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
// CLI it stands in for (named by the script file, gh.json or glab.json) does.
// And Merge request linking: `pr list --head <branch>` / `mr list
// --source-branch <branch>` list the script's open `mergeRequests` on that
// branch, and `pr view <n>` / `mr view <n>` print one of them in any state,
// failing like the real CLI when there is none.
import { appendFileSync, readFileSync } from 'node:fs';
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
  const issues = (script.issues ?? []).filter((i) => !search || `${i.title}\n${i.body}`.toLowerCase().includes(search));
  const json =
    basename(scriptPath, '.json') === 'glab'
      ? issues.map((i) => ({ id: 9000 + i.number, iid: i.number, title: i.title, description: i.body, state: 'opened', web_url: i.url }))
      : issues.map((i) => ({ number: i.number, title: i.title, body: i.body, url: i.url }));
  process.stdout.write(JSON.stringify(json));
} else if ((args[0] === 'pr' || args[0] === 'mr') && args[1] === 'list') {
  const flag = args[0] === 'pr' ? '--head' : '--source-branch';
  const branch = args[args.indexOf(flag) + 1];
  const listed = (script.mergeRequests ?? []).filter((m) => m.branch === branch && (m.state ?? 'open') === 'open');
  process.stdout.write(JSON.stringify(listed.map(asCli)));
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

/** A scripted Merge request as `gh` or `glab` prints it in JSON. */
function asCli({ number, url, branch, state = 'open' }) {
  return basename(scriptPath, '.json') === 'glab'
    ? { id: 5000 + number, iid: number, web_url: url, source_branch: branch, state: state === 'open' ? 'opened' : state }
    : { number, url, headRefName: branch, state: state.toUpperCase() };
}
