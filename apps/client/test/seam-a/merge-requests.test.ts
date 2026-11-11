import { describe, expect, it } from 'vitest';
import { git, startMain, tempMachine, waitFor, type AcpTurn, type ForgeCli, type ForgeCliScript, type Machine } from './harness';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

const GITHUB = 'https://github.com/theholocoder/loom.git';
const GITLAB = 'git@gitlab.example.org:acme/loom.git';
const pr = (number: number) => `https://github.com/theholocoder/loom/pull/${number}`;
const mr = (number: number) => `https://gitlab.example.org/acme/loom/-/merge_requests/${number}`;

type MergeRequests = NonNullable<ForgeCliScript['mergeRequests']>;

/**
 * A machine whose `cli` is signed in and knows `mergeRequests`, with a
 * checkout on `origin` whose `main` has a commit and which is on `branch`.
 */
function machineOn(cli: ForgeCli, origin: string, { turns = [], mergeRequests = [], branch = 'loom/fix-login' }: { turns?: AcpTurn[]; mergeRequests?: MergeRequests; branch?: string } = {}) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  const host = cli === 'gh' ? 'github.com' : 'gitlab.example.org';
  const script: ForgeCliScript = { signedInHosts: [host], mergeRequests };
  if (cli === 'glab') script.repoView = { stdout: { path_with_namespace: 'acme/loom', web_url: 'https://gitlab.example.org/acme/loom' } };
  machine.installForgeCli(cli, script);
  const { checkout } = machine.setUp(`${origin} ${branch}`, (m) => {
    const checkout = m.gitRepo('loom', { origin });
    git(checkout, 'checkout', '--quiet', '-b', 'main');
    m.commit(checkout, 'README.md', '# loom\n');
    // origin/HEAD names the default branch, as a clone sets it.
    git(checkout, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    if (branch !== 'main') git(checkout, 'checkout', '--quiet', '-b', branch);
    return { checkout };
  });
  const forge = (scripted: MergeRequests) => machine.installForgeCli(cli, { ...script, mergeRequests: scripted });
  return { machine, checkout, forge };
}

async function withSession(machine: Machine, checkout: string, prompt = 'Fix the login bug') {
  const main = await startMain({ machine });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  await waitFor(main.api, 'projects', (list) => list.some((p) => p.id === project.id && p.forge.state === 'available'));
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt });
  return { main, id };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

const cards = (items: TranscriptItem[]) => items.filter((i) => i.kind === 'merge-request');

describe('Merge request linking after each turn', () => {
  it("links the open pull request of the Session's branch once the turn settles, with a timeline card", async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { turns: [{ chunks: ['Opened it.'] }], mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login' }] });
    const { main, id } = await withSession(machine, checkout);

    const linked = await waitFor(main.api, 'sessions', session(id, (s) => !!s.mergeRequest));
    expect(linked.find((s) => s.id === id)!.mergeRequest).toEqual({ number: 12, url: pr(12) });
    const items = await waitFor(main.api, 'transcript', (list) => cards(list).length > 0, { sessionId: id });
    expect(cards(items)).toEqual([{ kind: 'merge-request', id: expect.any(Number), number: 12, url: pr(12) }]);
    const list = machine.forgeCliInvocations('gh').find((args) => args[0] === 'pr')!;
    expect(list).toEqual(expect.arrayContaining(['pr', 'list', '--repo', 'github.com/theholocoder/loom', '--head', 'loom/fix-login', '--state', 'open']));
  });
});

describe("the Merge request's state", () => {
  it('is open once linked, and what the Forge says once the Session is archived', async () => {
    const { machine, checkout, forge } = machineOn('gh', GITHUB, { turns: [{ chunks: ['Opened it.'] }], mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login' }] });
    const { main, id } = await withSession(machine, checkout);
    const linked = await waitFor(main.api, 'sessions', session(id, (s) => !!s.mergeRequest && s.status === 'waiting'));
    expect(linked.find((s) => s.id === id)!.mergeRequestState).toBe('open');

    forge([{ number: 12, url: pr(12), branch: 'loom/fix-login', state: 'merged' }]);
    await main.api.invoke('sessions.archive', { id });
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequestState === 'merged'));
  });
});

