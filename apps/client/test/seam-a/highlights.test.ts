import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type AcpMessage, type AcpTurn, type MainHarness, type Machine } from './harness';
import type { EnvironmentStatus, Session, SessionHighlights } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];
const models = [
  { providerID: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 200_000 },
  { providerID: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', context: 200_000, variants: ['low', 'high'] },
];
const CHEAP = 'anthropic/claude-haiku-5-5';

/** A check's answer, as the model gives it. */
const answer = (value: unknown, extra: Partial<AcpTurn> = {}): AcpTurn => ({ chunks: ['```json\n', JSON.stringify(value), '\n```'], ...extra });

function machineWith(turns: AcpTurn[], highlightTurns: AcpTurn[] = []): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, models, acp: { turns, highlightTurns } });
  const { checkout } = machine.setUp('loom', (m) => {
    const checkout = m.gitRepo('loom');
    m.commit(checkout, 'README.md', '# loom\n');
    return { checkout };
  });
  return { machine, checkout };
}

async function start(machine: Machine, checkout: string, options: { userDataDir?: string } = {}) {
  const main = await startMain({ machine, ...options });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

const sessionWhere = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

const waiting = (main: MainHarness, id: number) => waitFor(main.api, 'sessions', sessionWhere(id, (s) => s.status === 'waiting'));

/** Waits until the Session's Highlights satisfy `check`, no check running. */
const highlightsWhere = (main: MainHarness, id: number, check: (h: SessionHighlights) => boolean) => waitFor(main.api, 'highlights', (h) => !h.checking && check(h), { sessionId: id });

/** The prompts Session highlights' checks were sent, in order: those of the processes with every tool denied. */
function checkPrompts(machine: Machine): string[] {
  return checkMessages(machine)
    .filter((m) => m.message.method === 'session/prompt')
    .map((m) => ((m.message.params?.prompt as Array<{ text?: string }>) ?? []).map((b) => b.text ?? '').join(''));
}

function checkMessages(machine: Machine): AcpMessage[] {
  return machine.acpMessages().filter((m) => m.config && JSON.parse(m.config).permission?.['*'] === 'deny');
}

describe('Session highlights', () => {
  it('is off until the user turns it on with a model, and then checks nothing', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const { main, project } = await start(machine, checkout);
    expect((await main.api.invoke('sessions.list')).length).toBe(0);
    await expect(main.api.invoke('settings.setHighlights', { on: true })).rejects.toThrow(/Pick the model/);

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    const session = await waiting(main, id);
    await main.api.invoke('usage.dashboard', { days: 7 });

    expect(session.find((s) => s.id === id)!.highlights).toBeUndefined();
    expect(checkMessages(machine)).toEqual([]);
  });

  it('checks each turn with the model picked, every tool refused, and keeps what it notes', async () => {
    const { machine, checkout } = machineWith(
      [{ chunks: ['I switched the session store to Redis; you need to set REDIS_URL.'] }],
      [answer({ add: [{ kind: 'for-you', text: 'Set REDIS_URL before deploying.' }, { kind: 'wish', text: 'Not a kind Loom has.' }], resolve: [] })],
    );
    const { main, project } = await start(machine, checkout);
    const settings = await main.api.invoke('settings.setHighlights', { on: true, model: CHEAP, effort: 'low' });
    expect(settings.highlights).toEqual({ on: true, model: CHEAP, effort: 'low' });

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Move sessions to Redis' });
    const found = await highlightsWhere(main, id, (h) => h.highlights.length > 0);

    const items = await waitFor(main.api, 'transcript', (list) => list.length > 0, { sessionId: id });
    expect(found.highlights).toEqual([{ id: expect.any(Number), kind: 'for-you', text: 'Set REDIS_URL before deploying.', itemId: items.find((i) => i.kind === 'user')!.id, createdAt: expect.any(Number) }]);
    expect(found.error).toBeUndefined();
    await waitFor(main.api, 'sessions', sessionWhere(id, (s) => s.highlights?.count === 1 && s.highlights.unseen === 1));

    const messages = checkMessages(machine);
    const configs = messages.filter((m) => m.message.method === 'session/set_config_option').map((m) => m.message.params?.value);
    expect(configs).toEqual([CHEAP, 'low']);
    // Away from the working copy and its instructions, in the Environment's temp directory.
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.cwd !== checkout)).toBe(true);
    const [prompt] = checkPrompts(machine);
    expect(prompt).toContain('User: Move sessions to Redis');
    expect(prompt).toContain('Agent: I switched the session store to Redis; you need to set REDIS_URL.');
    expect(prompt).toContain('Open Highlights:\n(none)');
    // The Session's own conversation is left as it was.
    expect(items.filter((i) => i.kind === 'agent').map((i) => (i as { text: string }).text)).toEqual(['I switched the session store to Redis; you need to set REDIS_URL.']);

    await main.api.invoke('sessions.seeHighlights', { id });
    await waitFor(main.api, 'sessions', sessionWhere(id, (s) => s.highlights?.count === 1 && s.highlights.unseen === 0));
  });

  it('resolves what a later turn settles, and the user can resolve and reopen one', async () => {
    const { machine, checkout } = machineWith(
      [{ chunks: ['Skipped the e2e tests for now.'] }, { chunks: ['Added the e2e tests.'] }],
      [
        answer({ add: [{ kind: 'not-done', text: 'The e2e tests were skipped.' }, { kind: 'decision', text: 'Kept the old API.' }], resolve: [] }),
        // The first Highlight of a new database is 1.
        answer({ add: [], resolve: [{ id: 1, reason: 'The e2e tests were added.' }, { id: 999, reason: 'No such Highlight.' }] }),
      ],
    );
    const { main, project } = await start(machine, checkout);
    await main.api.invoke('settings.setHighlights', { on: true, model: CHEAP });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Add tests' });
    const first = await highlightsWhere(main, id, (h) => h.highlights.length === 2);
    const [skipped, kept] = first.highlights;
    expect(skipped!.id).toBe(1);
    await main.api.invoke('sessions.send', { id, prompt: 'Add the e2e tests too' });
    const second = await highlightsWhere(main, id, (h) => h.highlights.some((x) => x.resolved));
    const secondTurn = (await waitFor(main.api, 'transcript', (list) => list.filter((i) => i.kind === 'user').length === 2, { sessionId: id })).filter((i) => i.kind === 'user')[1]!;
    expect(second.highlights.find((h) => h.id === skipped!.id)!.resolved).toEqual({ by: 'model', reason: 'The e2e tests were added.', itemId: secondTurn.id, at: expect.any(Number) });
    expect(checkPrompts(machine).at(-1)).toContain(`#${skipped!.id} [not-done] The e2e tests were skipped.`);

    await main.api.invoke('sessions.resolveHighlight', { id, highlightId: kept!.id, resolved: true });
    expect((await highlightsWhere(main, id, () => true)).highlights.find((h) => h.id === kept!.id)!.resolved).toEqual({ by: 'user', at: expect.any(Number) });
    await main.api.invoke('sessions.resolveHighlight', { id, highlightId: skipped!.id, resolved: false });
    expect((await highlightsWhere(main, id, () => true)).highlights.find((h) => h.id === skipped!.id)!.resolved).toBeUndefined();
    await expect(main.api.invoke('sessions.resolveHighlight', { id, highlightId: 12345, resolved: true })).rejects.toThrow(/no Highlight/);
  });

  it('says why a check failed, and checks its turn again with the next', async () => {
    const { machine, checkout } = machineWith(
      [{ chunks: ['First reply.'] }, { chunks: ['Second reply.'] }],
      [{ chunks: ['Sorry, I cannot help with that.'] }, answer({ add: [{ kind: 'risk', text: 'Both turns were read.' }], resolve: [] })],
    );
    const { main, project } = await start(machine, checkout);
    await main.api.invoke('settings.setHighlights', { on: true, model: CHEAP });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First prompt' });
    const failed = await highlightsWhere(main, id, (h) => h.error !== undefined);
    expect(failed.error).toMatch(/didn't answer as asked/);
    expect(failed.highlights).toEqual([]);

    await main.api.invoke('sessions.send', { id, prompt: 'Second prompt' });
    const after = await highlightsWhere(main, id, (h) => h.highlights.length === 1);
    expect(after.error).toBeUndefined();
    const prompt = checkPrompts(machine)[1]!;
    expect(prompt).toContain('User: First prompt');
    expect(prompt).toContain('User: Second prompt');
  });

  it('checks a turn that ends during a check with the next one, never twice', async () => {
    const { machine, checkout } = machineWith(
      [{ chunks: ['One.'] }, { chunks: ['Two.'] }],
      [answer({ add: [], resolve: [] }, { hold: 'first-check' }), answer({ add: [{ kind: 'decision', text: 'From turn two.' }], resolve: [] })],
    );
    const { main, project } = await start(machine, checkout);
    await main.api.invoke('settings.setHighlights', { on: true, model: CHEAP });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Prompt one' });
    await waitFor(main.api, 'highlights', (h) => h.checking, { sessionId: id });
    await main.api.invoke('sessions.send', { id, prompt: 'Prompt two' });
    await waiting(main, id);
    machine.release('first-check');

    await highlightsWhere(main, id, (h) => h.highlights.length === 1);
    const prompts = checkPrompts(machine);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('User: Prompt one');
    expect(prompts[0]).not.toContain('Prompt two');
    expect(prompts[1]).toContain('User: Prompt two');
    expect(prompts[1]).not.toContain('Prompt one');
  });

  it('passes over the turns that end while it is off, even during a check', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['One.'] }, { chunks: ['Two.'] }, { chunks: ['Three.'] }], [answer({ add: [], resolve: [] }, { hold: 'first-check' })]);
    const { main, project } = await start(machine, checkout);
    await main.api.invoke('settings.setHighlights', { on: true, model: CHEAP });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Prompt one' });
    await waitFor(main.api, 'highlights', (h) => h.checking, { sessionId: id });
    await main.api.invoke('settings.setHighlights', { on: false, model: CHEAP });
    await main.api.invoke('sessions.send', { id, prompt: 'Prompt two' });
    await waiting(main, id);
    machine.release('first-check');
    await highlightsWhere(main, id, () => true);

    await main.api.invoke('settings.setHighlights', { on: true, model: CHEAP });
    await main.api.invoke('sessions.send', { id, prompt: 'Prompt three' });
    await waiting(main, id);
    await waitFor(main.api, 'highlights', () => checkPrompts(machine).length === 2, { sessionId: id });
    await highlightsWhere(main, id, () => true);
    expect(checkPrompts(machine)[1]).toContain('User: Prompt three');
    expect(checkPrompts(machine)[1]).not.toContain('Prompt two');
  });

  it('starts from the next turn when turned on, without going back over the Session', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Before.'] }, { chunks: ['After.'] }]);
    const { main, project } = await start(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Before it was on' });
    await waiting(main, id);
    await main.api.invoke('settings.setHighlights', { on: true, model: CHEAP });
    await waitFor(main.api, 'sessions', sessionWhere(id, (s) => s.highlights?.count === 0));

    await main.api.invoke('sessions.send', { id, prompt: 'After it was on' });
    await waiting(main, id);
    await waitFor(main.api, 'highlights', () => checkPrompts(machine).length === 1, { sessionId: id });
    await highlightsWhere(main, id, () => true);
    expect(checkPrompts(machine)[0]).toContain('User: After it was on');
    expect(checkPrompts(machine)[0]).not.toContain('Before it was on');
  });

  it("counts its checks' usage on the dashboard under their model, but not as the Session's", async () => {
    const { machine, checkout } = machineWith(
      [{ chunks: ['Done.'], tokens: { inputTokens: 1000, outputTokens: 200 }, cost: 0.1 }],
      [answer({ add: [{ kind: 'risk', text: 'Watch the cache.' }], resolve: [] }, { tokens: { inputTokens: 300, outputTokens: 50 }, cost: 0.01 })],
    );
    const { main, project } = await start(machine, checkout);
    await main.api.invoke('settings.setHighlights', { on: true, model: CHEAP });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await highlightsWhere(main, id, (h) => h.highlights.length === 1);

    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });
    expect(dashboard.tokens).toBe(1550);
    expect(dashboard.reportedCost).toBeCloseTo(0.11);
    expect(dashboard.perModel).toEqual([
      { model: 'anthropic/claude-sonnet-5-5', tokens: 1200 },
      { model: CHEAP, tokens: 350 },
    ]);
    expect(dashboard.perProject).toEqual([{ projectId: project.id, project: 'loom', tokens: 1550 }]);
    expect(dashboard.topSessions.map((s) => s.tokens)).toEqual([1200]);
    const session = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(session.usage?.tokens).toBe(1200);
  });

  it('keeps Highlights across restarts, and drops them with a deleted Session, its usage kept', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }], [answer({ add: [{ kind: 'assumption', text: 'Assumed UTC.' }], resolve: [] }, { tokens: { inputTokens: 10, outputTokens: 5 } })]);
    const userDataDir = tempDir('loom-highlights-');
    const first = await start(machine, checkout, { userDataDir });
    await first.main.api.invoke('settings.setHighlights', { on: true, model: CHEAP });
    const { id } = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'checkout', prompt: 'Parse dates' });
    await highlightsWhere(first.main, id, (h) => h.highlights.length === 1);
    await first.main.close();

    const main = await startMain({ machine, userDataDir });
    await waitFor(main.api, 'environments', ready);
    const kept = await highlightsWhere(main, id, (h) => h.highlights.length === 1);
    expect(kept.highlights[0]!.text).toBe('Assumed UTC.');
    await waitFor(main.api, 'sessions', sessionWhere(id, (s) => s.highlights?.count === 1));

    await main.api.invoke('sessions.delete', { id });
    expect(() => main.api.subscribe('highlights', () => {}, { sessionId: id })).toThrow(/unknown Session/);
    expect((await main.api.invoke('usage.dashboard', { days: 7 })).perModel).toContainEqual({ model: CHEAP, tokens: 15 });
  });
});
