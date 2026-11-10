import { describe, expect, it } from 'vitest';
import { git, startMain, tempDir, tempMachine, waitFor, type AcpTurn, type ForgeCli, type ForgeCliScript, type Machine, type MainHarness } from './harness';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];
const GITHUB = 'https://github.com/theholocoder/loom.git';
const GITLAB = 'git@gitlab.example.org:acme/loom.git';
const URLS = { gh: 'https://github.com/theholocoder/loom/pull/12', glab: 'https://gitlab.example.org/acme/loom/-/merge_requests/12' };
const BRANCH = 'loom/fix-login';

const MINUTE = 60_000;
const QUIET_WINDOW = 2 * MINUTE;

type Scripted = NonNullable<ForgeCliScript['mergeRequests']>[number];
type Activity = Omit<Scripted, 'number' | 'url' | 'branch'>;
type Extras = Pick<ForgeCliScript, 'viewer' | 'offline'>;

/** Main with one Session whose Merge request 12 is linked and has had its baseline poll, over `initial` activity. */
async function babysat(cli: ForgeCli, initial: Activity = {}, { turns = [], userDataDir }: { turns?: AcpTurn[]; userDataDir?: string } = {}) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  const host = cli === 'gh' ? 'github.com' : 'gitlab.example.org';
  const base: ForgeCliScript = { signedInHosts: [host] };
  if (cli === 'glab') base.repoView = { stdout: { path_with_namespace: 'acme/loom', web_url: 'https://gitlab.example.org/acme/loom' } };
  const forge = (activity: Activity, extras: Extras = {}) => machine.installForgeCli(cli, { ...base, ...extras, mergeRequests: [{ number: 12, url: URLS[cli], branch: BRANCH, ...activity }] });
  forge(initial);
  const checkout = machine.gitRepo('loom', { origin: cli === 'gh' ? GITHUB : GITLAB });
  git(checkout, 'checkout', '--quiet', '-b', 'main');
  machine.commit(checkout, 'README.md', '# loom\n');
  git(checkout, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(checkout, 'checkout', '--quiet', '-b', BRANCH);

  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  await waitFor(main.api, 'projects', (list) => list.some((p) => p.id === project.id && p.forge.state === 'available'));
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
  await waitFor(main.api, 'sessions', (list) => list.some((s) => s.id === id && !!s.mergeRequest && s.status === 'waiting' && s.babysit?.lastPollAt !== undefined));
  return { machine, main, id, forge, checkout, projectId: project.id };
}

const sessionOf = (list: Session[], id: number) => list.find((s) => s.id === id)!;

/** Moves the clock `ms` on and waits for the poll that falls due there to land. */
async function pollAfter(main: MainHarness, id: number, ms: number) {
  await main.elapse(ms);
  const at = main.clock.now();
  await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit!.lastPollAt === at);
}

const feedbackCards = (items: TranscriptItem[]) => items.filter((i): i is Extract<TranscriptItem, { kind: 'feedback' }> => i.kind === 'feedback');
const cardsOf = async (main: MainHarness, id: number) => feedbackCards(await waitFor(main.api, 'transcript', () => true, { sessionId: id }));
const nextCard = async (main: MainHarness, id: number, count = 1) => feedbackCards(await waitFor(main.api, 'transcript', (items) => feedbackCards(items).length >= count, { sessionId: id })).at(count - 1)!;

describe('Babysit on GitHub', () => {
  it('treats what was there at link time as seen, and wakes the Session for a new comment after the quiet window', async () => {
    const { main, id, forge } = await babysat('gh', { comments: [{ id: 1, author: 'alice', body: 'Old news', url: `${URLS.gh}#c1` }] });
    expect(await cardsOf(main, id)).toEqual([]);

    forge({ comments: [{ id: 1, author: 'alice', body: 'Old news', url: `${URLS.gh}#c1` }, { id: 2, author: 'bob', body: 'Please add a test', url: `${URLS.gh}#c2` }] });
    await pollAfter(main, id, 3 * MINUTE);
    expect(await cardsOf(main, id)).toEqual([]);
    expect(sessionOf(await main.api.invoke('sessions.list'), id).waitingReason).toBe('finished');

    await main.elapse(QUIET_WINDOW);
    const card = await nextCard(main, id);
    expect(card).toEqual({ kind: 'feedback', id: card.id, number: 12, url: URLS.gh, state: 'new', items: [{ kind: 'comment', author: 'bob', excerpt: 'Please add a test', url: `${URLS.gh}#c2` }] });
    const session = await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).waitingReason === 'feedback');
    expect(sessionOf(session, id)).toMatchObject({ status: 'waiting', unread: true });
  });
});