describe('Merge request linking on GitLab', () => {
  it("links the open merge request of the Session's branch through glab, in its working copy", async () => {
    const { machine, checkout } = machineOn('glab', GITLAB, { mergeRequests: [{ number: 87, url: mr(87), branch: 'loom/fix-login' }] });
    const { main, id } = await withSession(machine, checkout);

    const linked = await waitFor(main.api, 'sessions', session(id, (s) => !!s.mergeRequest));
    expect(linked.find((s) => s.id === id)!.mergeRequest).toEqual({ number: 87, url: mr(87) });
    const at = machine.forgeCliInvocations('glab').findIndex((args) => args[0] === 'mr');
    expect(machine.forgeCliInvocations('glab')[at]).toEqual(expect.arrayContaining(['mr', 'list', '--source-branch', 'loom/fix-login']));
    expect(machine.forgeCliCwds('glab')[at]).toBe(checkout);
  });
});

describe('the link following the branch', () => {
  it('moves to the new branch’s Merge request, and goes when the branch has none', async () => {
    const { machine, checkout, forge } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login' }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 12));

    git(checkout, 'checkout', '--quiet', '-b', 'loom/other');
    forge([
      { number: 12, url: pr(12), branch: 'loom/fix-login' },
      { number: 13, url: pr(13), branch: 'loom/other' },
    ]);
    await main.api.invoke('sessions.send', { id, prompt: 'Now the other one' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 13));

    git(checkout, 'checkout', '--quiet', '-b', 'loom/third');
    await main.api.invoke('sessions.send', { id, prompt: 'And a third' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.branch === 'loom/third' && !s.mergeRequest));

    const items = await waitFor(main.api, 'transcript', (list) => cards(list).length === 2, { sessionId: id });
    expect(cards(items).map((c) => c.kind === 'merge-request' && c.number)).toEqual([12, 13]);
  });

  it('stays while the branch does, even when no open Merge request is found on it any more', async () => {
    const { machine, checkout, forge } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login' }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 12));
    const lookups = () => machine.forgeCliInvocations('gh').filter((args) => args[0] === 'pr' && args[1] === 'list').length;
    const before = lookups();

    forge([{ number: 12, url: pr(12), branch: 'loom/fix-login', state: 'merged' }]);
    await main.api.invoke('sessions.send', { id, prompt: 'Anything else?' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    const deadline = Date.now() + 5000;
    while (lookups() === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.mergeRequest).toEqual({ number: 12, url: pr(12) });
  });

  it('never links on the default branch, nor asks the Forge', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { branch: 'main', mergeRequests: [{ number: 5, url: pr(5), branch: 'main' }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.mergeRequest).toBeUndefined();
    expect(machine.forgeCliInvocations('gh').filter((args) => args[0] === 'pr')).toEqual([]);
    await expect(main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: '5' })).rejects.toThrow('This Session is on main, the default branch, which has no Merge request.');
  });
});

