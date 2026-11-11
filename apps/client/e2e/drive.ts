// Drives the built app in a sandbox for an agent to look at, see the
// drive-loom skill: a temporary profile, three seeded git repositories, and
// the seam A stand-ins for `opencode`, `gh` and an editor. It serves
//   POST /run   the body of an async function, run with { window, app, machine, shot, state, logs, consoleErrors } in scope; what it returns comes back as JSON
//   POST /stop  closes the app, removes the sandbox and exits
// Env: LOOM_DRIVE_PORT (default 7788), LOOM_DRIVE_OUT (screenshots and profile; default a temp folder), LOOM_DRIVE_HEADED=1 to show the window.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
// Node runs this file as is, so the import names the file it loads.
// @ts-expect-error TS5097: the project doesn't set allowImportingTsExtensions.
import { Machine, type AcpTurn } from '../test/seam-a/machine.ts';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.LOOM_DRIVE_PORT ?? 7788);
const out = process.env.LOOM_DRIVE_OUT ?? mkdtempSync(join(tmpdir(), 'loom-drive-'));
const shots = join(out, 'shots');
mkdirSync(shots, { recursive: true });
const userDataDir = mkdtempSync(join(out, 'profile-'));

const thought = (text: string) => ({ update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } });
const tool = (sessionUpdate: string, fields: Record<string, unknown>) => ({ update: { sessionUpdate, ...fields } });
const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }];

/** What each agent process plays, one turn per prompt (see the skill). */
const turns: AcpTurn[] = [
  {
    chunks: [
      thought('The tests fail '),
      thought('on a typo in the reducer.'),
      'Let me look at the code.\n\n',
      tool('tool_call', { toolCallId: 'call_1', title: 'Read src/app.ts', kind: 'read', status: 'pending', rawInput: { filePath: 'src/app.ts' } }),
      tool('tool_call_update', { toolCallId: 'call_1', status: 'completed', content: text('export const app = 1;') }),
      tool('tool_call', { toolCallId: 'call_2', title: 'pnpm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'pnpm test' } }),
      tool('tool_call_update', { toolCallId: 'call_2', status: 'failed', rawOutput: { output: 'FAIL src/app.test.ts\n  ✕ adds (3 ms)\n\nExpected: 2\nReceived: 3', metadata: { exit: 1 } } }),
      tool('tool_call', { toolCallId: 'call_3', title: 'Edit src/app.ts', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: 'src/app.ts', oldText: 'export const app = 1;\n', newText: 'export const app = 2;\n' }] }),
      { update: { sessionUpdate: 'plan', entries: [{ content: 'Read the failing test', status: 'completed', priority: 'high' }, { content: 'Fix the reducer', status: 'in_progress', priority: 'high' }, { content: 'Run the suite', status: 'pending', priority: 'medium' }] } },
      '## Fixed\n\nThe reducer added `1` twice. I changed:\n\n```ts\nexport const app = 2;\n```\n\n| File | Change |\n|---|---|\n| `src/app.ts` | constant fixed |\n\n- [x] tests pass\n- [ ] docs\n\nSee [the docs](https://example.com).',
    ],
    used: 54_000,
    cost: 0.42,
    tokens: { inputTokens: 12000, outputTokens: 800, cachedReadTokens: 30000 },
  },
  {
    chunks: [
      'I need to run a command outside the working copy.',
      { permission: { toolCallId: 'p1', name: 'shell', title: 'rm -rf ../build-cache', kind: 'execute', locations: [{ path: '/tmp' }], rawInput: { command: 'rm -rf ../build-cache', cwd: '/tmp' } } },
      { elicit: { message: 'Which database should the migration target?', requestedSchema: { type: 'object', properties: { db: { type: 'string', title: 'Database', enum: ['postgres', 'sqlite'] }, notes: { type: 'string', title: 'Notes' } }, required: ['db'] } } },
      'Thanks, done.',
    ],
    used: 90_000,
    cost: 0.9,
  },
  { chunks: ['Working on the long task…'], hold: 'long' },
  { chunks: ['Trying'], error: 'Provider error: rate limit exceeded (429). Try again later.' },
];