/** Asks for a poll now, as the window gaining focus does, and waits for it to land. */
async function pollNow(main: MainHarness, id: number) {
  await main.elapse(1000);
  const at = main.clock.now();
  await main.api.invoke('sessions.check');
  await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit!.lastPollAt === at);
}

const infoCards = (items: TranscriptItem[]) => items.filter((i) => i.kind === 'feedback-info');
const graphql = (machine: Machine) => machine.forgeCliInvocations('gh').filter((args) => args[0] === 'api' && args[1] === 'graphql');
const prompts = (machine: Machine) =>
  machine
    .acpMessages()
    .filter((m) => m.message.method === 'session/prompt')
    .map((m) => (m.message.params?.prompt as Array<{ text: string }>)[0]!.text);

describe('what counts as feedback', () => {
  it("ignores the user's own comments and counts bots", async () => {
    const { main, id, forge } = await babysat('gh');
    forge({ comments: [{ id: 1, author: 'OctoCat', body: 'Pushed a fix', url: `${URLS.gh}#c1` }, { id: 2, author: 'codecov', body: 'Coverage fell', url: `${URLS.gh}#c2` }] });
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);

    expect((await nextCard(main, id)).items).toEqual([{ kind: 'comment', author: 'codecov', excerpt: 'Coverage fell', url: `${URLS.gh}#c2` }]);
  });

  it('makes one item of a review and its inline comments', async () => {
    const { main, id, forge } = await babysat('gh');
    const url = `${URLS.gh}#r1`;
    forge({ reviews: [{ id: 1, author: 'alice', state: 'CHANGES_REQUESTED', body: 'Needs work', url, comments: [{ path: 'src/a.ts', line: 10, body: 'Off by one', url: `${url}-a` }, { path: 'src/b.ts', originalLine: 4, body: 'Rename', url: `${url}-b` }] }] });
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);

    expect((await nextCard(main, id)).items).toEqual([
      { kind: 'review', author: 'alice', verdict: 'changes-requested', excerpt: 'Needs work', url, comments: [{ path: 'src/a.ts', line: 10, excerpt: 'Off by one', url: `${url}-a` }, { path: 'src/b.ts', line: 4, excerpt: 'Rename', url: `${url}-b` }] },
    ]);
  });

  it('shows an approval as an info card, without waking the Session', async () => {
    const { main, id, forge } = await babysat('gh');
    forge({ reviews: [{ id: 1, author: 'alice', state: 'APPROVED', url: `${URLS.gh}#r1` }] });
    await pollNow(main, id);

    const items = await waitFor(main.api, 'transcript', (list) => infoCards(list).length === 1, { sessionId: id });
    expect(infoCards(items)).toEqual([{ kind: 'feedback-info', id: expect.any(Number), event: 'approved', author: 'alice', url: `${URLS.gh}#r1` }]);
    await main.elapse(QUIET_WINDOW);
    expect(sessionOf(await main.api.invoke('sessions.list'), id).waitingReason).toBe('finished');
    expect(await cardsOf(main, id)).toEqual([]);
  });

  it('counts failing checks and conflicts that were there at link time, but not a green CI', async () => {
    const { main, id } = await babysat('gh', { conflicts: true, checks: [{ id: 7, name: 'test', conclusion: 'FAILURE', url: 'https://ci/7' }, { id: 8, name: 'lint', conclusion: 'SUCCESS' }] });
    await main.elapse(QUIET_WINDOW);

    expect((await nextCard(main, id)).items).toEqual([{ kind: 'ci-failed', checks: [{ name: 'test', url: 'https://ci/7' }] }, { kind: 'conflicts' }]);
    expect(infoCards(await waitFor(main.api, 'transcript', () => true, { sessionId: id }))).toEqual([]);
  });

  it('reports a conflict once, and again if it comes back after being resolved', async () => {
    const { main, id, forge } = await babysat('gh', { conflicts: false });
    forge({ conflicts: true });
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);
    await nextCard(main, id);
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);
    expect(await cardsOf(main, id)).toHaveLength(1);

    forge({ conflicts: false });
    await pollNow(main, id);
    forge({ conflicts: true });
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);
    expect((await nextCard(main, id, 2)).items).toEqual([{ kind: 'conflicts' }]);
  });
});

