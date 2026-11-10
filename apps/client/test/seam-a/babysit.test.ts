import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
/** With `worktree`, the Session works in a worktree of the branch, with all of it pushed to a second remote. */
async function babysat(cli: ForgeCli, initial: Activity = {}, { turns = [], userDataDir, worktree = false }: { turns?: AcpTurn[]; userDataDir?: string; worktree?: boolean } = {}) {
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
  if (worktree) {
    git(checkout, 'branch', BRANCH);
    const mirror = machine.gitOrigin('mirror');
    git(checkout, 'remote', 'add', 'mirror', mirror);
    git(checkout, 'push', '--quiet', '--force', 'mirror', 'main', BRANCH);
  } else {
    git(checkout, 'checkout', '--quiet', '-b', BRANCH);
  }

  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  await waitFor(main.api, 'projects', (list) => list.some((p) => p.id === project.id && p.forge.state === 'available'));
  const workingCopy = worktree ? { workingCopy: 'worktree' as const, existing: { branch: { name: BRANCH, remote: false } } } : { workingCopy: 'checkout' as const };
  const { id, workingCopy: { path } } = await main.api.invoke('sessions.create', { projectId: project.id, ...workingCopy, prompt: 'Fix the login bug' });
  await waitFor(main.api, 'sessions', (list) => list.some((s) => s.id === id && !!s.mergeRequest && s.status === 'waiting' && s.babysit?.lastPollAt !== undefined));
  return { machine, main, id, forge, checkout, path, projectId: project.id };
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

const endedCards = (items: TranscriptItem[]) => items.filter((i) => i.kind === 'merge-request-ended');
/** Asks for a poll now, for a Merge request that has just ended: the Session may be archived before the poll's time shows. */
async function pollEnded(main: MainHarness) {
  await main.elapse(1000);
  await main.api.invoke('sessions.check');
}
const sessionNow = async (main: MainHarness, id: number) => sessionOf(await main.api.invoke('sessions.list'), id);

describe('a Merge request no longer open', () => {
  it('archives the Session once merged, saying so in its conversation, and stops being polled', async () => {
    const { machine, main, id, forge } = await babysat('gh');
    forge({ state: 'merged' });
    await pollEnded(main);

    const list = await waitFor(main.api, 'sessions', (sessions) => sessionOf(sessions, id).status === 'archived');
    expect(sessionOf(list, id)).toMatchObject({ mergeRequestState: 'merged', unread: false });
    const items = await waitFor(main.api, 'transcript', (all) => endedCards(all).length > 0, { sessionId: id });
    expect(endedCards(items)).toEqual([{ kind: 'merge-request-ended', id: expect.any(Number), number: 12, url: URLS.gh, state: 'merged', archived: true }]);

    const before = graphql(machine).length;
    await main.elapse(10 * MINUTE);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(graphql(machine)).toHaveLength(before);
  });

  it('archives the Session once closed without merging, leaving it unread for the user to notice', async () => {
    const { main, id, forge } = await babysat('gh');
    await main.api.invoke('sessions.setUnread', { id, unread: false });
    forge({ state: 'closed' });
    await pollEnded(main);

    const list = await waitFor(main.api, 'sessions', (sessions) => sessionOf(sessions, id).status === 'archived' && sessionOf(sessions, id).unread);
    expect(sessionOf(list, id)).toMatchObject({ mergeRequestState: 'closed' });
    const items = await waitFor(main.api, 'transcript', (all) => endedCards(all).length > 0, { sessionId: id });
    expect(endedCards(items)).toEqual([{ kind: 'merge-request-ended', id: expect.any(Number), number: 12, url: URLS.gh, state: 'closed', archived: true }]);
  });

  it('puts a worktree Session with uncommitted changes in the Inbox instead, its worktree untouched', async () => {
    const { main, id, forge, path } = await babysat('gh', {}, { worktree: true });
    writeFileSync(join(path, 'README.md'), 'half done\n');
    forge({ state: 'merged' });
    await pollEnded(main);

    const list = await waitFor(main.api, 'sessions', (sessions) => sessionOf(sessions, id).waitingReason === 'unsaved-work');
    expect(sessionOf(list, id)).toMatchObject({ status: 'waiting', unread: true, mergeRequestState: 'merged' });
    const items = await waitFor(main.api, 'transcript', (all) => endedCards(all).length > 0, { sessionId: id });
    expect(endedCards(items)).toEqual([
      { kind: 'merge-request-ended', id: expect.any(Number), number: 12, url: URLS.gh, state: 'merged', archived: false, unsavedWork: { uncommitted: true, unpushedCommits: 0, detached: false } },
    ]);
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('half done\n');

    // Told once: later polls and checks leave it be.
    await pollEnded(main);
    await main.elapse(10 * MINUTE);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(endedCards(await waitFor(main.api, 'transcript', () => true, { sessionId: id }))).toHaveLength(1);
    expect(await sessionNow(main, id)).toMatchObject({ status: 'waiting', waitingReason: 'unsaved-work' });
  });

  it('puts a worktree Session with unpushed commits in the Inbox instead', async () => {
    const { machine, main, id, forge, path } = await babysat('gh', {}, { worktree: true });
    machine.commit(path, 'fix.txt', 'fixed\n');
    forge({ state: 'closed' });
    await pollEnded(main);

    await waitFor(main.api, 'sessions', (sessions) => sessionOf(sessions, id).waitingReason === 'unsaved-work');
    const items = await waitFor(main.api, 'transcript', (all) => endedCards(all).length > 0, { sessionId: id });
    expect(endedCards(items)[0]).toMatchObject({ state: 'closed', archived: false, unsavedWork: { uncommitted: false, unpushedCommits: 1 } });
    expect(existsSync(path)).toBe(true);
  });

  it('archives a worktree Session with nothing unsaved, removing its worktree', async () => {
    const { main, id, forge, path } = await babysat('gh', {}, { worktree: true });
    forge({ state: 'merged' });
    await pollEnded(main);

    await waitFor(main.api, 'sessions', (sessions) => sessionOf(sessions, id).status === 'archived');
    expect(existsSync(path)).toBe(false);
  });

  it('waits for the run going to end before archiving', async () => {
    const { machine, main, id, forge } = await babysat('gh', {}, { turns: [{ chunks: ['Done.'] }, { chunks: ['Working.'], hold: 'second' }] });
    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Working.'), { sessionId: id });
    forge({ state: 'merged' });
    await pollEnded(main);
    await waitFor(main.api, 'sessions', (sessions) => sessionOf(sessions, id).mergeRequestState === 'merged');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await sessionNow(main, id)).toMatchObject({ status: 'working' });

    machine.release('second');
    await waitFor(main.api, 'sessions', (sessions) => sessionOf(sessions, id).status === 'archived');
  });

  it('archives after a restart a Session whose Merge request ended while its run went on', async () => {
    const { machine, main, id, forge } = await babysat('gh', {}, { userDataDir: tempDir('loom-babysit-'), turns: [{ chunks: ['Done.'] }, { chunks: ['Working.'], hold: 'second' }] });
    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Working.'), { sessionId: id });
    forge({ state: 'merged' });
    await pollEnded(main);
    await waitFor(main.api, 'sessions', (sessions) => sessionOf(sessions, id).mergeRequestState === 'merged');
    await main.close();

    const again = await startMain({ machine, userDataDir: main.userDataDir, now: main.clock.now() });
    await waitFor(again.api, 'environments', ready);
    await waitFor(again.api, 'sessions', (sessions) => sessionOf(sessions, id).status === 'archived');
  });

  it("archives a checkout Session whatever its checkout holds", async () => {
    const { main, id, forge, checkout } = await babysat('gh');
    writeFileSync(join(checkout, 'README.md'), 'half done\n');
    forge({ state: 'merged' });
    await pollEnded(main);

    await waitFor(main.api, 'sessions', (sessions) => sessionOf(sessions, id).status === 'archived');
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('half done\n');
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
        "Read the details you need with `gh` (a whole thread, a failing check's log), fix what needs fixing, push the branch, then reply to or resolve each item on the Merge request.",
      ].join('\n'),
    );
    expect((await cardsOf(main, id))[0]!.state).toBe('sent');
    await expect(main.api.invoke('sessions.sendFeedback', { id, itemId: card.id })).rejects.toThrow('already been sent');
  });
});

