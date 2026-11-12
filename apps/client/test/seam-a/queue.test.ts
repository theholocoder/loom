import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type AcpTurn, type Machine } from './harness';
import type { AgentAdapter, AgentEvent, AgentSession, OpenOptions } from '../../src/main/agents/adapter';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

/** A machine with a ready OpenCode playing `turns`, and a git checkout. */
function machineWith(turns: AcpTurn[]): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

/** Main with a Project on `checkout`, and a checkout Session started with `prompt`. */
async function withSession(machine: Machine, checkout: string, { prompt = 'First', userDataDir }: { prompt?: string; userDataDir?: string } = {}) {
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt });
  return { main, id };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

const queued = (s: Session) => (s.queue ?? []).map((m) => m.text);

/** The transcript as kinds and text, for comparing. */
const shown = (items: TranscriptItem[]) => items.map((i) => (i.kind === 'interruption' ? [i.kind, i.by] : [i.kind, 'text' in i ? i.text : '']));

/** The prompts the agent was sent, in order. */
const prompts = (machine: Machine) =>
  machine
    .acpMessages()
    .filter((m) => m.message.method === 'session/prompt')
    .map((m) => (m.message.params?.prompt as Array<{ text: string }>)[0]!.text);

describe("a Working Session's queue", () => {
  it('takes messages sent while Working, and sends them one by one as runs settle, staying Working', async () => {
    const { machine, checkout } = machineWith([
      { chunks: ['One.'], hold: 'first' },
      { chunks: ['Two.'], hold: 'second' },
      { chunks: ['Three.'] },
    ]);
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    await main.api.invoke('sessions.send', { id, prompt: 'Second' });
    await main.api.invoke('sessions.send', { id, prompt: 'Third' });

    const listed = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(listed.status).toBe('working');
    expect(listed.queue).toEqual([
      { id: expect.any(Number), text: 'Second' },
      { id: expect.any(Number), text: 'Third' },
    ]);

    machine.release('first');
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'working' && queued(s).join() === 'Third'));
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Two.'), { sessionId: id });
    machine.release('second');

    const done = await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    expect(done.find((s) => s.id === id)).toMatchObject({ status: 'waiting', waitingReason: 'finished' });
    expect(done.find((s) => s.id === id)!.queue).toBeUndefined();
    expect(shown(await waitFor(main.api, 'transcript', (items) => items.length === 6, { sessionId: id }))).toEqual([
      ['user', 'First'],
      ['agent', 'One.'],
      ['user', 'Second'],
      ['agent', 'Two.'],
      ['user', 'Third'],
      ['agent', 'Three.'],
    ]);
    expect(prompts(machine)).toEqual(['First', 'Second', 'Third']);
  });

  it('drops a removed message, which is never sent', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['One.'], hold: 'first' }, { chunks: ['Three.'] }]);
    const { main, id } = await withSession(machine, checkout);
    await main.api.invoke('sessions.send', { id, prompt: 'Second' });
    await main.api.invoke('sessions.send', { id, prompt: 'Third' });
    const [second] = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue!;

    await main.api.invoke('sessions.removeQueued', { id, queuedId: second!.id });

    expect(queued((await main.api.invoke('sessions.list')).find((s) => s.id === id)!)).toEqual(['Third']);
    await expect(main.api.invoke('sessions.removeQueued', { id, queuedId: second!.id })).rejects.toThrow('There is no such queued message.');
    machine.release('first');
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.queue === undefined));
    expect(prompts(machine)).toEqual(['First', 'Third']);
  });

  it('sends an edited message as edited, where it was in the queue', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['One.'], hold: 'first' }, { chunks: ['Two.'] }, { chunks: ['Three.'] }]);
    const { main, id } = await withSession(machine, checkout);
    await main.api.invoke('sessions.send', { id, prompt: 'Second' });
    await main.api.invoke('sessions.send', { id, prompt: 'Third' });
    const [second] = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue!;

    await main.api.invoke('sessions.editQueued', { id, queuedId: second!.id, text: 'Second, and the README' });

    expect(queued((await main.api.invoke('sessions.list')).find((s) => s.id === id)!)).toEqual(['Second, and the README', 'Third']);
    machine.release('first');
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.queue === undefined));
    expect(prompts(machine)).toEqual(['First', 'Second, and the README', 'Third']);
  });

  it("won't edit a message no longer queued, nor leave one with nothing to send", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['One.'], hold: 'first' }, { chunks: ['Two.'] }]);
    const { main, id } = await withSession(machine, checkout);
    await main.api.invoke('sessions.send', { id, prompt: 'Second' });
    const [second] = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue!;

    await expect(main.api.invoke('sessions.editQueued', { id, queuedId: second!.id, text: '  ' })).rejects.toThrow('A queued message needs something to send: remove it instead.');
    machine.release('first');
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.queue === undefined));
    await expect(main.api.invoke('sessions.editQueued', { id, queuedId: second!.id, text: 'Too late' })).rejects.toThrow('There is no such queued message.');
    expect(prompts(machine)).toEqual(['First', 'Second']);
  });

  it('Stop interrupts the run without sending the queue, which it keeps: Waiting (stopped)', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it'], hold: 'never' }, { chunks: ['Fresh answer.'] }, { chunks: ['Second answer.'] }]);
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.api.invoke('sessions.send', { id, prompt: 'Second' });

    await main.api.invoke('sessions.stop', { id });

    const [stopped] = (await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'))).filter((s) => s.id === id);
    expect(stopped).toMatchObject({ status: 'waiting', waitingReason: 'stopped', queue: [{ id: expect.any(Number), text: 'Second' }] });
    expect(shown(await waitFor(main.api, 'transcript', (items) => items.at(-1)?.kind === 'interruption', { sessionId: id }))).toEqual([
      ['user', 'First'],
      ['agent', 'Working on it'],
      ['interruption', 'stop'],
    ]);
    expect(machine.acpMessages().filter((m) => m.message.method === 'session/cancel')).toHaveLength(1);
    expect(prompts(machine)).toEqual(['First']);
    await expect(main.api.invoke('sessions.stop', { id })).rejects.toThrow('The agent is not working on this Session.');

    // The same agent takes the next reply; once that settles, the queue goes on.
    await main.api.invoke('sessions.send', { id, prompt: 'Fresh' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'finished' && s.queue === undefined));
    expect(prompts(machine)).toEqual(['First', 'Fresh', 'Second']);
    expect(new Set(machine.acpMessages().map((m) => m.pid)).size).toBe(1);
  });

  it('Stop withdraws an Approval request the agent waits on, answering it as cancelled', async () => {
    const machine = tempMachine();
    machine.installOpencode({
      version: 'opencode v2.1.4',
      integrations: signedIn,
      acp: { turns: [{ chunks: [{ permission: { toolCallId: 'call_w', name: 'write', title: '/etc/loom.conf', kind: 'edit', locations: [{ path: '/etc/loom.conf' }], rawInput: { path: '/etc/loom.conf', content: 'hi\n' } } }, 'Wrote it.'] }] },
    });
    const { main, id } = await withSession(machine, machine.gitRepo('billing-api'));
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'approval'));

    await main.api.invoke('sessions.stop', { id });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'stopped'));
    const items = await waitFor(main.api, 'transcript', (list) => list.at(-1)?.kind === 'interruption', { sessionId: id });
    expect(items.find((i) => i.kind === 'approval')).toMatchObject({ state: 'expired' });
    expect(items.some((i) => i.kind === 'agent')).toBe(false);
    const answered = machine.acpMessages().find((m) => m.message.method === undefined && m.message.result?.outcome);
    expect(answered?.message.result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('Send now interrupts the run and sends that message, the rest staying queued', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Heading the wrong way'], hold: 'never' }, { chunks: ['Redirected.'], hold: 'redirect' }, { chunks: ['Then this.'] }]);
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.api.invoke('sessions.send', { id, prompt: 'Later' });
    await main.api.invoke('sessions.send', { id, prompt: 'Stop, use the other API' });
    const [, urgent] = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue!;

    await main.api.invoke('sessions.sendNow', { id, queuedId: urgent!.id });

    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Redirected.'), { sessionId: id });
    const during = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(during.status).toBe('working');
    expect(queued(during)).toEqual(['Later']);
    expect(shown(await waitFor(main.api, 'transcript', (items) => items.length === 5, { sessionId: id }))).toEqual([
      ['user', 'First'],
      ['agent', 'Heading the wrong way'],
      ['interruption', 'send-now'],
      ['user', 'Stop, use the other API'],
      ['agent', 'Redirected.'],
    ]);
    expect(prompts(machine)).toEqual(['First', 'Stop, use the other API']);

    machine.release('redirect');
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'finished'));
    expect(prompts(machine)).toEqual(['First', 'Stop, use the other API', 'Later']);
  });

  it('Send now on a Waiting Session sends the message as its reply', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it'], hold: 'never' }, { chunks: ['Done.'] }]);
    const { main, id } = await withSession(machine, checkout);
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.api.invoke('sessions.send', { id, prompt: 'Next' });
    await main.api.invoke('sessions.stop', { id });
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'stopped'));
    const [next] = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue!;

    await main.api.invoke('sessions.sendNow', { id, queuedId: next!.id });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'finished' && s.queue === undefined));
    expect(prompts(machine)).toEqual(['First', 'Next']);
    expect(machine.acpMessages().filter((m) => m.message.method === 'session/cancel')).toHaveLength(1);
    await expect(main.api.invoke('sessions.sendNow', { id, queuedId: next!.id })).rejects.toThrow('There is no such queued message.');
  });

  it('Stop while the agent starts means its prompt is never sent', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Hi.'] }], holdNew: 'start' } });
    const { main, id } = await withSession(machine, machine.gitRepo('billing-api'));

    await main.api.invoke('sessions.stop', { id });
    machine.release('start');

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'stopped'));
    expect(shown(await waitFor(main.api, 'transcript', (items) => items.at(-1)?.kind === 'interruption', { sessionId: id }))).toEqual([
      ['user', 'First'],
      ['interruption', 'stop'],
    ]);
    expect(prompts(machine)).toEqual([]);
  });

  it('is kept in the database: after a restart, the interrupted Session still has its queue', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it'], hold: 'never' }]);
    const userDataDir = tempDir('loom-queue-');
    const { main, id } = await withSession(machine, checkout, { userDataDir });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.api.invoke('sessions.send', { id, prompt: 'Second' });
    await main.api.invoke('sessions.send', { id, prompt: 'Third' });
    const [second] = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue!;
    await main.api.invoke('sessions.removeQueued', { id, queuedId: second!.id });
    const [third] = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue!;
    await main.api.invoke('sessions.editQueued', { id, queuedId: third!.id, text: 'Third, edited' });
    await main.close();

    const again = await startMain({ machine, userDataDir });
    const [kept] = (await again.api.invoke('sessions.list')).filter((s) => s.id === id);
    expect(kept).toMatchObject({ status: 'waiting', waitingReason: 'interrupted', queue: [{ id: expect.any(Number), text: 'Third, edited' }] });
  });

  it('goes with the Session when it is archived', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it'], hold: 'never' }]);
    const { main, id } = await withSession(machine, checkout);
    await main.api.invoke('sessions.send', { id, prompt: 'Second' });

    await main.api.invoke('sessions.archive', { id });

    const [archived] = (await main.api.invoke('sessions.list')).filter((s) => s.id === id);
    expect(archived).toMatchObject({ status: 'archived' });
    expect(archived!.queue).toBeUndefined();
  });

  it("can't be steered on OpenCode, whose queued messages are sent with Send now", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it'], hold: 'never' }]);
    const { main, id } = await withSession(machine, checkout);
    await main.api.invoke('sessions.send', { id, prompt: 'Second' });
    const listed = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;

    expect(listed.canSteer).toBeUndefined();
    await expect(main.api.invoke('sessions.steer', { id, queuedId: listed.queue![0]!.id })).rejects.toThrow("OpenCode can't take a message mid-run: use Send now.");
  });

  it('steers an agent that can be: the queued message goes into the run going', async () => {
    const agent = new SteerableAgent();
    const machine = tempMachine();
    const main = await startMain({ machine, adapter: agent });
    await waitFor(main.api, 'environments', (envs) => envs.some((e) => e.state === 'connected'));
    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('billing-api') });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.api.invoke('sessions.send', { id, prompt: 'Also this' });
    const listed = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(listed.canSteer).toBe(true);

    await main.api.invoke('sessions.steer', { id, queuedId: listed.queue![0]!.id });

    expect(agent.steered).toEqual(['Also this']);
    const [steered] = (await main.api.invoke('sessions.list')).filter((s) => s.id === id);
    expect(steered).toMatchObject({ status: 'working' });
    expect(steered!.queue).toBeUndefined();
    expect(shown(await waitFor(main.api, 'transcript', (items) => items.length === 3, { sessionId: id }))).toEqual([
      ['user', 'First'],
      ['agent', 'On it.'],
      ['user', 'Also this'],
    ]);
  });
});

/** An agent that takes messages mid-run, which no ACP agent Loom drives does yet; its runs never end. */
class SteerableAgent implements AgentAdapter {
  readonly name = 'Steerable';
  readonly canSteer = true;
  readonly steered: string[] = [];

  async open({ onEvent }: OpenOptions): Promise<AgentSession> {
    const emit = (event: AgentEvent) => onEvent(event);
    return {
      id: 'ses_steerable',
      configure: async () => {},
      prompt: () => {
        emit({ type: 'run-started' });
        emit({ type: 'text-delta', text: 'On it.' });
      },
      steer: ({ text }) => this.steered.push(text),
      answer: () => {},
      cancel: () => {},
      close: async () => {},
    };
  }
}