describe('the polling rhythm and CI', () => {
  it('polls every 3 minutes with no CI pending, every minute while some is, and reports CI only once it has all finished', async () => {
    const running = { id: 2, name: 'e2e', status: 'IN_PROGRESS' };
    const failed = { id: 1, name: 'unit', conclusion: 'FAILURE', url: 'https://ci/1' };
    const { machine, main, id, forge } = await babysat('gh');

    const before = graphql(machine).length;
    await main.elapse(MINUTE);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(graphql(machine)).toHaveLength(before);

    forge({ checks: [failed, running] });
    await pollAfter(main, id, 2 * MINUTE);
    expect(sessionOf(await main.api.invoke('sessions.list'), id).babysit!.ci).toBe('pending');
    await main.elapse(QUIET_WINDOW);
    expect(await cardsOf(main, id)).toEqual([]);

    forge({ checks: [failed, { ...running, status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await main.api.invoke('sessions.check');
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit!.ci === 'failed');
    await main.elapse(QUIET_WINDOW);
    const card = await nextCard(main, id);
    expect(card.items).toEqual([{ kind: 'ci-failed', checks: [{ name: 'unit', url: 'https://ci/1' }] }]);
    expect(card.ci).toBe('failed');
  });

  it('polls a minute after a poll that saw CI pending', async () => {
    const { main, id } = await babysat('gh', { checks: [{ id: 2, name: 'e2e', status: 'QUEUED' }] });
    await pollAfter(main, id, MINUTE);
    expect(sessionOf(await main.api.invoke('sessions.list'), id).babysit!.ci).toBe('pending');
  });

  it('counts CI as pending while GitHub does, even with every check it lists finished', async () => {
    const { main, id } = await babysat('gh', { rollupState: 'PENDING', checks: [{ id: 1, name: 'unit', conclusion: 'FAILURE' }] });
    expect(sessionOf(await main.api.invoke('sessions.list'), id).babysit!.ci).toBe('pending');
    await main.elapse(QUIET_WINDOW);
    expect(await cardsOf(main, id)).toEqual([]);
  });

  it('reports a re-run that fails again, and a green card when one finally passes', async () => {
    const failing = (job: number) => ({ pipeline: { id: 77, status: 'failed', failedJobs: [{ id: job, name: 'rspec', url: `https://ci/${job}` }] } });
    const { main, id, forge } = await babysat('glab', failing(501));
    await main.elapse(QUIET_WINDOW);
    await nextCard(main, id);

    forge(failing(502));
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);
    expect((await nextCard(main, id, 2)).items).toEqual([{ kind: 'ci-failed', checks: [{ name: 'rspec', url: 'https://ci/502' }] }]);

    forge({ pipeline: { id: 77, status: 'success' } });
    await pollNow(main, id);
    const items = await waitFor(main.api, 'transcript', (list) => infoCards(list).length === 1, { sessionId: id });
    expect(infoCards(items)).toEqual([{ kind: 'feedback-info', id: expect.any(Number), event: 'ci-passed', url: URLS.glab }]);
  });

  it('shows a green CI as an info card, once', async () => {
    const { main, id, forge } = await babysat('gh', { checks: [{ id: 2, name: 'e2e', status: 'IN_PROGRESS' }] });
    forge({ checks: [{ id: 2, name: 'e2e', conclusion: 'SUCCESS' }] });
    await pollAfter(main, id, MINUTE);
    await pollNow(main, id);

    const items = await waitFor(main.api, 'transcript', (list) => infoCards(list).length > 0, { sessionId: id });
    expect(infoCards(items)).toEqual([{ kind: 'feedback-info', id: expect.any(Number), event: 'ci-passed', url: URLS.gh }]);
    expect(sessionOf(await main.api.invoke('sessions.list'), id).waitingReason).toBe('finished');
  });
});

describe('batching', () => {
  it('restarts the quiet window with each new item, and gives one card', async () => {
    const pending = { id: 2, name: 'e2e', status: 'IN_PROGRESS' };
    const comment = (n: number) => ({ id: n, author: 'bob', body: `Note ${n}`, url: `${URLS.gh}#c${n}` });
    const { main, id, forge } = await babysat('gh', { checks: [pending] });

    forge({ checks: [pending], comments: [comment(1)] });
    await pollAfter(main, id, MINUTE);
    forge({ checks: [pending], comments: [comment(1), comment(2)] });
    await pollAfter(main, id, MINUTE);
    await pollAfter(main, id, MINUTE);
    expect(await cardsOf(main, id)).toEqual([]);

    await main.elapse(MINUTE);
    const card = await nextCard(main, id);
    expect(card.items.map((i) => i.kind === 'comment' && i.excerpt)).toEqual(['Note 1', 'Note 2']);
    expect(await cardsOf(main, id)).toHaveLength(1);
  });

  it('holds feedback while the agent works, and gives it once the run has settled', async () => {
    const { machine, main, id, forge } = await babysat('gh', {}, { turns: [{ chunks: ['Done.'] }, { chunks: ['Working.'], hold: 'second' }] });
    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Working.'), { sessionId: id });

    forge({ comments: [{ id: 1, author: 'bob', body: 'Hello', url: `${URLS.gh}#c1` }] });
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionOf(await main.api.invoke('sessions.list'), id).status).toBe('working');
    expect(await cardsOf(main, id)).toEqual([]);

    machine.release('second');
    await nextCard(main, id);
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).waitingReason === 'feedback');
  });
});

