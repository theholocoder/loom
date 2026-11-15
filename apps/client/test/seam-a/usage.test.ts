import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/storage/database';
import { migrations } from '../../src/main/storage/migrations';
import { git, startMain, tempDir, tempMachine, waitFor, type AcpTurn, type MainHarness, type Machine } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];
const models = [
  { providerID: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 200_000 },
  { providerID: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', context: 200_000 },
];

/** 4 November 2026, 23:59 local time: a minute before midnight. */
const BEFORE_MIDNIGHT = new Date(2026, 10, 4, 23, 59).getTime();
const DAY_MS = 24 * 60 * 60_000;

function machineWith(turns: AcpTurn[]): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, models, acp: { turns } });
  const { checkout } = machine.setUp('loom', (m) => {
    const checkout = m.gitRepo('loom');
    m.commit(checkout, 'README.md', '# loom\n');
    return { checkout };
  });
  return { machine, checkout };
}

async function start(machine: Machine, checkout: string, options: { now?: number; userDataDir?: string } = {}) {
  const main = await startMain({ machine, ...options });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

const waiting = (main: MainHarness, id: number) => waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

describe('usage per turn', () => {
  it('records each turn’s tokens and the change in the reported cost, under the model it ran with', async () => {
    const { machine, checkout } = machineWith([
      { chunks: ['Done.'], tokens: { inputTokens: 1000, outputTokens: 200, thoughtTokens: 50, cachedReadTokens: 3000, cachedWriteTokens: 400 }, cost: 0.12 },
      { chunks: ['Again.'], tokens: { inputTokens: 500, outputTokens: 100 }, cost: 0.2 },
    ]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);
    await main.api.invoke('sessions.send', { id, prompt: 'Once more' });
    await waiting(main, id);

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.tokens).toBe(5250);
    expect(dashboard.reportedCost).toBeCloseTo(0.2);
    expect(dashboard.mix).toEqual({ input: 1500, output: 300, reasoning: 50, cacheRead: 3000, cacheWrite: 400 });
    expect(dashboard.cacheHitRate).toBeCloseTo(3000 / 4900);
    expect(dashboard.perModel).toEqual([{ model: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tokens: 5250 }]);
    expect(dashboard.perProject).toEqual([{ projectId: project.id, project: 'loom', color: project.color, tokens: 5250 }]);
    expect(dashboard.perDay).toHaveLength(7);
    expect(dashboard.perDay.at(-1)).toMatchObject({ tokens: 5250, byProject: { [project.id]: 5250 } });
    expect(dashboard.perDay.slice(0, -1).every((d) => d.tokens === 0)).toBe(true);
  });
});

describe('usage of cancelled turns', () => {
  it('counts a turn the user stopped', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Starting…', { hold: 'stop-me' }], tokens: { inputTokens: 800, outputTokens: 40 }, cost: 0.05 }]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.api.invoke('sessions.stop', { id });
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'stopped'));

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.tokens).toBe(840);
    expect(dashboard.reportedCost).toBeCloseTo(0.05);
  });
});

describe('where a turn is filed', () => {
  it('under the day it ended and the model Loom set for it, by the name the agent gave it', async () => {
    const { machine, checkout } = machineWith([
      { chunks: ['Late night.'], tokens: { inputTokens: 1000, outputTokens: 100 } },
      { chunks: ['Next morning.'], tokens: { inputTokens: 500, outputTokens: 50 } },
    ]);
    const { main, project } = await start(machine, checkout, { now: BEFORE_MIDNIGHT });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);
    await main.elapse(2 * 60_000);
    await main.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-haiku-5-5' });
    await main.api.invoke('sessions.send', { id, prompt: 'Carry on' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.updatedAt > BEFORE_MIDNIGHT + 60_000));

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.perDay.slice(-2)).toEqual([
      { day: '2026-11-04', tokens: 1100, byProject: { [project.id]: 1100 } },
      { day: '2026-11-05', tokens: 550, byProject: { [project.id]: 550 } },
    ]);
    expect(dashboard.perModel).toEqual([
      { model: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tokens: 1100 },
      { model: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5', tokens: 550 },
    ]);
  });
});