describe('the arguments of a poll', () => {
  // A CLI installed as a .cmd shim runs through cmd.exe, which stops at a newline and splits at an &.
  it.each(['gh', 'glab'] as const)('are ones cmd.exe passes on whole, for %s', async (cli) => {
    const { machine } = await babysat(cli, { pipeline: { id: 77, status: 'failed', failedJobs: [{ id: 501, name: 'rspec', url: 'https://ci/job' }] } });
    expect(machine.forgeCliInvocations(cli).flat().filter((arg) => /[\n&]/.test(arg))).toEqual([]);
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

describe('auto-prompt', () => {
  const comment = (n: number) => ({ id: n, author: 'bob', body: `Note ${n}`, url: `${URLS.gh}#c${n}` });

  it('is off by default, and a new Session takes the global default as it stands', async () => {
    const { main, id, projectId } = await babysat('gh');
    expect(sessionOf(await main.api.invoke('sessions.list'), id).autoPrompt).toBeUndefined();

    expect((await main.api.invoke('settings.setAutoPromptDefault', { on: true })).autoPromptDefault).toBe(true);
    const seeded = await main.api.invoke('sessions.create', { projectId, workingCopy: 'worktree', prompt: 'Another' });
    expect(seeded.autoPrompt).toBe(true);
    expect(sessionOf(await main.api.invoke('sessions.list'), id).autoPrompt).toBeUndefined();
  });

  it('sends feedback straight to a Waiting agent, as one message, and shows the card as sent', async () => {
    const { machine, main, id, forge } = await babysat('gh', {}, { turns: [{ chunks: ['Done.'] }, { chunks: ['Fixed.'] }] });
    await main.api.invoke('sessions.setAutoPrompt', { id, on: true });

    forge({ comments: [comment(1)], checks: [{ id: 3, name: 'unit', conclusion: 'FAILURE', url: 'https://ci/3' }] });
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Fixed.'), { sessionId: id });

    expect(prompts(machine).at(-1)).toBe(
      [
        `There is new feedback on this Session's Merge request (${URLS.gh}):`,
        '',
        `1. Comment by bob: "Note 1" (${URLS.gh}#c1)`,
        '2. CI failed:',
        '   - unit (https://ci/3)',
        '',
        "Read the details you need with `gh` (a whole thread, a failing check's log), fix what needs fixing, push the branch, then reply to or resolve each item on the Merge request.",
      ].join('\n'),
    );
    expect((await cardsOf(main, id)).map((c) => c.state)).toEqual(['sent']);
  });

  const said = (main: MainHarness, id: number, text: string) => waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === text), { sessionId: id });
  const settled = (main: MainHarness, id: number) => waitFor(main.api, 'sessions', (list) => sessionOf(list, id).status === 'waiting');
  /** `n` comments on the Merge request, the last new, given the time to reach the Session. */
  async function newComment(main: MainHarness, id: number, forge: (activity: Activity) => void, n: number) {
    forge({ comments: Array.from({ length: n }, (_, at) => comment(at + 1)) });
    await pollNow(main, id);
    await main.elapse(QUIET_WINDOW);
  }

  it('joins the queue of a Working Session, behind what the agent is doing', async () => {
    const { machine, main, id, forge } = await babysat('gh', {}, { turns: [{ chunks: ['Done.'] }, { chunks: ['Working.'], hold: 'second' }, { chunks: ['Fixed.'] }] });
    await main.api.invoke('sessions.setAutoPrompt', { id, on: true });
    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await said(main, id, 'Working.');

    await newComment(main, id, forge, 1);
    const queued = await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).queue?.length === 1);
    expect(sessionOf(queued, id).status).toBe('working');
    expect(sessionOf(queued, id).queue![0]!.text).toContain('Comment by bob: "Note 1"');
    expect(prompts(machine).at(-1)).toBe('Carry on');
    const midRun = await waitFor(main.api, 'transcript', () => true, { sessionId: id });
    expect(midRun.find((i) => i.kind === 'agent' && i.text === 'Working.')).toMatchObject({ streaming: false });

    machine.release('second');
    await said(main, id, 'Fixed.');
    expect(prompts(machine).at(-1)).toContain('Comment by bob: "Note 1"');
    expect((await cardsOf(main, id)).map((c) => c.state)).toEqual(['sent']);
  });

  const write = { toolCallId: 'call_w', name: 'write', title: '/etc/loom.conf', kind: 'edit', locations: [{ path: '/etc/loom.conf' }], rawInput: { path: '/etc/loom.conf', content: 'hi' } };
  const question = { message: 'Which one?', requestedSchema: { type: 'object', properties: { pick: { type: 'string', title: 'Pick' } } } };

  it.each([
    ['question', { elicit: question }, (main: MainHarness, id: number, items: TranscriptItem[]) => main.api.invoke('sessions.answer', { id, itemId: items.find((i) => i.kind === 'question')!.id, answer: { pick: 'this' } })],
    ['approval', { permission: write }, (main: MainHarness, id: number, items: TranscriptItem[]) => main.api.invoke('sessions.approve', { id, itemId: items.find((i) => i.kind === 'approval')!.id, decision: 'once' })],
  ] as const)('is held while the Session waits on a %s, and goes once it is unblocked', async (reason, chunk, unblock) => {
    const { machine, main, id, forge } = await babysat('gh', {}, { turns: [{ chunks: ['Done.'] }, { chunks: [chunk as never, 'Thanks.'] }, { chunks: ['Fixed.'] }] });
    await main.api.invoke('sessions.setAutoPrompt', { id, on: true });
    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).waitingReason === reason);

    await newComment(main, id, forge, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionOf(await main.api.invoke('sessions.list'), id)).toMatchObject({ status: 'waiting', waitingReason: reason });
    expect(sessionOf(await main.api.invoke('sessions.list'), id).queue).toBeUndefined();
    expect(await cardsOf(main, id)).toEqual([]);

    await unblock(main, id, await waitFor(main.api, 'transcript', () => true, { sessionId: id }));
    await said(main, id, 'Fixed.');
    expect(prompts(machine).at(-1)).toContain('Comment by bob: "Note 1"');
    expect((await cardsOf(main, id)).map((c) => c.state)).toEqual(['sent']);
  });

  it('leaves a Session waiting on an error for its Retry, with a card to send by hand', async () => {
    const { machine, main, id, forge } = await babysat('gh', {}, { turns: [{ chunks: ['Done.'] }, { error: 'Boom' }] });
    await main.api.invoke('sessions.setAutoPrompt', { id, on: true });
    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).waitingReason === 'error');

    await newComment(main, id, forge, 1);
    expect((await nextCard(main, id)).state).toBe('new');
    expect(sessionOf(await main.api.invoke('sessions.list'), id).waitingReason).toBe('error');
    expect(prompts(machine).at(-1)).toBe('Carry on');
  });

  it('does not wake a Session the user stopped, leaving a card to send by hand', async () => {
    const { machine, main, id, forge } = await babysat('gh', {}, { turns: [{ chunks: ['Done.'] }, { chunks: ['Working.', { hold: 'never' }] }] });
    await main.api.invoke('sessions.setAutoPrompt', { id, on: true });
    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await said(main, id, 'Working.');
    await main.api.invoke('sessions.stop', { id });
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).waitingReason === 'stopped');

    await newComment(main, id, forge, 1);
    expect((await nextCard(main, id)).state).toBe('new');
    expect(prompts(machine).at(-1)).toBe('Carry on');
  });

  it('counts what the user says on denying an Approval request as a message', async () => {
    const turns = [{ chunks: ['Done.'] }, { chunks: ['Fix 1.'] }, { chunks: ['Fix 2.'] }, { chunks: [{ permission: write }, 'Fix 3.'] }, { chunks: ['Fine.'] }, { chunks: ['Fix 4.'] }];
    const { machine, main, id, forge } = await babysat('gh', {}, { turns });
    await main.api.invoke('sessions.setAutoPrompt', { id, on: true });
    for (const n of [1, 2]) {
      await newComment(main, id, forge, n);
      await said(main, id, `Fix ${n}.`);
      await settled(main, id);
    }
    await newComment(main, id, forge, 3);
    const asked = await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'approval'), { sessionId: id });
    await main.api.invoke('sessions.approve', { id, itemId: asked.find((i) => i.kind === 'approval')!.id, decision: 'deny', message: 'Not there, use the repo' });
    await said(main, id, 'Fine.');
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).waitingReason === 'finished');

    await newComment(main, id, forge, 4);
    await said(main, id, 'Fix 4.');
    expect(prompts(machine).at(-1)).toContain('Note 4');
  });

  it('pauses after 3 in a row, holding the 4th for the run to end, until the user says something', async () => {
    const turns = [{ chunks: ['Done.'] }, { chunks: ['Fix 1.'] }, { chunks: ['Fix 2.'] }, { chunks: ['Fix 3.'], hold: 'third' }, { chunks: ['Fine.'] }, { chunks: ['Fix 5.'] }];
    const { machine, main, id, forge } = await babysat('gh', {}, { turns });
    await main.api.invoke('sessions.setAutoPrompt', { id, on: true });

    for (const n of [1, 2]) {
      await newComment(main, id, forge, n);
      await said(main, id, `Fix ${n}.`);
      await settled(main, id);
    }
    await newComment(main, id, forge, 3);
    await said(main, id, 'Fix 3.');

    await newComment(main, id, forge, 4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionOf(await main.api.invoke('sessions.list'), id)).toMatchObject({ status: 'working' });
    expect(sessionOf(await main.api.invoke('sessions.list'), id).queue).toBeUndefined();
    expect(await cardsOf(main, id)).toHaveLength(3);

    const before = prompts(machine).length;
    machine.release('third');
    const paused = await nextCard(main, id, 4);
    expect(paused).toMatchObject({ state: 'new', paused: true });
    expect(sessionOf(await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).waitingReason === 'feedback'), id).status).toBe('waiting');
    expect(prompts(machine)).toHaveLength(before);

    await main.api.invoke('sessions.send', { id, prompt: 'Keep going' });
    await said(main, id, 'Fine.');
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).waitingReason === 'finished');
    await newComment(main, id, forge, 5);
    await said(main, id, 'Fix 5.');
    expect(prompts(machine).at(-1)).toContain('Note 5');
    expect((await cardsOf(main, id)).at(-1)).toMatchObject({ state: 'sent' });
  });

  it('keeps the toggle, the count and the default across a restart', async () => {
    const turns = [{ chunks: ['Done.'] }, { chunks: ['Fix 1.'] }, { chunks: ['Fix 2.'] }, { chunks: ['Fix 3.'] }];
    const { machine, main, id, forge } = await babysat('gh', {}, { turns, userDataDir: tempDir('loom-auto-prompt-') });
    await main.api.invoke('sessions.setAutoPrompt', { id, on: true });
    await main.api.invoke('settings.setAutoPromptDefault', { on: true });
    for (const n of [1, 2, 3]) {
      await newComment(main, id, forge, n);
      await said(main, id, `Fix ${n}.`);
      await settled(main, id);
    }
    await main.close();

    const again = await startMain({ machine, userDataDir: main.userDataDir, now: main.clock.now() });
    await waitFor(again.api, 'environments', ready);
    await waitFor(again.api, 'sessions', (list) => sessionOf(list, id).babysit?.lastPollAt === again.clock.now());
    expect(sessionOf(await again.api.invoke('sessions.list'), id).autoPrompt).toBe(true);
    expect((await waitFor(again.api, 'settings', () => true)).autoPromptDefault).toBe(true);

    await newComment(again, id, forge, 4);
    expect(await nextCard(again, id, 4)).toMatchObject({ state: 'new', paused: true });
  });

  it('refuses a change on an archived Session', async () => {
    const { main, id } = await babysat('gh');
    await main.api.invoke('sessions.archive', { id });
    await expect(main.api.invoke('sessions.setAutoPrompt', { id, on: true })).rejects.toThrow('archived');
  });
});