describe('Link Merge request, by hand', () => {
  const others: MergeRequests = [
    { number: 40, url: pr(40), branch: 'someone/fork-branch' },
    { number: 41, url: pr(41), branch: 'old', state: 'closed' },
  ];

  it('links an open Merge request by number or URL, checked on the Forge, and keeps it after the next turn', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { mergeRequests: others });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    await main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: `${pr(40)}/files` });
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.mergeRequest).toEqual({ number: 40, url: pr(40) });
    expect(machine.forgeCliInvocations('gh').find((args) => args[1] === 'view')).toEqual(expect.arrayContaining(['pr', 'view', '40', '--repo', 'github.com/theholocoder/loom']));

    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.mergeRequest).toEqual({ number: 40, url: pr(40) });
    expect(cards((await waitFor(main.api, 'transcript', () => true, { sessionId: id })))).toEqual([{ kind: 'merge-request', id: expect.any(Number), number: 40, url: pr(40) }]);
  });

  it('refuses a Merge request the Forge lacks, a closed one, and one of another repository', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { mergeRequests: others });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    await expect(main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: '#99' })).rejects.toThrow('gh pr view exited with code 1');
    await expect(main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: '!41' })).rejects.toThrow('That Merge request is closed: only an open one can be linked.');
    await expect(main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: 'https://github.com/someone/else/pull/40' })).rejects.toThrow("isn't a Merge request of this Project's repository");
    await expect(main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: 'the one from yesterday' })).rejects.toThrow('Name a Merge request by its number');
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.mergeRequest).toBeUndefined();
  });
});

describe("the Merge request Panel's read of it", () => {
  it('reads its state, branches, commits, changes, checks and everyone\'s reviews and comments from GitHub', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, {
      mergeRequests: [
        {
          number: 12,
          url: pr(12),
          branch: 'loom/fix-login',
          title: 'Fix the login bug',
          draft: true,
          author: 'octocat',
          commits: 3,
          additions: 67,
          deletions: 1,
          changedFiles: 3,
          checks: [
            { id: 1, name: 'test', conclusion: 'FAILURE', url: 'https://ci/1' },
            { id: 2, name: 'lint', conclusion: 'SUCCESS' },
          ],
          reviews: [
            { id: 1, author: 'alice', state: 'CHANGES_REQUESTED', body: 'Needs **work**', url: `${pr(12)}#r1`, submittedAt: '2026-11-01T10:00:00Z', comments: [{ path: 'src/a.ts', line: 3, body: 'Off by one', url: `${pr(12)}#c1`, createdAt: '2026-11-01T10:00:00Z' }] },
            // A draft review, and an empty one holding only a reply elsewhere, aren't shown.
            { id: 2, author: 'octocat', state: 'PENDING', body: 'Draft', url: `${pr(12)}#r2` },
            { id: 3, author: 'bob', state: 'COMMENTED', url: `${pr(12)}#r3` },
            { id: 4, author: 'octocat', state: 'COMMENTED', body: 'Done', url: `${pr(12)}#r4` },
          ],
          comments: [{ id: 5, author: 'carol', body: 'Ship it', url: `${pr(12)}#c5`, createdAt: '2026-11-01T11:00:00Z' }],
        },
      ],
    });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 12));

    expect(await main.api.invoke('sessions.mergeRequest', { id })).toEqual({
      number: 12,
      url: pr(12),
      title: 'Fix the login bug',
      state: 'open',
      draft: true,
      sourceBranch: 'loom/fix-login',
      targetBranch: 'main',
      author: 'octocat',
      commits: 3,
      files: 3,
      added: 67,
      removed: 1,
      ci: 'failed',
      checks: [
        { name: 'test', state: 'failed', url: 'https://ci/1' },
        { name: 'lint', state: 'passed' },
      ],
      reviews: [
        {
          author: 'alice',
          verdict: 'changes-requested',
          body: 'Needs **work**',
          at: Date.parse('2026-11-01T10:00:00Z'),
          url: `${pr(12)}#r1`,
          comments: [{ author: 'alice', body: 'Off by one', path: 'src/a.ts', line: 3, at: Date.parse('2026-11-01T10:00:00Z'), url: `${pr(12)}#c1` }],
        },
        { author: 'octocat', verdict: 'commented', body: 'Done', url: `${pr(12)}#r4`, comments: [] },
      ],
      comments: [{ author: 'carol', body: 'Ship it', at: Date.parse('2026-11-01T11:00:00Z'), url: `${pr(12)}#c5` }],
    });
    const query = machine.forgeCliInvocations('gh').findLast((args) => args[1] === 'graphql')!;
    expect(query).toEqual(expect.arrayContaining(['--hostname', 'github.com', 'owner=theholocoder', 'name=loom', 'number=12']));
  });

  it('reads it from GitLab through glab, in the working copy, approvals as its reviews', async () => {
    const { machine, checkout } = machineOn('glab', GITLAB, {
      mergeRequests: [
        {
          number: 87,
          url: mr(87),
          branch: 'loom/fix-login',
          title: 'Fix the login bug',
          author: 'dave',
          target: 'develop',
          commits: 2,
          diffs: [
            { new_path: 'lib/a.rb', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n+more\n context' },
            { new_path: 'lib/b.rb', diff: '@@ -1 +0,0 @@\n-gone' },
          ],
          pipeline: { id: 77, status: 'success', jobs: [{ id: 1, name: 'rspec', status: 'success', url: 'https://ci/1' }] },
          approvedBy: ['erin'],
          comments: [
            { id: 1, author: 'erin', body: 'On the code', path: 'lib/a.rb', line: 2, createdAt: '2026-11-01T10:00:00Z' },
            { id: 2, author: 'gitlab', body: 'added 1 commit', system: true },
          ],
        },
      ],
    });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 87));

    expect(await main.api.invoke('sessions.mergeRequest', { id })).toEqual({
      number: 87,
      url: mr(87),
      title: 'Fix the login bug',
      state: 'open',
      draft: false,
      sourceBranch: 'loom/fix-login',
      targetBranch: 'develop',
      author: 'dave',
      commits: 2,
      files: 2,
      added: 2,
      removed: 2,
      ci: 'passed',
      checks: [{ name: 'rspec', state: 'passed', url: 'https://ci/1' }],
      reviews: [{ author: 'erin', verdict: 'approved', body: '', url: mr(87), comments: [] }],
      comments: [{ author: 'erin', body: 'On the code', path: 'lib/a.rb', line: 2, at: Date.parse('2026-11-01T10:00:00Z'), url: `${mr(87)}#note_1` }],
    });
    const at = machine.forgeCliInvocations('glab').findLastIndex((args) => args[0] === 'api' && /\/diffs/.test(args[1]!));
    expect(machine.forgeCliCwds('glab')[at]).toBe(checkout);
  });

  it('rejects a Session with no Merge request, and says why the Forge could not answer', async () => {
    const { machine, checkout, forge } = machineOn('gh', GITHUB, { mergeRequests: [] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    await expect(main.api.invoke('sessions.mergeRequest', { id })).rejects.toThrow('This Session has no Merge request.');

    forge([{ number: 12, url: pr(12), branch: 'loom/fix-login' }]);
    await main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: '12' });
    forge([]);
    await expect(main.api.invoke('sessions.mergeRequest', { id })).rejects.toThrow('GitHub has no pull request #12 in theholocoder/loom.');
  });
});

