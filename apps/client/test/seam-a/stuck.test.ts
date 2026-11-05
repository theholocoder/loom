// The stuck watchdog: a Working Session whose agent says nothing for a while
// (15 minutes by default, a setting) goes Waiting as stuck. Waiting on the
// user never counts.
import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type Machine, type OpencodeScript } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';
import { IDLE_STOP_MS } from '../../src/main/sessions/sessions';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];
const models = [{ providerID: 'opencode', id: 'pulse-free', name: 'Pulse Free' }];
const MINUTE = 60_000;

function machineWith(acp: OpencodeScript['acp']): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, models, acp });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};
const waiting = (reason: string) => (s: Session) => s.status === 'waiting' && s.waitingReason === reason;
const working = (s: Session) => s.status === 'working';

async function statusOf(main: Awaited<ReturnType<typeof startMain>>, id: number) {
  // What the agent sent before lands first.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const { status, waitingReason } = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
  return { status, waitingReason };
}

/** A checkout Session whose agent is mid-run, as `acp` scripts it. */
async function running(
  acp: OpencodeScript['acp'],
  { started = working, userDataDir, stuckAfterMinutes }: { started?: (s: Session) => boolean; userDataDir?: string; stuckAfterMinutes?: number } = {},
) {
  const { machine, checkout } = machineWith(acp);
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  if (stuckAfterMinutes !== undefined) await main.api.invoke('settings.setStuckAfterMinutes', { minutes: stuckAfterMinutes });
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
  await waitFor(main.api, 'sessions', session(id, started));
  // The agent's first words are in.
  await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
  return { machine, main, project, id };
}