describe('watching a Merge request', () => {
  const comment = (n: number) => ({ id: n, author: 'bob', body: `Note ${n}`, url: `${URLS.gh}#c${n}` });
  const toolCall = (name: string, rawInput: unknown) => [
    { update: { sessionUpdate: 'tool_call', toolCallId: 'call_link', title: name, kind: 'other', status: 'pending', rawInput } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_link', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Linked.' } }] } },
  ];
  const quietly = () => new Promise((resolve) => setTimeout(resolve, 200));

  it('stops when switched off: no polls, no feedback, nothing shown of the last one', async () => {
    const { machine, main, id, forge } = await babysat('gh');
    await main.api.invoke('sessions.setBabysitting', { id, on: false });
    const off = await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit === undefined);
    expect(sessionOf(off, id).babysitOff).toBe(true);

    forge({ comments: [comment(1)] });
    const before = graphql(machine).length;
    await main.elapse(10 * MINUTE);
    await main.api.invoke('sessions.check');
    await quietly();
    expect(graphql(machine)).toHaveLength(before);
    expect(await cardsOf(main, id)).toEqual([]);
  });

  it('polls at once when switched back on, and reports what came meanwhile', async () => {
    const { main, id, forge } = await babysat('gh');
    await main.api.invoke('sessions.setBabysitting', { id, on: false });
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit === undefined);
    forge({ comments: [comment(1)] });
    await main.elapse(MINUTE);

    await main.api.invoke('sessions.setBabysitting', { id, on: true });
    const at = main.clock.now();
    const on = await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit?.lastPollAt === at);
    expect(sessionOf(on, id).babysitOff).toBeUndefined();
    await main.elapse(QUIET_WINDOW);
    expect((await nextCard(main, id)).items).toEqual([{ kind: 'comment', author: 'bob', excerpt: 'Note 1', url: `${URLS.gh}#c1` }]);
  });

  it('stays off across a restart', async () => {
    const { machine, main, id } = await babysat('gh', {}, { userDataDir: tempDir('loom-watch-') });
    await main.api.invoke('sessions.setBabysitting', { id, on: false });
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit === undefined);
    await main.close();

    const before = graphql(machine).length;
    const again = await startMain({ machine, userDataDir: main.userDataDir, now: main.clock.now() });
    await waitFor(again.api, 'environments', ready);
    await quietly();
    expect(sessionOf(await again.api.invoke('sessions.list'), id).babysitOff).toBe(true);
    expect(sessionOf(await again.api.invoke('sessions.list'), id).babysit).toBeUndefined();
    expect(graphql(machine)).toHaveLength(before);
  });

  it('starts by itself when the agent links a Merge request with the tool', async () => {
    const machine = tempMachine();
    const turns = [{ chunks: toolCall('loom_link_merge_request', { number: 12 }) as AcpTurn['chunks'] }];
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
    machine.installForgeCli('gh', { signedInHosts: ['github.com'], mergeRequests: [{ number: 12, url: URLS.gh, branch: 'somewhere-else' }] });
    const checkout = machine.gitRepo('loom', { origin: GITHUB });
    git(checkout, 'checkout', '--quiet', '-b', 'main');
    machine.commit(checkout, 'README.md', '# loom\n');
    git(checkout, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git(checkout, 'checkout', '--quiet', '-b', BRANCH);
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', ready);
    const project = await main.api.invoke('projects.link', { path: checkout });
    await waitFor(main.api, 'projects', (list) => list.some((p) => p.id === project.id && p.forge.state === 'available'));

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Link it' });

    const linked = await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit?.lastPollAt !== undefined);
    expect(sessionOf(linked, id)).toMatchObject({ mergeRequest: { number: 12, url: URLS.gh }, mergeRequestState: 'open' });
    expect(sessionOf(linked, id).babysitOff).toBeUndefined();
  });

  it('starts again on a different Merge request, but a look at the same one leaves it off', async () => {
    const { machine, main, id } = await babysat('gh', {}, { turns: [{ chunks: ['Done.'] }, { chunks: ['Again.'] }] });
    const other = 'https://github.com/theholocoder/loom/pull/13';
    machine.installForgeCli('gh', { signedInHosts: ['github.com'], mergeRequests: [{ number: 12, url: URLS.gh, branch: BRANCH }, { number: 13, url: other, branch: 'somewhere-else' }] });
    await main.api.invoke('sessions.setBabysitting', { id, on: false });
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit === undefined);

    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Again.'), { sessionId: id });
    await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).status === 'waiting');
    await quietly();
    expect(sessionOf(await main.api.invoke('sessions.list'), id).babysitOff).toBe(true);

    await main.api.invoke('sessions.linkMergeRequest', { id, mergeRequest: '13' });
    const on = await waitFor(main.api, 'sessions', (list) => sessionOf(list, id).babysit?.lastPollAt !== undefined);
    expect(sessionOf(on, id)).toMatchObject({ mergeRequest: { number: 13, url: other } });
    expect(sessionOf(on, id).babysitOff).toBeUndefined();
  });

  it('refuses a change on an archived Session', async () => {
    const { main, id } = await babysat('gh');
    await main.api.invoke('sessions.archive', { id });
    await expect(main.api.invoke('sessions.setBabysitting', { id, on: false })).rejects.toThrow('archived');
  });
});