describe('dashboard ranges', () => {
  it('covers 7, 30 or 90 days, and keeps older usage for the longer ranges', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'], tokens: { inputTokens: 1000, outputTokens: 0 } }]);
    const userDataDir = tempDir('loom-usage-');
    const september = new Date(2026, 8, 1, 12).getTime();
    const first = await start(machine, checkout, { now: september, userDataDir });
    const { id } = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(first.main, id);
    await first.main.close();

    const later = await startMain({ machine, userDataDir, now: new Date(2026, 10, 5, 12).getTime() });
    const week = await later.api.invoke('usage.dashboard', { days: 7 });
    const month = await later.api.invoke('usage.dashboard', { days: 30 });
    const quarter = await later.api.invoke('usage.dashboard', { days: 90 });

    expect(week.perDay[0]!.day).toBe('2026-10-30');
    expect(week.perDay.at(-1)!.day).toBe('2026-11-05');
    expect([week.tokens, month.tokens, quarter.tokens]).toEqual([0, 0, 1000]);
    expect([week.sessionsStarted, month.sessionsStarted, quarter.sessionsStarted]).toEqual([0, 0, 1]);
    expect(quarter.perDay.find((d) => d.day === '2026-09-01')!.tokens).toBe(1000);
    await expect(later.api.invoke('usage.dashboard', { days: 14 as never })).rejects.toThrow('The dashboard covers 7, 30, 90 days, not 14.');
  });
});

describe('Session time', () => {
  it('gives the median agent run, the median wait for the user, and each Session’s Working time', async () => {
    const { machine, checkout } = machineWith([
      { chunks: ['One.'], hold: 'first', tokens: { inputTokens: 10, outputTokens: 1 } },
      { chunks: ['Two.'], hold: 'second', tokens: { inputTokens: 10, outputTokens: 1 } },
    ]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.elapse(60_000);
    machine.release('first');
    await waiting(main, id);
    await main.elapse(5 * 60_000);
    await main.api.invoke('sessions.send', { id, prompt: 'Next' });
    await waitFor(main.api, 'transcript', (items) => items.filter((i) => i.kind === 'agent').length === 2, { sessionId: id });
    await main.elapse(3 * 60_000);
    machine.release('second');
    await waiting(main, id);

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.medianRunMs).toBe(2 * 60_000);
    // The wait going on now isn't over yet.
    expect(dashboard.medianWaitMs).toBe(5 * 60_000);
    expect(dashboard.topSessions[0]).toMatchObject({ sessionId: id, workingMs: 4 * 60_000 });
  });

  it('counts a wait that goes on after Loom restarts as one, without the time Loom was closed', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'], tokens: { inputTokens: 10, outputTokens: 1 } }]);
    const userDataDir = tempDir('loom-usage-');
    const first = await start(machine, checkout, { userDataDir });
    const { id } = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(first.main, id);
    await first.main.elapse(60_000);
    const closedAt = first.main.clock.now();
    await first.main.close();

    const later = await startMain({ machine, userDataDir, now: closedAt + DAY_MS });
    await waitFor(later.api, 'environments', ready);
    await later.elapse(2 * 60_000);
    await later.api.invoke('sessions.send', { id, prompt: 'Thanks' });
    await waiting(later, id);

    // One wait, both sides of the restart: not two, nor the day Loom was closed.
    const dashboard = await later.api.invoke('usage.dashboard', { days: 7 });
    expect(dashboard.medianWaitMs).toBe(3 * 60_000);
  });
});

describe('Session outcomes', () => {
  const pr = (number: number) => `https://github.com/theholocoder/loom/pull/${number}`;

  it('counts Sessions merged, archived without a Merge request and open, and lists the top ones with their outcome', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, models, acp: { turns: [{ chunks: ['Done.'], tokens: { inputTokens: 100, outputTokens: 10 } }] } });
    const forge = (state: 'open' | 'merged') => machine.installForgeCli('gh', { signedInHosts: ['github.com'], mergeRequests: [{ number: 12, url: pr(12), branch: 'loom/fix-login', state }] });
    forge('open');
    const checkout = machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' });
    git(checkout, 'checkout', '--quiet', '-b', 'main');
    machine.commit(checkout, 'README.md', '# loom\n');
    git(checkout, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', ready);
    const project = await main.api.invoke('projects.link', { path: checkout });
    await waitFor(main.api, 'projects', (list) => list.some((p) => p.id === project.id && p.forge.state === 'available'));
    const create = (prompt: string) => main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt });

    // On the default branch: no Merge request.
    const plain = await create('Tidy the README');
    await waiting(main, plain.id);
    await main.api.invoke('sessions.archive', { id: plain.id });

    git(checkout, 'checkout', '--quiet', '-b', 'loom/fix-login');
    const merged = await create('Fix the login bug');
    await waitFor(main.api, 'sessions', session(merged.id, (s) => s.status === 'waiting' && !!s.mergeRequest));
    forge('merged');
    await main.api.invoke('sessions.archive', { id: merged.id });

    const open = await create('Look at the logs');
    await waiting(main, open.id);

    let dashboard = await main.api.invoke('usage.dashboard', { days: 7 });
    for (let tries = 0; dashboard.mergeRequestsMerged === 0 && tries < 50; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      dashboard = await main.api.invoke('usage.dashboard', { days: 7 });
    }

    expect(dashboard.sessionsStarted).toBe(3);
    expect(dashboard.mergeRequestsMerged).toBe(1);
    expect(dashboard.outcomes).toEqual({ merged: 1, closed: 0, archived: 1, open: 1, stuck: 0 });
    expect(dashboard.topSessions.map((s) => [s.title, s.outcome])).toEqual([
      ['Tidy the README', 'archived'],
      ['Fix the login bug', 'merged'],
      ['Look at the logs', 'open'],
    ]);
    expect(dashboard.topSessions[1]).toEqual({
      sessionId: merged.id,
      title: 'Fix the login bug',
      projectId: project.id,
      project: 'loom',
      mergeRequest: { number: 12, url: pr(12) },
      model: 'anthropic/claude-sonnet-5-5',
      modelName: 'Claude Sonnet 5.5',
      tokens: 110,
      workingMs: 0,
      outcome: 'merged',
    });
  });
});