describe('the stuck watchdog', () => {
  it('puts a Working Session in Waiting (stuck) once its agent has said nothing for 15 minutes, and not before', async () => {
    const { main, id } = await running({ turns: [{ chunks: ['On it.'], hold: 'never' }] });

    await main.elapse(15 * MINUTE - 1);
    expect(await statusOf(main, id)).toEqual({ status: 'working', waitingReason: undefined });

    await main.elapse(1);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));
  });

  it('counts the 15 minutes from the agent\'s last event', async () => {
    const { machine, main, id } = await running({ turns: [{ chunks: ['On it.', { hold: 'more' }, ' Still going.'], hold: 'never' }] });

    await main.elapse(10 * MINUTE);
    machine.release('more');
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text.endsWith('Still going.')), { sessionId: id });
    await main.elapse(15 * MINUTE - 1);
    expect(await statusOf(main, id)).toEqual({ status: 'working', waitingReason: undefined });

    await main.elapse(1);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));
  });

  it('never counts a wait on a question, and counts again from the answer', async () => {
    const question = { elicit: { message: 'Which color?', requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Color' } }, required: [] } } };
    const { main, id } = await running({ turns: [{ chunks: ['Let me ask.', question], hold: 'never' }] }, { started: waiting('question') });

    await main.elapse(60 * MINUTE);
    expect(await statusOf(main, id)).toEqual({ status: 'waiting', waitingReason: 'question' });

    const card = (await waitFor(main.api, 'transcript', () => true, { sessionId: id })).find((i) => i.kind === 'question')!;
    await main.api.invoke('sessions.answer', { id, itemId: card.id, answer: { q0: 'blue' } });
    await waitFor(main.api, 'sessions', session(id, working));
    await main.elapse(15 * MINUTE - 1);
    expect(await statusOf(main, id)).toEqual({ status: 'working', waitingReason: undefined });
    await main.elapse(1);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));
  });

  it('never counts a wait on an Approval request', async () => {
    const write = { permission: { toolCallId: 'call_w', name: 'write', title: '/home/elsewhere/a.txt', kind: 'edit', locations: [{ path: '/home/elsewhere/a.txt' }], rawInput: { path: '/home/elsewhere/a.txt', content: 'hi\n' } } };
    const { main, id } = await running({ turns: [{ chunks: ['Writing.', write], hold: 'never' }] }, { started: waiting('approval') });

    await main.elapse(60 * MINUTE);
    expect(await statusOf(main, id)).toEqual({ status: 'waiting', waitingReason: 'approval' });
  });

  it('puts a stuck Session back to Working as soon as its agent says something, its run going on', async () => {
    const { machine, main, id } = await running({ turns: [{ chunks: ['On it.', { hold: 'more' }, ' Back.'], hold: 'end' }] });
    await main.elapse(15 * MINUTE);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));
    // A stuck run is in flight: its agent isn't stopped as idle.
    await main.elapse(2 * IDLE_STOP_MS);

    machine.release('more');
    await waitFor(main.api, 'sessions', session(id, working));
    machine.release('end');
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
    const items = await waitFor(main.api, 'transcript', () => true, { sessionId: id });
    expect(items.map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([
      ['user', 'First'],
      ['agent', 'On it. Back.'],
    ]);
  });

  it('puts a stuck Session back to Working when its agent asks an approval Loom gives itself', async () => {
    const read = { permission: { toolCallId: 'call_r', name: 'read', title: '/etc/hosts', kind: 'read', locations: [{ path: '/etc/hosts' }], rawInput: { path: '/etc/hosts' } } };
    const { machine, main, id } = await running({ turns: [{ chunks: ['On it.', { hold: 'more' }, read], hold: 'never' }] });
    await main.elapse(15 * MINUTE);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));

    machine.release('more');

    await waitFor(main.api, 'sessions', session(id, working));
  });

  it('sends the messages sent to a stuck Session in the order they were sent', async () => {
    const { main, id } = await running({ turns: [{ chunks: ['On it.'], hold: 'never' }, { chunks: ['Doing A.'] }, { chunks: ['Doing B.'] }] });
    await main.elapse(15 * MINUTE);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));

    await main.api.invoke('sessions.send', { id, prompt: 'A' });
    await main.api.invoke('sessions.send', { id, prompt: 'B' });

    const items = await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'agent' && i.text === 'Doing B.'), { sessionId: id });
    expect(items.flatMap((i) => (i.kind === 'user' ? [i.text] : []))).toEqual(['First', 'A', 'B']);
  });

  it('records each Session that was stuck, for the dashboard', async () => {
    const { main, id } = await running({ turns: [{ chunks: ['On it.'], hold: 'never' }] });
    await main.elapse(15 * MINUTE);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));

    expect((await main.api.invoke('usage.dashboard', { days: 7 })).outcomes.stuck).toBe(1);
  });

  it('stops a stuck run with Stop, as a Working one', async () => {
    const { main, id } = await running({ turns: [{ chunks: ['On it.'], hold: 'never' }] });
    await main.elapse(15 * MINUTE);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));

    await main.api.invoke('sessions.stop', { id });

    await waitFor(main.api, 'sessions', session(id, waiting('stopped')));
  });

  it('interrupts a stuck run for a message sent to it, and sends the message in its place', async () => {
    const { main, id } = await running({ turns: [{ chunks: ['On it.'], hold: 'never' }, { chunks: ['Fresh start.'] }] });
    await main.elapse(15 * MINUTE);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));

    await main.api.invoke('sessions.send', { id, prompt: 'Try again' });

    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
    const items = await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'agent' && i.text === 'Fresh start.'), { sessionId: id });
    expect(items.map((i) => [i.kind, 'text' in i ? i.text : 'by' in i ? i.by : ''])).toEqual([
      ['user', 'First'],
      ['agent', 'On it.'],
      ['interruption', 'send-now'],
      ['user', 'Try again'],
      ['agent', 'Fresh start.'],
    ]);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue).toBeUndefined();
  });

  it('comes back as Waiting (interrupted) after Loom restarts', async () => {
    const userDataDir = tempDir('loom-stuck-');
    const { machine, main, id } = await running({ turns: [{ chunks: ['On it.'], hold: 'never' }] }, { userDataDir });
    await main.elapse(15 * MINUTE);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));
    await main.close();

    const again = await startMain({ machine, userDataDir });
    expect((await again.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'waiting', waitingReason: 'interrupted' });
  });
});

describe('the stuck setting', () => {
  it('is 15 minutes until the user changes it, and is kept', async () => {
    const userDataDir = tempDir('loom-stuck-setting-');
    const main = await startMain({ userDataDir });
    expect(await waitFor(main.api, 'settings', () => true)).toMatchObject({ stuckAfterMinutes: 15 });

    expect(await main.api.invoke('settings.setStuckAfterMinutes', { minutes: 40 })).toMatchObject({ stuckAfterMinutes: 40 });
    await main.close();

    const again = await startMain({ userDataDir });
    expect(await waitFor(again.api, 'settings', () => true)).toMatchObject({ stuckAfterMinutes: 40 });
  });

  it('turns down anything but a whole number of minutes, at least 1', async () => {
    const main = await startMain();
    for (const minutes of [0, -5, 2.5, Number.NaN, '10' as unknown as number]) {
      await expect(main.api.invoke('settings.setStuckAfterMinutes', { minutes })).rejects.toThrow('a whole number of minutes, at least 1');
    }
    expect(await waitFor(main.api, 'settings', () => true)).toMatchObject({ stuckAfterMinutes: 15 });
  });

  it('is how long the watchdog waits', async () => {
    const { main, id } = await running({ turns: [{ chunks: ['On it.'], hold: 'never' }] }, { stuckAfterMinutes: 2 });

    await main.elapse(2 * MINUTE - 1);
    expect(await statusOf(main, id)).toEqual({ status: 'working', waitingReason: undefined });
    await main.elapse(1);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));
  });
});