describe("the agent's Link merge request tool", () => {
  it("is Loom's MCP server, the bridge run as `mcp`, given to the agent's session", async () => {
    const { machine, checkout } = machineOn('gh', GITHUB);
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    const created = machine.acpMessages().find((m) => m.message.method === 'session/new')!;
    expect(created.message.params!.mcpServers).toEqual([{ name: 'loom', command: expect.stringMatching(/loom-bridge/), args: ['mcp'], env: [] }]);
  });

  it('links the Merge request the agent names when it calls the tool', async () => {
    const call = { toolCallId: 'call_link', title: 'loom_link_merge_request', kind: 'other' };
    const { machine, checkout } = machineOn('gh', GITHUB, {
      mergeRequests: [{ number: 40, url: pr(40), branch: 'someone/fork-branch' }],
      turns: [
        {
          chunks: [
            { update: { sessionUpdate: 'tool_call', ...call, status: 'pending', rawInput: { number: 40 } } },
            { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_link', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Loom links Merge request 40…' } }] } },
            'Linked it.',
          ],
        },
      ],
    });
    const { main, id } = await withSession(machine, checkout);

    const linked = await waitFor(main.api, 'sessions', session(id, (s) => !!s.mergeRequest));
    expect(linked.find((s) => s.id === id)!.mergeRequest).toEqual({ number: 40, url: pr(40) });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.mergeRequest).toEqual({ number: 40, url: pr(40) });
  });
});