describe('usage per Project', () => {
  it('keeps two Projects of the same name apart', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, models, acp: { turns: [{ chunks: ['Done.'], tokens: { inputTokens: 100, outputTokens: 0 } }] } });
    const work = machine.gitRepo('work/loom');
    const fork = machine.gitRepo('fork/loom');
    for (const repo of [work, fork]) machine.commit(repo, 'README.md', '# loom\n');
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', ready);
    const first = await main.api.invoke('projects.link', { path: work });
    const second = await main.api.invoke('projects.link', { path: fork });
    for (const [projectId, prompt] of [[first.id, 'One'], [second.id, 'Two'], [second.id, 'Three']] as const) {
      const { id } = await main.api.invoke('sessions.create', { projectId, workingCopy: 'checkout', prompt });
      await waiting(main, id);
    }

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.perProject).toEqual([
      { projectId: second.id, project: 'loom', color: second.color, tokens: 200 },
      { projectId: first.id, project: 'loom', color: first.color, tokens: 100 },
    ]);
    expect(dashboard.perDay.at(-1)!.byProject).toEqual({ [first.id]: 100, [second.id]: 200 });
  });

  it('keeps a removed Project’s usage, marked removed', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'], tokens: { inputTokens: 100, outputTokens: 0 } }]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);
    await main.api.invoke('projects.remove', { id: project.id });

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.perProject).toEqual([{ projectId: project.id, project: 'loom', color: project.color, tokens: 100, removed: true }]);
    expect(dashboard.topSessions).toMatchObject([{ sessionId: id, title: 'Fix the login bug', project: 'loom', projectRemoved: true }]);
  });

  it('names and colours a Project as it is now, renamed and recoloured since its usage', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'], tokens: { inputTokens: 100, outputTokens: 0 } }]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);

    await main.api.invoke('projects.edit', { id: project.id, name: 'Loom app', color: 'magenta' });

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });
    expect(dashboard.perProject).toEqual([{ projectId: project.id, project: 'Loom app', color: 'magenta', tokens: 100 }]);
    expect(dashboard.topSessions).toMatchObject([{ sessionId: id, project: 'Loom app' }]);
  });
});

describe('reported cost', () => {
  it('counts what a failed turn cost, on the turn it was reported with', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Trying…'], error: 'Quota exceeded', cost: 0.3 }]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'error'));

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.reportedCost).toBeCloseTo(0.3);
    expect(dashboard.tokens).toBe(0);
  });
});

