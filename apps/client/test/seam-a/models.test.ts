import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type AcpTurn, type Machine, type StandInModel } from './harness';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

// The first is OpenCode's default for a new session.
const models: StandInModel[] = [
  { providerID: 'opencode', id: 'pulse-free', name: 'Pulse Free', context: 128_000 },
  { providerID: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', variants: ['low', 'high', 'max'], context: 200_000 },
  { providerID: 'openai', id: 'gpt-old', name: 'GPT Old', enabled: false },
];

/** A machine with a ready OpenCode offering `models` and playing `turns`, and a git checkout. */
function machineWith(turns: AcpTurn[] = [], acp: { holdConfig?: string } = {}): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, models, acp: { turns, ...acp } });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

async function withProject(machine: Machine, checkout: string) {
  const main = await startMain({ machine });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

const modelListings = (machine: Machine) => machine.opencodeRequests().filter((r) => r.path === '/api/model');

describe('the models before a Session exists', () => {
  it("lists the models OpenCode offers in the Project's checkout, as provider/model with their Effort levels, leaving out those turned off", async () => {
    const { machine, checkout } = machineWith();
    const { main, project } = await withProject(machine, checkout);

    const listed = await main.api.invoke('projects.models', { id: project.id });

    expect(listed).toEqual([
      { id: 'opencode/pulse-free', name: 'Pulse Free', efforts: [] },
      { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'high', 'max', 'default'] },
    ]);
    expect(modelListings(machine)).toEqual([{ method: 'GET', path: '/api/model', directory: checkout }]);
  });

  it('asks OpenCode once per checkout, until the agent is checked again', async () => {
    const { machine, checkout } = machineWith();
    const { main, project } = await withProject(machine, checkout);

    await main.api.invoke('projects.models', { id: project.id });
    await main.api.invoke('projects.models', { id: project.id });
    expect(modelListings(machine)).toHaveLength(1);

    await main.api.invoke('environments.detect');
    await main.api.invoke('projects.models', { id: project.id });
    expect(modelListings(machine)).toHaveLength(2);
  });

  it('never runs `opencode models`', async () => {
    const { machine, checkout } = machineWith();
    const { main, project } = await withProject(machine, checkout);

    await main.api.invoke('projects.models', { id: project.id });

    expect(machine.opencodeInvocations().map((argv) => argv[0])).not.toContain('models');
  });
});

/** What the agent was asked, in order: ACP methods, config options with their values. */
const asked = (machine: Machine) =>
  machine
    .acpMessages()
    .filter((m) => m.message.method !== undefined)
    .map(({ message: { method, params } }) => (method === 'session/set_config_option' ? `${params!.configId}=${String(params!.value)}` : method));

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

const finished = (s: Session) => s.status === 'waiting' && s.waitingReason === 'finished';

describe('the model and Effort a Session starts on', () => {
  it('sets the model and Effort picked through ACP config options before the first prompt, then offers what the agent offers', async () => {
    const { machine, checkout } = machineWith();
    const { main, project } = await withProject(machine, checkout);

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Hi', model: 'anthropic/claude-sonnet-5-5', effort: 'high' });

    const done = (await waitFor(main.api, 'sessions', session(id, finished))).find((s) => s.id === id)!;
    expect(asked(machine)).toEqual(['initialize', 'session/new', 'model=anthropic/claude-sonnet-5-5', 'effort=high', 'session/prompt']);
    expect(done).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', effort: 'high' });
    expect(done.agentConfig).toEqual({
      model: 'anthropic/claude-sonnet-5-5',
      models: [
        { id: 'opencode/pulse-free', name: 'Pulse Free' },
        { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      ],
      effort: 'high',
      efforts: ['low', 'high', 'max', 'default'],
    });
  });

  it("leaves the agent's own model and Effort when none is picked", async () => {
    const { machine, checkout } = machineWith();
    const { main, project } = await withProject(machine, checkout);

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Hi' });

    const done = (await waitFor(main.api, 'sessions', session(id, finished))).find((s) => s.id === id)!;
    expect(asked(machine)).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(done.model).toBeUndefined();
    expect(done.agentConfig).toMatchObject({ model: 'opencode/pulse-free', efforts: [] });
    expect(done.agentConfig?.effort).toBeUndefined();
  });

  it('fails the first run, Waiting on an error, when the agent refuses the model picked', async () => {
    const { machine, checkout } = machineWith();
    const { main, project } = await withProject(machine, checkout);

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Hi', model: 'openai/gpt-old' });

    const failed = (await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'error'))).find((s) => s.id === id)!;
    expect(failed.error).toContain('openai/gpt-old');
    expect(asked(machine)).not.toContain('session/prompt');
  });
});