describe('a failed poll', () => {
  it('shows only as stale, and clears with the next poll that works', async () => {
    const { main, id, forge } = await babysat('gh');
    forge({}, { offline: true });
    await main.elapse(3 * MINUTE);
    const stale = await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit!.stale);
    expect(sessionOf(stale, id)).toMatchObject({ status: 'waiting', waitingReason: 'finished' });
    expect(await cardsOf(main, id)).toEqual([]);

    forge({});
    await main.elapse(3 * MINUTE);
    await waitFor(main.api, 'sessions', (list) => !sessionOf(list, id).babysit!.stale);
  });
});

describe('Babysit state', () => {
  it('survives a restart: what was seen stays seen, and what was waiting is still told', async () => {
    const seen = { id: 1, author: 'bob', body: 'Old', url: `${URLS.gh}#c1` };
    const fresh = { id: 2, author: 'bob', body: 'New', url: `${URLS.gh}#c2` };
    const { machine, main, id, forge } = await babysat('gh', { comments: [seen] }, { userDataDir: tempDir('loom-babysit-') });
    forge({ comments: [seen, fresh] });
    await pollNow(main, id);
    await main.close();

    const again = await startMain({ machine, userDataDir: main.userDataDir, now: main.clock.now() });
    await waitFor(again.api, 'environments', ready);
    await waitFor(again.api, 'sessions', (list) => sessionOf(list, id).babysit?.lastPollAt === again.clock.now());
    await again.elapse(QUIET_WINDOW);

    expect((await nextCard(again, id)).items).toEqual([{ kind: 'comment', author: 'bob', excerpt: 'New', url: `${URLS.gh}#c2` }]);
    expect(await cardsOf(again, id)).toHaveLength(1);
  });
});

describe('a Merge request no longer open', () => {
  it('records its state and stops being polled', async () => {
    const { machine, main, id, forge } = await babysat('gh');
    forge({ state: 'merged' });
    await pollNow(main, id);
    expect(sessionOf(await main.api.invoke('sessions.list'), id).mergeRequestState).toBe('merged');

    const before = graphql(machine).length;
    await main.elapse(10 * MINUTE);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(graphql(machine)).toHaveLength(before);
  });
});