const machine = new Machine();
machine.installOpencode({
  version: 'opencode v2.1.4',
  integrations: [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }],
  models: [
    { providerID: 'opencode', id: 'pulse-free', name: 'Pulse Free', context: 128_000 },
    { providerID: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', variants: ['low', 'high', 'max'], context: 200_000 },
    { providerID: 'openai', id: 'gpt-old', name: 'GPT Old', enabled: false },
  ],
  commands: [{ name: 'review', description: 'Review the current changes' }, { name: 'init', description: 'Write AGENTS.md' }],
  skills: [{ id: 'tdd', name: 'tdd', description: 'Test-driven development' }],
  acp: { images: true, turns },
});
const branch = 'loom/12-invoices-show-the-wrong-currency';
machine.installForgeCli('gh', {
  signedInHosts: ['github.com'],
  repoView: { stdout: { nameWithOwner: 'acme/billing-api', url: 'https://github.com/acme/billing-api' } },
  issues: [
    { number: 12, title: 'Invoices show the wrong currency', body: 'When a customer is in EU the currency is USD.', url: 'https://github.com/acme/billing-api/issues/12' },
    { number: 15, title: 'Add CSV export', body: 'Export invoices to CSV.', url: 'https://github.com/acme/billing-api/issues/15' },
  ],
  mergeRequests: [
    {
      number: 40,
      url: 'https://github.com/acme/billing-api/pull/40',
      branch,
      oid: 'abc123',
      title: 'Invoices use the billing currency',
      author: 'octocat',
      commits: 2,
      additions: 67,
      deletions: 1,
      changedFiles: 3,
      comments: [{ id: 1, author: 'alice', body: 'Can we keep the old helper around for one release?', url: 'https://github.com/acme/billing-api/pull/40#c1', createdAt: '2026-11-01T10:30:00Z' }],
      reviews: [{ id: 2, author: 'bob', state: 'CHANGES_REQUESTED', body: 'A few things', url: 'https://github.com/acme/billing-api/pull/40#r2', submittedAt: '2026-11-01T10:00:00Z', comments: [{ path: 'src/currency.ts', line: 3, body: 'This should use `Intl.NumberFormat`', url: 'https://github.com/acme/billing-api/pull/40#c3', createdAt: '2026-11-01T10:00:00Z' }] }],
      checks: [
        { id: 5, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', url: 'https://github.com/acme/billing-api/actions/5' },
        { id: 6, name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
      conflicts: false,
    },
  ],
});
machine.installEditor('code');

const repos = {
  /** On GitHub (its origin is unreachable), with a branch that has Merge request #40. */
  billing: machine.gitRepo('billing-api', { origin: 'git@github.com:acme/billing-api.git' }),
  /** A local bare repository as origin: fetches work. */
  web: machine.gitRepo('web-frontend'),
  /** No origin at all. */
  docs: machine.gitRepo('docs-site-with-a-rather-long-name'),
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
{
  const repo = repos.billing;
  for (const file of ['src/currency.ts', 'src/invoice.ts', 'src/api/routes.ts', 'src/ui/Invoice.tsx', 'README.md', 'package.json']) write(join(repo, file), `// ${file}\nexport const v = 1;\nexport function f(a: number) {\n  return a + 1;\n}\n`);
  write(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Initial commit');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(repo, 'checkout', '-q', '-b', branch);
  write(join(repo, 'src/currency.ts'), '// src/currency.ts\nexport const v = 2;\nexport function format(amount: number, currency: string) {\n  return `${amount.toFixed(2)} ${currency}`;\n}\nexport function f(a: number) {\n  return a + 1;\n}\n');
  write(join(repo, 'src/ui/InvoiceRow.tsx'), 'export function InvoiceRow() {\n  return null;\n}\n');
  write(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n' + Array.from({ length: 60 }, (_, i) => `pkg${i}: 1.0.${i}\n`).join(''));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Fix currency');
  write(join(repo, 'README.md'), '# Billing API\n\nCurrency now follows the customer.\n');
  git(repo, 'checkout', '-q', 'main');
}
{
  const repo = repos.web;
  write(join(repo, 'src/App.tsx'), 'export function App() {\n  return <h1>Hello</h1>;\n}\n');
  write(join(repo, 'README.md'), '# Web\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Initial commit');
  const bare = join(repo, '..', 'web-frontend-origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'remote', 'set-head', 'origin', 'main');
}
{
  const repo = repos.docs;
  write(join(repo, 'index.md'), '# Docs\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Initial commit');
}

const headless = !process.env.LOOM_DRIVE_HEADED;
const app: ElectronApplication = await electron.launch({
  args: [...(headless ? ['--ozone-platform=headless'] : []), appDir],
  env: { ...machine.bridgeEnv(), LOOM_USER_DATA_DIR: userDataDir },
});
const logs: string[] = [];
app.process().stdout?.on('data', (chunk) => logs.push(String(chunk)));
app.process().stderr?.on('data', (chunk) => logs.push(String(chunk)));
const window: Page = await app.firstWindow({ timeout: 20_000 });
// Headless windows start at 1x1.
await window.setViewportSize({ width: 1400, height: 900 });
const consoleErrors: string[] = [];
window.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(`${message.type()}: ${message.text()}`);
});
window.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

let shotCount = 0;
/** Saves a screenshot of the window under `shots/` and returns its path. */
const shot = async (name: string) => {
  const path = join(shots, `${String(++shotCount).padStart(3, '0')}-${name}.png`);
  await window.screenshot({ path });
  return path;
};
const state = { repos, out, userDataDir, machineDir: machine.dir };

async function stop(): Promise<void> {
  await app.close().catch(() => undefined);
  rmSync(machine.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

type Script = (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => Script;
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/stop') {
    await stop();
    res.end('stopped\n');
    server.close();
    process.exit(0);
  }
  if (req.method !== 'POST' || req.url !== '/run') {
    res.statusCode = 404;
    res.end('POST /run or /stop\n');
    return;
  }
  let body = '';
  for await (const chunk of req) body += String(chunk);
  try {
    const script = new AsyncFunction('window', 'app', 'machine', 'shot', 'state', 'logs', 'consoleErrors', body);
    const result = await script(window, app, machine, shot, state, logs, consoleErrors);
    res.end(JSON.stringify(result ?? null, null, 1) + '\n');
  } catch (error) {
    res.statusCode = 500;
    res.end(String((error as Error).stack ?? error) + '\n');
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop().then(() => process.exit(0)));
server.listen(port, '127.0.0.1', () => console.log(`drive ready on ${port} ${JSON.stringify(state)}`));