describe('the CI checks of a Merge request', () => {
  it('lists every check GitHub has, however far along, with its link', async () => {
    const { main, id } = await babysat('gh', {
      checks: [
        { id: 1, name: 'unit', conclusion: 'FAILURE', url: 'https://ci/1' },
        { id: 2, name: 'lint', conclusion: 'SUCCESS', url: 'https://ci/2' },
        { id: 3, name: 'docs', conclusion: 'SKIPPED' },
        { id: 4, name: 'e2e', status: 'IN_PROGRESS', url: 'https://ci/4' },
        { id: 5, name: 'old', conclusion: 'CANCELLED' },
        { context: 'codecov', state: 'SUCCESS', url: 'https://ci/6' },
      ],
    });

    expect(sessionOf(await main.api.invoke('sessions.list'), id).babysit).toMatchObject({
      ci: 'pending',
      checks: [
        { name: 'unit', state: 'failed', url: 'https://ci/1' },
        { name: 'lint', state: 'passed', url: 'https://ci/2' },
        { name: 'docs', state: 'passed' },
        { name: 'e2e', state: 'pending', url: 'https://ci/4' },
        { name: 'old', state: 'not-run' },
        { name: 'codecov', state: 'passed', url: 'https://ci/6' },
      ],
    });
  });

  it('lists every job of the pipeline on GitLab, finished or not', async () => {
    const jobs = [
      { id: 1, name: 'lint', status: 'success', url: 'https://ci/1' },
      { id: 2, name: 'rspec', status: 'running', url: 'https://ci/2' },
      { id: 3, name: 'deploy', status: 'manual', url: 'https://ci/3' },
    ];
    const { main, id } = await babysat('glab', { pipeline: { id: 77, status: 'running', jobs } });

    expect(sessionOf(await main.api.invoke('sessions.list'), id).babysit).toMatchObject({
      ci: 'pending',
      checks: [
        { name: 'lint', state: 'passed', url: 'https://ci/1' },
        { name: 'rspec', state: 'pending', url: 'https://ci/2' },
        { name: 'deploy', state: 'not-run', url: 'https://ci/3' },
      ],
    });
  });

  it('follows the checks from poll to poll', async () => {
    const { main, id, forge } = await babysat('gh', { checks: [{ id: 1, name: 'unit', status: 'QUEUED' }] });
    expect(sessionOf(await main.api.invoke('sessions.list'), id).babysit!.checks).toEqual([{ name: 'unit', state: 'pending' }]);

    forge({ checks: [{ id: 1, name: 'unit', conclusion: 'SUCCESS' }] });
    await pollAfter(main, id, MINUTE);
    expect(sessionOf(await main.api.invoke('sessions.list'), id).babysit!.checks).toEqual([{ name: 'unit', state: 'passed' }]);
  });
});