describe('Send to agent', () => {
  it('sends one message with everything on the card, and only once', async () => {
    const { machine, main, id, forge } = await babysat('gh', {}, { turns: [{ chunks: ['Done.'] }, { chunks: ['Fixed.'] }] });
    forge({
      conflicts: true,
      comments: [{ id: 1, author: 'bob', body: 'Please\n\nadd a test', url: `${URLS.gh}#c1` }],
      reviews: [{ id: 2, author: 'alice', state: 'CHANGES_REQUESTED', body: 'Needs work', url: `${URLS.gh}#r2`, comments: [{ path: 'src/a.ts', line: 10, body: 'Off by one', url: `${URLS.gh}#r2a` }] }],
      checks: [{ id: 3, name: 'unit', conclusion: 'FAILURE', url: 'https://ci/3' }],
    });
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);
    const card = await nextCard(main, id);

    await main.api.invoke('sessions.sendFeedback', { id, itemId: card.id });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Fixed.'), { sessionId: id });
    expect(prompts(machine).at(-1)).toBe(
      [
        `There is new feedback on this Session's Merge request (${URLS.gh}):`,
        '',
        `1. Review by alice, who requested changes: "Needs work" (${URLS.gh}#r2)`,
        `   - src/a.ts:10: "Off by one" (${URLS.gh}#r2a)`,
        `2. Comment by bob: "Please add a test" (${URLS.gh}#c1)`,
        '3. CI failed:',
        '   - unit (https://ci/3)',
        '4. The Merge request has conflicts with its target branch.',
        '',
        'Fix what needs fixing, push the branch, and reply on the Merge request to what needs a reply.',
      ].join('\n'),
    );
    expect((await cardsOf(main, id))[0]!.state).toBe('sent');
    await expect(main.api.invoke('sessions.sendFeedback', { id, itemId: card.id })).rejects.toThrow('already been sent');
  });
});

describe('Babysit on GitLab', () => {
  it('reads notes, approvals, the pipeline and conflicts through glab, in the checkout', async () => {
    const pipeline = { id: 77, status: 'running' };
    const { machine, main, id, forge, checkout } = await babysat('glab', { pipeline, comments: [{ id: 1, author: 'carol', body: 'Seen', url: '' }] });
    expect(sessionOf(await main.api.invoke('sessions.list'), id).babysit!.ci).toBe('pending');

    forge({
      pipeline: { id: 77, status: 'failed', failedJobs: [{ id: 501, name: 'rspec', url: 'https://ci/job' }] },
      conflicts: true,
      approvedBy: ['dave', 'octocat'],
      comments: [
        { id: 1, author: 'carol', body: 'Seen', url: '' },
        { id: 2, author: 'carol', body: 'On the code', path: 'lib/a.rb', line: 3 },
        { id: 3, author: 'gitlab', body: 'added 1 commit', system: true },
        { id: 4, author: 'octocat', body: 'My own' },
      ],
    });
    await pollAfter(main, id, MINUTE);
    await main.elapse(QUIET_WINDOW);

    const card = await nextCard(main, id);
    expect(card.items).toEqual([
      { kind: 'comment', author: 'carol', path: 'lib/a.rb', line: 3, excerpt: 'On the code', url: `${URLS.glab}#note_2` },
      { kind: 'ci-failed', checks: [{ name: 'rspec', url: 'https://ci/job' }] },
      { kind: 'conflicts' },
    ]);
    const items = await waitFor(main.api, 'transcript', (list) => infoCards(list).length === 1, { sessionId: id });
    expect(infoCards(items)).toEqual([{ kind: 'feedback-info', id: expect.any(Number), event: 'approved', author: 'dave', url: URLS.glab }]);
    const invocations = machine.forgeCliInvocations('glab');
    const at = invocations.findIndex((args) => args[0] === 'api' && args[1] === 'user');
    expect(machine.forgeCliCwds('glab')[at]).toBe(checkout);
  });
});
