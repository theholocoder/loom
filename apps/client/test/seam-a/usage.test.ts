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
const HOUR_MS = 60 * 60_000;

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
    expect(dashboard.perPlace).toEqual([{ key: `project:${project.id}`, projectId: project.id, label: 'loom', color: project.color, tokens: 5250 }]);
    expect(dashboard.perDay).toHaveLength(7);
    expect(dashboard.perDay.at(-1)).toMatchObject({ tokens: 5250, byPlace: { [`project:${project.id}`]: 5250 } });
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
      { day: '2026-11-04', tokens: 1100, byPlace: { [`project:${project.id}`]: 1100 } },
      { day: '2026-11-05', tokens: 550, byPlace: { [`project:${project.id}`]: 550 } },
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

    expect(dashboard.perPlace).toEqual([
      { key: `project:${second.id}`, projectId: second.id, label: 'loom', color: second.color, tokens: 200 },
      { key: `project:${first.id}`, projectId: first.id, label: 'loom', color: first.color, tokens: 100 },
    ]);
    expect(dashboard.perDay.at(-1)!.byPlace).toEqual({ [`project:${first.id}`]: 100, [`project:${second.id}`]: 200 });
  });

  it('keeps a removed Project’s usage, marked removed', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'], tokens: { inputTokens: 100, outputTokens: 0 } }]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);
    await main.api.invoke('projects.remove', { id: project.id });

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.perPlace).toEqual([{ key: `project:${project.id}`, projectId: project.id, label: 'loom', color: project.color, tokens: 100, removed: true }]);
    expect(dashboard.topSessions).toMatchObject([{ sessionId: id, title: 'Fix the login bug', project: 'loom', projectRemoved: true }]);
  });

  it('names and colours a Project as it is now, renamed and recoloured since its usage', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'], tokens: { inputTokens: 100, outputTokens: 0 } }]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);

    await main.api.invoke('projects.edit', { id: project.id, name: 'Loom app', color: 'magenta' });

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });
    expect(dashboard.perPlace).toEqual([{ key: `project:${project.id}`, projectId: project.id, label: 'Loom app', color: 'magenta', tokens: 100 }]);
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