/** A checkout Session started without a pick, once its first run has finished. */
async function finishedSession(machine: Machine, checkout: string) {
  const { main, project } = await withProject(machine, checkout);
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
  await waitFor(main.api, 'sessions', session(id, finished));
  return { main, id };
}

/** Resolves once `check` holds, polling: for what only the stand-in's logs show. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const markers = (items: TranscriptItem[]) => items.filter((i) => i.kind === 'model');

describe('changing the model and Effort between runs', () => {
  it('applies from the next prompt, adding a marker to the timeline for each change', async () => {
    const { machine, checkout } = machineWith();
    const { main, id } = await finishedSession(machine, checkout);

    await main.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-sonnet-5-5' });
    await main.api.invoke('sessions.setModel', { id, effort: 'max' });

    const picked = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(picked).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', effort: 'max' });
    // The new model's own Effort levels are offered at once.
    expect(picked.agentConfig).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', effort: 'max', efforts: ['low', 'high', 'max', 'default'] });
    const items = await waitFor(main.api, 'transcript', (all) => markers(all).length === 2, { sessionId: id });
    expect(markers(items).map(({ id: _, ...marker }) => marker)).toEqual([
      { kind: 'model', model: 'anthropic/claude-sonnet-5-5' },
      { kind: 'model', effort: 'max' },
    ]);

    await main.api.invoke('sessions.send', { id, prompt: 'Second' });
    await main.api.invoke('sessions.send', { id, prompt: 'Third' });
    await waitFor(main.api, 'transcript', (all) => all.filter((i) => i.kind === 'user').length === 3, { sessionId: id });
    await waitFor(main.api, 'sessions', session(id, finished));
    const prompts = asked(machine).filter((m) => m !== 'initialize' && m !== 'session/new');
    expect(prompts).toEqual(['session/prompt', 'model=anthropic/claude-sonnet-5-5', 'effort=max', 'session/prompt', 'session/prompt']);
  });

  it("goes back to the new model's default Effort when the model changes", async () => {
    const { machine, checkout } = machineWith();
    const { main, id } = await finishedSession(machine, checkout);
    await main.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-sonnet-5-5', effort: 'high' });

    await main.api.invoke('sessions.setModel', { id, model: 'opencode/pulse-free' });

    const changed = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(changed.model).toBe('opencode/pulse-free');
    expect(changed.effort).toBeUndefined();
    expect(changed.agentConfig).toMatchObject({ model: 'opencode/pulse-free', efforts: [] });
  });

  it('is refused while the agent is Working, adding no marker', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['On it.'], hold: 'run' }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    await expect(main.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-sonnet-5-5' })).rejects.toThrow(/Working|between runs/);

    machine.release('run');
    const items = await waitFor(main.api, 'transcript', (all) => all.some((i) => i.kind === 'agent' && !i.streaming), { sessionId: id });
    expect(markers(items)).toEqual([]);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.model).toBeUndefined();
  });

  it('is refused, changing nothing, for a model or Effort level the agent does not offer', async () => {
    const { machine, checkout } = machineWith();
    const { main, id } = await finishedSession(machine, checkout);

    await expect(main.api.invoke('sessions.setModel', { id, model: 'openai/gpt-old' })).rejects.toThrow(/openai\/gpt-old/);
    await expect(main.api.invoke('sessions.setModel', { id, effort: 'max' })).rejects.toThrow(/Effort/);

    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.model).toBeUndefined();
    expect(markers(await waitFor(main.api, 'transcript', () => true, { sessionId: id }))).toEqual([]);
  });

  it('sends a prompt given while the agent switches only once it has, on the new model, after the marker', async () => {
    const { machine, checkout } = machineWith([], { holdConfig: 'switch' });
    const { main, id } = await finishedSession(machine, checkout);

    const switching = main.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-sonnet-5-5' });
    await until(() => asked(machine).includes('model=anthropic/claude-sonnet-5-5'));
    const sending = main.api.invoke('sessions.send', { id, prompt: 'Second' });
    machine.release('switch');
    await Promise.all([switching, sending]);

    await waitFor(main.api, 'sessions', session(id, (s) => finished(s) && asked(machine).filter((m) => m === 'session/prompt').length === 2));
    expect(asked(machine).slice(2)).toEqual(['session/prompt', 'model=anthropic/claude-sonnet-5-5', 'session/prompt']);
    const items = await waitFor(main.api, 'transcript', (all) => all.length >= 3, { sessionId: id });
    expect(items.filter((i) => i.kind === 'user' || i.kind === 'model').map((i) => i.kind)).toEqual(['user', 'model', 'user']);
  });

  it("puts the agent back on what it ran with when it takes the new model but turns down the Effort level", async () => {
    const { machine, checkout } = machineWith();
    const { main, id } = await finishedSession(machine, checkout);

    await expect(main.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-sonnet-5-5', effort: 'extreme' })).rejects.toThrow(/extreme/);

    const after = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(after.model).toBeUndefined();
    expect(after.agentConfig?.model).toBe('opencode/pulse-free');
  });

  it("is refused for a Session whose agent has stopped, which can't be resumed yet", async () => {
    const { machine, checkout } = machineWith();
    const userDataDir = tempDir('loom-stopped-');
    const first = await startMain({ machine, userDataDir });
    await waitFor(first.api, 'environments', ready);
    const project = await first.api.invoke('projects.link', { path: checkout });
    const { id } = await first.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Hi' });
    await waitFor(first.api, 'sessions', session(id, finished));
    await first.close();
    const second = await startMain({ machine, userDataDir });

    await expect(second.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-sonnet-5-5' })).rejects.toThrow(/stopped/);
  });

  it("checks a change against the checkout's models while no agent runs, and applies it once one does", async () => {
    const { machine, checkout } = machineWith();
    const { main, id } = await finishedSession(machine, checkout);
    // The bridge dies with the agent, and comes back without it.
    const bridge = main.bridge();
    const exited = new Promise((resolve) => bridge.once('exit', resolve));
    bridge.kill();
    await exited;
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'error'));
    main.clock.advance(1_000);
    await waitFor(main.api, 'environments', ready);

    await expect(main.api.invoke('sessions.setModel', { id, model: 'openai/gpt-old' })).rejects.toThrow(/openai\/gpt-old/);
    await expect(main.api.invoke('sessions.setModel', { id, model: 'opencode/pulse-free', effort: 'max' })).rejects.toThrow(/Effort/);
    await main.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-sonnet-5-5', effort: 'max' });
    await main.api.invoke('sessions.send', { id, prompt: 'Again' });

    await waitFor(main.api, 'sessions', session(id, finished));
    expect(asked(machine).slice(-3)).toEqual(['model=anthropic/claude-sonnet-5-5', 'effort=max', 'session/prompt']);
  });

  it('keeps the model and Effort picked across a restart', async () => {
    const { machine, checkout } = machineWith();
    const userDataDir = tempDir('loom-models-');
    const first = await startMain({ machine, userDataDir });
    await waitFor(first.api, 'environments', ready);
    const project = await first.api.invoke('projects.link', { path: checkout });
    const { id } = await first.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Hi', model: 'anthropic/claude-sonnet-5-5', effort: 'low' });
    await waitFor(first.api, 'sessions', session(id, finished));
    await first.close();

    const second = await startMain({ machine, userDataDir });

    expect((await second.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', effort: 'low' });
  });
});

describe("the agent's context", () => {
  it('shows how full it is after each run, out of the current model’s window, kept across a restart', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['One.'], used: 32_000 }, { chunks: ['Two.'], used: 50_000 }]);
    const userDataDir = tempDir('loom-context-');
    const first = await startMain({ machine, userDataDir });
    await waitFor(first.api, 'environments', ready);
    const project = await first.api.invoke('projects.link', { path: checkout });
    const { id } = await first.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Hi' });
    expect((await waitFor(first.api, 'sessions', session(id, finished))).find((s) => s.id === id)!.context).toEqual({ used: 32_000, size: 128_000 });

    await first.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-sonnet-5-5' });
    await first.api.invoke('sessions.send', { id, prompt: 'Again' });
    await waitFor(first.api, 'sessions', session(id, (s) => s.context?.used === 50_000));
    expect((await first.api.invoke('sessions.list')).find((s) => s.id === id)!.context).toEqual({ used: 50_000, size: 200_000 });
    await waitFor(first.api, 'sessions', session(id, finished));
    await first.close();

    const second = await startMain({ machine, userDataDir });
    expect((await second.api.invoke('sessions.list')).find((s) => s.id === id)!.context).toEqual({ used: 50_000, size: 200_000 });
  });
});