describe('a wait on a question when Loom quits', () => {
  it('ends there, counted up to the quit', async () => {
    const question = { message: 'Which color?', requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Color' } }, required: [] } };
    const { machine, checkout } = machineWith([{ chunks: [{ elicit: question }] }]);
    const userDataDir = tempDir('loom-usage-');
    const first = await start(machine, checkout, { userDataDir });
    const { id } = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waitFor(first.main.api, 'sessions', session(id, (s) => s.waitingReason === 'question'));
    await first.main.elapse(4 * 60_000);
    const closedAt = first.main.clock.now();
    await first.main.close();

    const later = await startMain({ machine, userDataDir, now: closedAt + DAY_MS });
    await waitFor(later.api, 'sessions', session(id, (s) => s.waitingReason === 'interrupted'));
    await later.elapse(60_000);

    const dashboard = await later.api.invoke('usage.dashboard', { days: 7 });
    expect(dashboard.medianWaitMs).toBe(4 * 60_000);
  });
});

describe('reported cost after upgrading', () => {
  it('counts a conversation from before Loom kept its cost only from its first report', async () => {
    const { machine, checkout } = machineWith([]);
    machine.installOpencode({
      version: 'opencode v2.1.4',
      integrations: signedIn,
      models,
      acp: {
        turns: [],
        resumedTurns: [
          { chunks: ['Back.'], tokens: { inputTokens: 10, outputTokens: 1 }, cost: 4.3 },
          { chunks: ['Again.'], tokens: { inputTokens: 10, outputTokens: 1 }, cost: 4.5 },
        ],
      },
    });
    // A database as the release before usage (migration 12) left it, with a Session whose conversation has cost $4.30 so far.
    const userDataDir = tempDir('loom-usage-');
    await (await openDatabase(userDataDir, { migrations: migrations.slice(0, 11) })).destroy();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("insert into projects (id, name, branch_prefix, created_at) values (1, 'loom', 'loom', 0)").run();
    db.prepare("insert into checkouts (project_id, environment_id, path) values (1, 'native', ?)").run(checkout);
    db.prepare(
      "insert into sessions (id, project_id, title, working_copy_kind, working_copy_path, agent, agent_session_id, status, waiting_reason, created_at, updated_at) values (1, 1, 'Old work', 'checkout', ?, 'OpenCode', 'ses_old', 'waiting', 'finished', 0, 0)",
    ).run(checkout);
    db.close();

    const main = await startMain({ machine, userDataDir });
    await waitFor(main.api, 'environments', ready);
    await main.api.invoke('sessions.send', { id: 1, prompt: 'Carry on' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Back.'), { sessionId: 1 });
    await waiting(main, 1);
    await main.api.invoke('sessions.send', { id: 1, prompt: 'And again' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Again.'), { sessionId: 1 });
    await waiting(main, 1);

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });
    expect(dashboard.reportedCost).toBeCloseTo(0.2);
  });
});

describe("a Session's own usage", () => {
  it('gives its tokens, Reported cost and Working time as they grow, the run going on with when it started, and keeps them', async () => {
    const { machine, checkout } = machineWith([
      { chunks: ['One.'], hold: 'first', tokens: { inputTokens: 1000, outputTokens: 200 }, cost: 0.12 },
      { chunks: ['Two.'], hold: 'second', tokens: { inputTokens: 500, outputTokens: 100 }, cost: 0.2 },
    ]);
    const userDataDir = tempDir('loom-usage-');
    const { main, project } = await start(machine, checkout, { userDataDir });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    const startedAt = main.clock.now();
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.usage).toEqual({ tokens: 0, reportedCost: 0, workingMs: 0, workingSince: startedAt });
    await main.elapse(60_000);
    machine.release('first');
    const first = await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.usage?.tokens === 1200));
    expect(first.find((s) => s.id === id)!.usage).toEqual({ tokens: 1200, reportedCost: expect.closeTo(0.12) as number, workingMs: 60_000 });

    await main.elapse(5 * 60_000);
    await main.api.invoke('sessions.send', { id, prompt: 'Next' });
    await waitFor(main.api, 'transcript', (items) => items.filter((i) => i.kind === 'agent').length === 2, { sessionId: id });
    await main.elapse(3 * 60_000);
    machine.release('second');
    const second = await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.usage?.tokens === 1800));
    expect(second.find((s) => s.id === id)!.usage).toEqual({ tokens: 1800, reportedCost: expect.closeTo(0.2) as number, workingMs: 4 * 60_000 });
    await main.close();

    const later = await startMain({ machine, userDataDir });
    const restored = await waitFor(later.api, 'sessions', session(id, () => true));
    expect(restored.find((s) => s.id === id)!.usage).toEqual({ tokens: 1800, reportedCost: expect.closeTo(0.2) as number, workingMs: 4 * 60_000 });
  });

  it('keeps a deleted Session’s usage, under no title of its own', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'], tokens: { inputTokens: 100, outputTokens: 0 } }]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);
    expect(await main.api.invoke('sessions.delete', { id })).toEqual({ deleted: true });

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.tokens).toBe(100);
    expect(dashboard.topSessions).toMatchObject([{ sessionId: id, title: 'Deleted Session', tokens: 100 }]);
  });
});