describe("usage from OpenCode's own records", () => {
  const SONNET = { providerID: 'anthropic', id: 'claude-sonnet-5-5' };
  const HAIKU = { providerID: 'anthropic', id: 'claude-haiku-5-5' };

  /** A machine whose OpenCode lists its sessions and their steps, as OpenCode 2.4.2 does. */
  function recordsMachine(turns: AcpTurn[], highlightTurns: AcpTurn[] = [], sessionList = true): { machine: Machine; checkout: string } {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.4.2', integrations: signedIn, models, sessionList, acp: { turns, highlightTurns } });
    const { checkout } = machine.setUp('loom', (m) => {
      const checkout = m.gitRepo('loom');
      m.commit(checkout, 'README.md', '# loom\n');
      return { checkout };
    });
    return { machine, checkout };
  }

  /** Starts Loom now, in real time, as OpenCode stamps its steps. */
  const startNow = (machine: Machine, checkout: string, options: { userDataDir?: string } = {}) => start(machine, checkout, { now: Date.now(), ...options });

  /** The dashboard once Loom has read the records the dashboard asks it to, and counted the past. */
  async function settled(main: MainHarness, days: 7 | 30 | 90 = 7) {
    await main.api.invoke('usage.read');
    await waitFor(main.api, 'usage', (u) => !u.counting);
    return main.api.invoke('usage.dashboard', { days });
  }

  it('counts the Session’s Subagents and the runs its agent starts on its own, once, as the Session’s', async () => {
    const { machine, checkout } = recordsMachine([
      {
        chunks: ['Done.'],
        tokens: { inputTokens: 1000, outputTokens: 200 },
        cost: 0.1,
        // What ACP never reports: a Subagent's usage, and the run on its result.
        records: [
          { id: 'ses_child', parentId: '$ROOT', tokens: { inputTokens: 500, outputTokens: 50 }, cost: 0.05, model: HAIKU },
          { id: 'ses_grandchild', parentId: 'ses_child', tokens: { inputTokens: 20, outputTokens: 2 } },
          { id: '$ROOT', tokens: { inputTokens: 300, outputTokens: 30 }, cost: 0.15 },
        ],
      },
    ]);
    const { main, project } = await startNow(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);

    const dashboard = await settled(main);
    const again = await settled(main);

    expect(dashboard.tokens).toBe(1200 + 550 + 22 + 330);
    expect(dashboard.reportedCost).toBeCloseTo(0.2);
    expect(dashboard.perModel).toEqual([
      { model: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tokens: 1552 },
      { model: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5', tokens: 550 },
    ]);
    expect(dashboard.topSessions).toMatchObject([{ sessionId: id, tokens: 2102 }]);
    expect(dashboard.perDay.at(-1)!.tokens).toBe(2102);
    expect(dashboard.perPlace.map((p) => p.key)).toEqual([`project:${project.id}`]);
    expect(again).toEqual(dashboard);
    const session = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(session.usage).toMatchObject({ tokens: 2102, reportedCost: expect.closeTo(0.2) as number });
  });

  it('counts use outside Loom with the rest, from before Loom first read the records too, each step on the day it completed', async () => {
    const { machine, checkout } = recordsMachine([]);
    const now = Date.now();
    machine.useOpencodeOutsideLoom('ses_mine', { inputTokens: 9000, outputTokens: 900 }, SONNET, { at: now - 40 * DAY_MS, title: { inputTokens: 400, outputTokens: 5 } });
    machine.useOpencodeOutsideLoom('ses_mine', { inputTokens: 3000, outputTokens: 300 }, SONNET, { at: now - 3 * DAY_MS, cost: 0.5 });
    const { main } = await startNow(machine, checkout);

    const week = await settled(main, 7);
    expect(week.tokens).toBe(3300);
    expect(week.reportedCost).toBeCloseTo(0.5);
    expect(week.perModel).toEqual([{ model: 'anthropic/claude-sonnet-5-5', tokens: 3300 }]);
    expect(week.mix).toEqual({ input: 3000, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect(week.perPlace).toEqual([{ key: 'folder:native:/home/dev', label: 'dev', folder: '/home/dev', color: 'blue', tokens: 3300 }]);
    expect(week.perDay.at(-4)).toMatchObject({ tokens: 3300, byPlace: { 'folder:native:/home/dev': 3300 } });
    // The session's title, which OpenCode counts in its total but in no step, goes with its first step.
    expect((await settled(main, 90)).tokens).toBe(9900 + 405 + 3300);

    machine.useOpencodeOutsideLoom('ses_mine', { inputTokens: 100, outputTokens: 10 }, SONNET, { cost: 0.52 });
    machine.useOpencodeOutsideLoom('ses_other', { inputTokens: 40, outputTokens: 4 }, HAIKU, { title: { inputTokens: 6, outputTokens: 1 } });
    const later = await settled(main, 7);

    expect(later.tokens).toBe(3300 + 110 + 51);
    expect(later.reportedCost).toBeCloseTo(0.52);
    expect(later.perModel).toEqual([
      { model: 'anthropic/claude-sonnet-5-5', tokens: 3410 },
      { model: 'anthropic/claude-haiku-5-5', tokens: 51 },
    ]);
    expect(later.topSessions).toEqual([]);
  });

  it('names the models used only outside Loom as the agent names them to Loom', async () => {
    const { machine, checkout } = recordsMachine([{ chunks: ['Done.'], tokens: { inputTokens: 1000, outputTokens: 200 } }]);
    const { main, project } = await startNow(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);
    machine.useOpencodeOutsideLoom('ses_mine', { inputTokens: 5000, outputTokens: 500, cachedReadTokens: 2000 }, HAIKU, { at: Date.now() - HOUR_MS });

    const dashboard = await settled(main);

    expect(dashboard.perModel).toEqual([
      { model: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5', tokens: 7500 },
      { model: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tokens: 1200 },
    ]);
    expect(dashboard.mix).toEqual({ input: 6000, output: 700, reasoning: 0, cacheRead: 2000, cacheWrite: 0 });
    expect(dashboard.cacheHitRate).toBeCloseTo(2000 / 8000);
  });

  it('puts use outside Loom under the Project it ran in, else under its folder, the smallest folders together', async () => {
    const { machine, checkout } = recordsMachine([]);
    const { main, project } = await startNow(machine, checkout);
    machine.useOpencodeOutsideLoom('ses_in_checkout', { inputTokens: 500, outputTokens: 50 }, SONNET, { directory: `${project.checkout.path}/src` });
    const folders = [
      ['/home/me/notes', 220],
      ['/w/a', 100],
      ['/w/b', 90],
      ['/w/c', 80],
      ['/w/d', 70],
      ['/w/e', 5],
      ['/w/f', 4],
    ] as const;
    for (const [directory, tokens] of folders) machine.useOpencodeOutsideLoom(`ses_${directory.replaceAll('/', '_')}`, { inputTokens: tokens, outputTokens: 0 }, SONNET, { directory });

    const dashboard = await settled(main);

    expect(dashboard.tokens).toBe(550 + 220 + 100 + 90 + 80 + 70 + 5 + 4);
    expect(dashboard.perPlace.map(({ key, label, tokens }) => [key, label, tokens])).toEqual([
      [`project:${project.id}`, 'loom', 550],
      ['folder:native:/home/me/notes', 'notes', 220],
      ['folder:native:/w/a', 'a', 100],
      ['folder:native:/w/b', 'b', 90],
      ['folder:native:/w/c', 'c', 80],
      ['folder:native:/w/d', 'd', 70],
      ['other', 'Other folders', 9],
    ]);
    expect(dashboard.perPlace[0]).toEqual({ key: `project:${project.id}`, projectId: project.id, label: 'loom', color: project.color, tokens: 550 });
    expect(dashboard.perPlace[1]).toMatchObject({ folder: '/home/me/notes' });
    const colors = dashboard.perPlace.map((p) => p.color).filter(Boolean);
    expect(new Set(colors).size).toBe(colors.length);
    expect(dashboard.perPlace.at(-1)!.color).toBeUndefined();
    expect(dashboard.perDay.at(-1)!.byPlace).toMatchObject({ [`project:${project.id}`]: 550, 'folder:native:/home/me/notes': 220, other: 9 });
  });

  it('counts the Sessions the user started outside Loom and their runs, from the prompt to the reply', async () => {
    const { machine, checkout } = recordsMachine([]);
    const now = Date.now();
    machine.useOpencodeOutsideLoom('ses_a', { inputTokens: 11, outputTokens: 1 }, SONNET, { at: now - 2 * HOUR_MS, took: 1000, finish: 'tool-calls', directory: '/home/me/a' });
    machine.useOpencodeOutsideLoom('ses_a', { inputTokens: 12, outputTokens: 1 }, SONNET, { at: now - 2 * HOUR_MS + 5000, took: 2000 });
    machine.useOpencodeOutsideLoom('ses_a', { inputTokens: 13, outputTokens: 1 }, SONNET, { at: now - HOUR_MS, took: 4000 });
    machine.useOpencodeOutsideLoom('ses_b', { inputTokens: 14, outputTokens: 1 }, SONNET, { at: now - HOUR_MS, took: 10_000, directory: '/home/me/b' });
    machine.useOpencodeOutsideLoom('ses_check', { inputTokens: 15, outputTokens: 1 }, SONNET, { at: now - HOUR_MS, took: 50_000, directory: '/tmp/loom-highlights' });
    const { main } = await startNow(machine, checkout);

    const past = await settled(main);
    expect(past).toMatchObject({ sessionsStarted: 0, outsideConversationsStarted: 2, medianRunMs: 6000 });

    machine.useOpencodeOutsideLoom('ses_c', { inputTokens: 16, outputTokens: 1 }, SONNET, { at: now - 30 * 60_000, took: 8000, directory: '/home/me/c' });
    machine.useOpencodeOutsideLoom('ses_d', { inputTokens: 17, outputTokens: 1 }, SONNET, { at: now - 20 * 60_000, took: 1000, finish: 'tool-calls', directory: '/home/me/d' });
    await settled(main);
    machine.useOpencodeOutsideLoom('ses_d', { inputTokens: 18, outputTokens: 1 }, SONNET, { at: now - 10 * 60_000, took: 1000 });
    const later = await settled(main);

    expect(later).toMatchObject({ sessionsStarted: 0, outsideConversationsStarted: 4, medianRunMs: 8000 });
  });

  it("leaves out what ran in Loom's own folders outside its Sessions", async () => {
    const { machine, checkout } = recordsMachine([]);
    const { main } = await startNow(machine, checkout);
    machine.useOpencodeOutsideLoom('ses_check', { inputTokens: 70, outputTokens: 7 }, HAIKU, { directory: '/tmp/loom-highlights' });
    machine.useOpencodeOutsideLoom('ses_mine', { inputTokens: 10, outputTokens: 1 }, HAIKU);

    const dashboard = await settled(main);

    expect(dashboard.tokens).toBe(11);
  });

  it("moves what a conversation counted outside Loom to the Session that turns out to be its", async () => {
    const { machine, checkout } = recordsMachine([{ chunks: ['Done.'], tokens: { inputTokens: 1000, outputTokens: 200 } }]);
    const userDataDir = tempDir('loom-usage-');
    const first = await startNow(machine, checkout, { userDataDir });
    const { id } = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(first.main, id);
    expect((await settled(first.main)).tokens).toBe(1200);
    await first.main.close();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("update agent_conversations set owner = 'outside', session_id = null, seen_through = 0").run();
    db.prepare(
      "insert into outside_usage (agent, environment_id, directory, day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost) select 'OpenCode', 'native', '/home/dev', day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost from usage_buckets",
    ).run();
    db.prepare('delete from usage_buckets').run();
    db.close();

    const later = await startMain({ machine, userDataDir, now: Date.now() });
    await waitFor(later.api, 'environments', ready);
    const dashboard = await settled(later);

    expect(dashboard.tokens).toBe(1200);
    expect(dashboard.perPlace.map((p) => [p.key, p.tokens])).toEqual([[`project:${first.project.id}`, 1200]]);
    expect(dashboard.topSessions).toMatchObject([{ sessionId: id, tokens: 1200 }]);
  });

  it('counts use outside Loom again by folder after an upgrade from the release that counted it apart, nothing twice', async () => {
    const { machine, checkout } = recordsMachine([]);
    const DAY_ONE = Date.now() - 2 * DAY_MS;
    const DAY_TWO = Date.now() - DAY_MS;
    machine.useOpencodeOutsideLoom('ses_mine', { inputTokens: 1000, outputTokens: 100 }, SONNET, { at: DAY_ONE, title: { inputTokens: 40, outputTokens: 2 }, directory: checkout });
    machine.useOpencodeOutsideLoom('ses_mine', { inputTokens: 500, outputTokens: 50 }, SONNET, { at: DAY_TWO });
    const seen = Date.now();
    const userDataDir = tempDir('loom-usage-');
    await (await openDatabase(userDataDir, { migrations: migrations.slice(0, -1) })).destroy();
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare("insert into projects (id, name, branch_prefix, created_at) values (1, 'loom', 'loom', 0)").run();
    db.prepare("insert into checkouts (project_id, environment_id, path) values (1, 'native', ?)").run(checkout);
    db.prepare("insert into usage_syncs (agent, environment_id, synced_through) values ('OpenCode', 'native', ?)").run(seen);
    db.prepare(
      "insert into agent_conversations (agent, environment_id, id, owner, session_id, seen_through, counted_through, counted_step, backfill_through, model, past_total, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost) values ('OpenCode', 'native', 'ses_mine', 'outside', null, ?, ?, ?, null, 'anthropic/claude-sonnet-5-5', null, 1540, 152, 0, 0, 0, 0)",
    ).run(seen, DAY_TWO, `msg_${String(DAY_TWO).padStart(15, '0')}_1`);
    const day = (at: number) => new Date(at).toLocaleDateString('sv');
    db.prepare("insert into outside_usage (agent, day, model, input_tokens, output_tokens) values ('OpenCode', ?, 'anthropic/claude-sonnet-5-5', 1040, 102)").run(day(DAY_ONE));
    db.prepare("insert into outside_usage (agent, day, model, input_tokens, output_tokens) values ('OpenCode', ?, 'anthropic/claude-sonnet-5-5', 500, 50)").run(day(DAY_TWO));
    for (const [at, input, output] of [[DAY_ONE, 1000, 100], [DAY_TWO, 500, 50]] as const) db.prepare("insert into usage_steps (agent, environment_id, print) values ('OpenCode', 'native', ?)").run(`${at}:anthropic/claude-sonnet-5-5:${input}:${output}:0:0:0`);
    db.close();
    machine.useOpencodeOutsideLoom('ses_mine', { inputTokens: 10, outputTokens: 1 }, SONNET);

    const main = await startMain({ machine, userDataDir, now: Date.now() });
    await waitFor(main.api, 'environments', ready);
    const dashboard = await settled(main);

    expect(dashboard.tokens).toBe(1142 + 550 + 11);
    expect(dashboard.perPlace).toEqual([{ key: 'project:1', projectId: 1, label: 'loom', color: 'blue', tokens: 1142 + 550 + 11 }]);
    expect(dashboard.perDay.at(-3)!.tokens).toBe(1142);
    expect(dashboard.perDay.at(-2)!.tokens).toBe(550);
    expect(await settled(main)).toEqual(dashboard);
  });

  it('counts the past of Sessions Loom counted from their runs only what the runs missed, and leaves out its own folders', async () => {
    const turns: AcpTurn[] = [
      {
        chunks: ['Done.'],
        tokens: { inputTokens: 1000, outputTokens: 200 },
        records: [
          { id: 'ses_child', parentId: '$ROOT', tokens: { inputTokens: 500, outputTokens: 50 } },
          { id: '$ROOT', tokens: { inputTokens: 300, outputTokens: 30 } },
        ],
      },
    ];
    // An OpenCode that can't list its sessions: Loom counts what the runs report.
    const { machine, checkout } = recordsMachine(turns, [], false);
    const userDataDir = tempDir('loom-usage-');
    const first = await startNow(machine, checkout, { userDataDir });
    const { id } = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(first.main, id);
    expect((await first.main.api.invoke('usage.dashboard', { days: 7 })).tokens).toBe(1200);
    await first.main.close();
    // A Session highlights check that ran then, its usage reported by its run.
    machine.useOpencodeOutsideLoom('ses_check', { inputTokens: 70, outputTokens: 7 }, HAIKU, { directory: '/tmp/loom-highlights' });

    // OpenCode is upgraded to one that lists them.
    machine.installOpencode({ version: 'opencode v2.4.2', integrations: signedIn, models, sessionList: true, acp: { turns } });
    const later = await startMain({ machine, userDataDir, now: Date.now() });
    await waitFor(later.api, 'environments', ready);
    const dashboard = await settled(later);

    expect(dashboard.tokens).toBe(1200 + 550 + 330);
    expect(dashboard.topSessions).toMatchObject([{ sessionId: id, tokens: 2080 }]);
    const session = (await later.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(session.usage?.tokens).toBe(2080);
    expect(await settled(later)).toEqual(dashboard);
  });

  it('counts a conversation whose steps are too big to list from its total, as of its last change', async () => {
    const { machine, checkout } = recordsMachine([]);
    const now = Date.now();
    machine.useOpencodeOutsideLoom('ses_huge', { inputTokens: 5000, outputTokens: 500 }, SONNET, { at: now - 2 * DAY_MS, tooBig: true });
    const { main } = await startNow(machine, checkout);
    expect((await settled(main)).tokens).toBe(5500);

    machine.useOpencodeOutsideLoom('ses_huge', { inputTokens: 100, outputTokens: 10 }, SONNET, { tooBig: true });
    const dashboard = await settled(main);

    expect(dashboard.tokens).toBe(5610);
  });

  it('counts the steps a forked session copied from its parent once', async () => {
    const { machine, checkout } = recordsMachine([]);
    const now = Date.now();
    machine.useOpencodeOutsideLoom('ses_original', { inputTokens: 1000, outputTokens: 100 }, SONNET, { at: now - 2 * DAY_MS });
    machine.forkOpencodeSession('ses_original', 'ses_early_fork');
    const { main } = await startNow(machine, checkout);
    expect((await settled(main)).tokens).toBe(1100);

    machine.forkOpencodeSession('ses_original', 'ses_fork');
    machine.useOpencodeOutsideLoom('ses_fork', { inputTokens: 40, outputTokens: 4 }, SONNET);
    const dashboard = await settled(main);

    expect(dashboard.tokens).toBe(1144);
  });

  it("counts Session highlights' checks as theirs, not as use outside Loom", async () => {
    const { machine, checkout } = recordsMachine(
      [{ chunks: ['Done.'], tokens: { inputTokens: 1000, outputTokens: 200 } }],
      [{ chunks: ['{"add":[{"kind":"risk","text":"Watch the cache."}],"resolve":[]}'], tokens: { inputTokens: 300, outputTokens: 50 } }],
    );
    const { main, project } = await startNow(machine, checkout);
    await main.api.invoke('settings.setHighlights', { on: true, model: 'anthropic/claude-haiku-5-5' });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'highlights', (h) => !h.checking && h.highlights.length === 1, { sessionId: id });

    const dashboard = await settled(main);

    expect(dashboard.tokens).toBe(1550);
    expect(dashboard.topSessions.map((s) => s.tokens)).toEqual([1200]);
    expect(dashboard.perPlace.map((p) => p.key)).toEqual([`project:${project.id}`]);
  });

  it('counts nothing again after a restart', async () => {
    const { machine, checkout } = recordsMachine([{ chunks: ['Done.'], tokens: { inputTokens: 1000, outputTokens: 200 } }]);
    const userDataDir = tempDir('loom-usage-');
    const first = await startNow(machine, checkout, { userDataDir });
    const { id } = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(first.main, id);
    expect((await settled(first.main)).tokens).toBe(1200);
    await first.main.close();

    const later = await startMain({ machine, userDataDir, now: Date.now() });
    await waitFor(later.api, 'environments', ready);
    machine.useOpencodeOutsideLoom('ses_mine', { inputTokens: 10, outputTokens: 1 }, SONNET);
    const dashboard = await settled(later);

    expect(dashboard.tokens).toBe(1211);
    expect(dashboard.topSessions.map((s) => s.tokens)).toEqual([1200]);
  });

  it('counts what the runs report when OpenCode can’t list its sessions', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'], tokens: { inputTokens: 1000, outputTokens: 200 } }]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waiting(main, id);

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });

    expect(dashboard.tokens).toBe(1200);
    expect((await waitFor(main.api, 'usage', (u) => !u.counting)).counting).toBe(false);
  });
});