describe('the Merge request action', () => {
  const prompts = (machine: Machine) =>
    machine
      .acpMessages()
      .filter((m) => m.message.method === 'session/prompt')
      .map((m) => (m.message.params?.prompt as Array<{ text: string }>)[0]!.text);

  it('asks the agent to open or update the Merge request with gh, queued while the Session is Working', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { turns: [{ chunks: ['Working.'], hold: 'first' }, { chunks: ['Opened.'] }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    await main.api.invoke('sessions.requestMergeRequest', { id });
    const canned = 'Open a Merge request for this branch with gh, or update it if one is already open: push the branch, then write its title and description from our conversation.';
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue?.map((m) => m.text)).toEqual([canned]);

    machine.release('first');
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Opened.'), { sessionId: id });
    expect(prompts(machine)).toEqual(['Fix the login bug', canned]);
  });
});

describe('review follow-ups', () => {
  const toolCall = (title: string, rawInput: Record<string, unknown>): AcpTurn['chunks'] => [
    { update: { sessionUpdate: 'tool_call', toolCallId: 'call_link', title, kind: 'other', status: 'pending', rawInput } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_link', status: 'completed' } },
    'Done.',
  ];

  it("shows why Loom couldn't link what the agent's tool named", async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 41, url: pr(41), branch: 'old', state: 'closed' }], turns: [{ chunks: toolCall('loom_link_merge_request', { number: 41 }) }] });
    const { main, id } = await withSession(machine, checkout);

    const items = await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'merge-request-refused'), { sessionId: id });
    expect(items.find((i) => i.kind === 'merge-request-refused')).toEqual({
      kind: 'merge-request-refused',
      id: expect.any(Number),
      mergeRequest: '41',
      reason: 'That Merge request is closed: only an open one can be linked.',
    });
  });

  it('keeps a Merge request the agent linked over the one found on the branch, and knows the mcp__loom__ name', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, {
      mergeRequests: [
        { number: 12, url: pr(12), branch: 'loom/fix-login' },
        { number: 40, url: pr(40), branch: 'someone/fork-branch' },
      ],
      turns: [{ chunks: toolCall('mcp__loom__link_merge_request', { url: pr(40) }) }, { chunks: ['Again.'] }],
    });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 40));

    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'agent' && i.text === 'Again.'), { sessionId: id });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.mergeRequest).toEqual({ number: 40, url: pr(40) });
  });

  it('looks up the Merge request after a turn the user stopped', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login' }], turns: [{ chunks: ['Pushing…'], hold: 'never' }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    await main.api.invoke('sessions.stop', { id });
    const linked = await waitFor(main.api, 'sessions', session(id, (s) => !!s.mergeRequest));
    expect(linked.find((s) => s.id === id)).toMatchObject({ waitingReason: 'stopped', mergeRequest: { number: 12, url: pr(12) } });
  });
});

describe('a found link on the same branch', () => {
  it('gives way to the next open Merge request found there, once the first is merged', async () => {
    const { machine, checkout, forge } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 5, url: pr(5), branch: 'loom/fix-login' }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 5));

    forge([
      { number: 5, url: pr(5), branch: 'loom/fix-login', state: 'merged' },
      { number: 9, url: pr(9), branch: 'loom/fix-login' },
    ]);
    await main.api.invoke('sessions.send', { id, prompt: 'Open a follow-up' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 9));
    const items = await waitFor(main.api, 'transcript', (list) => cards(list).length === 2, { sessionId: id });
    expect(cards(items).map((c) => c.kind === 'merge-request' && c.number)).toEqual([5, 9]);
  });
});
