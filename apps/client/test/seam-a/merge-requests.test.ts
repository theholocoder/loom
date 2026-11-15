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

    await expect(main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: '#99' })).rejects.toThrow(/^gh pr view failed: there's no such pull request\n\nDetails:\nGraphQL: Could not resolve to a PullRequest/);
    await expect(main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: '!41' })).rejects.toThrow('That Merge request is closed: only an open one can be linked.');
    await expect(main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: 'https://github.com/someone/else/pull/40' })).rejects.toThrow("isn't a Merge request of this Project's repository");
    await expect(main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: 'the one from yesterday' })).rejects.toThrow('Name a Merge request by its number');
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.mergeRequest).toBeUndefined();
  });
});

describe("the Merge request Panel's read of it", () => {
  it('reads its state, branches, description, reviewers, commits, changes, checks and everyone\'s reviews and comments from GitHub', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, {
      mergeRequests: [
        {
          number: 12,
          url: pr(12),
          branch: 'loom/fix-login',
          title: 'Fix the login bug',
          draft: true,
          author: 'octocat',
          description: '## What\n\n```mermaid\nflowchart LR\n  a --> b\n```',
          // Still asked: a user, a team, and alice again, who has reviewed since.
          reviewers: ['dave', 'acme/billing', 'alice'],
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
      head: 'commit-1',
      author: 'octocat',
      description: '## What\n\n```mermaid\nflowchart LR\n  a --> b\n```',
      // Those who reviewed, then those still asked to; the author replying to a thread isn't one.
      reviewers: ['alice', 'dave', 'acme/billing'],
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

  it('reads it from GitLab through glab, in the working copy, approvals and reviewers asking for changes as its reviews, and approvers among its reviewers', async () => {
    const { machine, checkout } = machineOn('glab', GITLAB, {
      mergeRequests: [
        {
          number: 87,
          url: mr(87),
          branch: 'loom/fix-login',
          title: 'Fix the login bug',
          author: 'dave',
          description: 'Fixes the **login**.',
          reviewers: ['frank', 'erin'],
          requestedChanges: ['frank'],
          target: 'develop',
          commits: 2,
          diffs: [
            { new_path: 'lib/a.rb', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n+more\n context' },
            { new_path: 'lib/b.rb', diff: '@@ -1 +0,0 @@\n-gone' },
          ],
          pipeline: { id: 77, status: 'success', jobs: [{ id: 1, name: 'rspec', status: 'success', url: 'https://ci/1' }] },
          approvedBy: ['erin', 'grace'],
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
      head: 'commit-1',
      author: 'dave',
      description: 'Fixes the **login**.',
      reviewers: ['frank', 'erin', 'grace'],
      commits: 2,
      files: 2,
      added: 2,
      removed: 2,
      ci: 'passed',
      checks: [{ name: 'rspec', state: 'passed', url: 'https://ci/1' }],
      reviews: [
        { author: 'erin', verdict: 'approved', body: '', url: mr(87), comments: [] },
        { author: 'grace', verdict: 'approved', body: '', url: mr(87), comments: [] },
        { author: 'frank', verdict: 'changes-requested', body: '', url: mr(87), comments: [] },
      ],
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

describe('Squash and merge, from the Merge request Panel', () => {
  const endedCards = (items: TranscriptItem[]) => items.filter((i) => i.kind === 'merge-request-ended');

  it('squashes and merges the pull request with gh into one commit titled as the user confirmed, only at the head they saw; Babysit then archives the Session', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login', title: 'Fix the login bug', oid: 'abc123' }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 12 && s.status === 'waiting'));
    expect((await main.api.invoke('sessions.mergeRequest', { id })).head).toBe('abc123');

    // The title is one line, however it was typed.
    expect(await main.api.invoke('sessions.squashAndMerge', { id, title: '  Fix the login bug\n (#12) ', head: 'abc123' })).toEqual({ state: 'merged' });
    const merge = machine.forgeCliInvocations('gh').find((args) => args[0] === 'pr' && args[1] === 'merge');
    expect(merge).toEqual(['pr', 'merge', '12', '--repo', 'github.com/theholocoder/loom', '--squash', '--subject', 'Fix the login bug (#12)', '--match-head-commit', 'abc123']);

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'archived' && s.mergeRequestState === 'merged'));
    const items = await waitFor(main.api, 'transcript', (list) => endedCards(list).length > 0, { sessionId: id });
    expect(endedCards(items)).toEqual([{ kind: 'merge-request-ended', id: expect.any(Number), number: 12, url: pr(12), state: 'merged', archived: true }]);
  });

  it("refuses when the branch moved since, when the Forge won't merge it, and without a title, leaving it open", async () => {
    const { machine, checkout, forge } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login', oid: 'new-push' }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 12 && s.status === 'waiting'));

    await expect(main.api.invoke('sessions.squashAndMerge', { id, title: 'Fix it', head: 'abc123' })).rejects.toThrow('Head branch was modified. Review and try the merge again.');
    forge([{ number: 12, url: pr(12), branch: 'loom/fix-login', mergeRefusal: 'X Pull request theholocoder/loom#12 is not mergeable: the base branch policy prohibits the merge.' }]);
    await expect(main.api.invoke('sessions.squashAndMerge', { id, title: 'Fix it', head: 'commit-1' })).rejects.toThrow('is not mergeable: the base branch policy prohibits the merge.');
    await expect(main.api.invoke('sessions.squashAndMerge', { id, title: ' \n ', head: 'commit-1' })).rejects.toThrow('The squash commit needs a title.');

    const now = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect([now.status, now.mergeRequestState]).toEqual(['waiting', 'open']);
    expect(machine.forgeCliInvocations('gh').filter((args) => args[1] === 'merge')).toHaveLength(2);
  });

  it('says it is still open when the Forge merges it later, as a merge queue does', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login', mergeLater: true }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 12 && s.status === 'waiting'));

    expect(await main.api.invoke('sessions.squashAndMerge', { id, title: 'Fix it', head: 'commit-1' })).toEqual({ state: 'open' });
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.status).toBe('waiting');
  });

  it('merges on GitLab through glab, in the working copy; with Babysit off, it records the merge and leaves the Session as it is', async () => {
    const { machine, checkout } = machineOn('glab', GITLAB, { mergeRequests: [{ number: 87, url: mr(87), branch: 'loom/fix-login', oid: 'def456' }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 87 && s.status === 'waiting'));
    expect((await main.api.invoke('sessions.mergeRequest', { id })).head).toBe('def456');
    await main.api.invoke('sessions.setBabysitting', { id, on: false });

    expect(await main.api.invoke('sessions.squashAndMerge', { id, title: 'Fix the login bug', head: 'def456' })).toEqual({ state: 'merged' });
    const at = machine.forgeCliInvocations('glab').findIndex((args) => args[0] === 'mr' && args[1] === 'merge');
    expect(machine.forgeCliInvocations('glab')[at]).toEqual(['mr', 'merge', '87', '--squash', '--squash-message', 'Fix the login bug', '--sha', 'def456', '--yes']);
    expect(machine.forgeCliCwds('glab')[at]).toBe(checkout);

    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequestState === 'merged'));
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.status).toBe('waiting');
  });

  it('refuses an archived Session', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login' }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 12 && s.status === 'waiting'));
    await main.api.invoke('sessions.archive', { id });

    await expect(main.api.invoke('sessions.squashAndMerge', { id, title: 'Fix it', head: 'commit-1' })).rejects.toThrow('This Session is archived.');
    expect(machine.forgeCliInvocations('gh').some((args) => args[1] === 'merge')).toBe(false);
  });
});

describe("the Merge request Panel's Diff tab", () => {
  it('reads each file of the pull request from GitHub with its patch, under the headers git would give it', async () => {
    const { machine, checkout } = machineOn('gh', GITHUB, {
      mergeRequests: [
        {
          number: 12,
          url: pr(12),
          branch: 'loom/fix-login',
          files: [
            { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n-old\n+new\n context' },
            { filename: 'src/new.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+fresh' },
            { filename: 'src/gone.ts', status: 'removed', additions: 0, deletions: 1, patch: '@@ -1 +0,0 @@\n-gone' },
            { filename: 'src/moved.ts', previous_filename: 'src/was.ts', status: 'renamed', additions: 0, deletions: 0 },
            // No patch: binary, when it changes no line; too large to show, when it does.
            { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
            { filename: 'pnpm-lock.yaml', status: 'modified', additions: 30000, deletions: 2 },
          ],
        },
      ],
    });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 12));

    expect(await main.api.invoke('sessions.mergeRequestDiff', { id })).toEqual({
      files: [
        { path: 'src/a.ts', status: 'committed', added: 1, removed: 1, binary: false, truncated: false, text: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n' },
        { path: 'src/new.ts', status: 'committed', added: 1, removed: 0, binary: false, truncated: false, text: 'diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+fresh\n' },
        { path: 'src/gone.ts', status: 'committed', change: 'deleted', added: 0, removed: 1, binary: false, truncated: false, text: 'diff --git a/src/gone.ts b/src/gone.ts\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n' },
        { path: 'src/moved.ts', oldPath: 'src/was.ts', status: 'committed', change: 'renamed', added: 0, removed: 0, binary: false, truncated: false, text: 'diff --git a/src/was.ts b/src/moved.ts\n--- a/src/was.ts\n+++ b/src/moved.ts\n' },
        { path: 'logo.png', status: 'committed', added: 0, removed: 0, binary: true, truncated: false, text: '' },
        { path: 'pnpm-lock.yaml', status: 'committed', added: 30000, removed: 2, binary: false, truncated: true, text: '' },
      ],
    });
    const call = machine.forgeCliInvocations('gh').findLast((args) => args[0] === 'api' && args.some((a) => a.includes('/files')));
    expect(call).toEqual(['api', '--hostname', 'github.com', 'repos/theholocoder/loom/pulls/12/files?per_page=100']);
  });

  it('reads it from GitLab through glab, in the working copy', async () => {
    const { machine, checkout } = machineOn('glab', GITLAB, {
      mergeRequests: [
        {
          number: 87,
          url: mr(87),
          branch: 'loom/fix-login',
          diffs: [
            { old_path: 'lib/a.rb', new_path: 'lib/a.rb', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n+more\n context\n' },
            { old_path: 'lib/old.rb', new_path: 'lib/b.rb', renamed_file: true, diff: '' },
            { old_path: 'lib/c.rb', new_path: 'lib/c.rb', new_file: true, diff: '@@ -0,0 +1 @@\n+c\n' },
            { old_path: 'big.sql', new_path: 'big.sql', diff: '', too_large: true },
          ],
        },
      ],
    });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 87));

    expect(await main.api.invoke('sessions.mergeRequestDiff', { id })).toEqual({
      files: [
        { path: 'lib/a.rb', status: 'committed', added: 2, removed: 1, binary: false, truncated: false, text: 'diff --git a/lib/a.rb b/lib/a.rb\n--- a/lib/a.rb\n+++ b/lib/a.rb\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n context\n' },
        { path: 'lib/b.rb', oldPath: 'lib/old.rb', status: 'committed', change: 'renamed', added: 0, removed: 0, binary: false, truncated: false, text: 'diff --git a/lib/old.rb b/lib/b.rb\n--- a/lib/old.rb\n+++ b/lib/b.rb\n' },
        { path: 'lib/c.rb', status: 'committed', added: 1, removed: 0, binary: false, truncated: false, text: 'diff --git a/lib/c.rb b/lib/c.rb\n--- /dev/null\n+++ b/lib/c.rb\n@@ -0,0 +1 @@\n+c\n' },
        { path: 'big.sql', status: 'committed', added: 0, removed: 0, binary: false, truncated: true, text: '' },
      ],
    });
    const at = machine.forgeCliInvocations('glab').findLastIndex((args) => args[0] === 'api' && /\/merge_requests\/87\/diffs\?per_page=100$/.test(args[1]!));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(machine.forgeCliCwds('glab')[at]).toBe(checkout);
  });

  it('says there are more files when the Forge lists as many as it lists at once, and why it could not read them', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n a\n+b' }));
    const { machine, checkout, forge } = machineOn('gh', GITHUB, { mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login', files }] });
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'sessions', session(id, (s) => s.mergeRequest?.number === 12));
    const diff = await main.api.invoke('sessions.mergeRequestDiff', { id });
    expect(diff.files).toHaveLength(100);
    expect(diff.moreFiles).toBe(true);

    forge([]);
    await expect(main.api.invoke('sessions.mergeRequestDiff', { id })).rejects.toThrow('Not Found (HTTP 404)');
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
