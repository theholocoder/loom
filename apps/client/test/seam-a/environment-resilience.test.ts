// Environment resilience: a bridge that dies is restarted with backoff, and
// one that can't start leaves its Sessions Waiting (error) with Retry. These
// tests kill only the bridge processes their own main started, by handle.
import { describe, expect, it } from 'vitest';
import { realBridgePath, startMain, tempDir, tempMachine, waitFor, type AcpTurn, type MainHarness, type Machine } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const native = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')!;
const agentReady = (envs: EnvironmentStatus[]) => native(envs)?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

function machineWith(turns: AcpTurn[]): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

async function withProject(machine: Machine, checkout: string) {
  const main = await startMain({ machine });
  await waitFor(main.api, 'environments', agentReady);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

const sessionNow = async (main: MainHarness, id: number) => (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
const envNow = async (main: MainHarness) => native(await main.api.invoke('environments.list'));

/** Kills the bridge this main started, and waits until main has noticed. */
async function killBridge(main: MainHarness): Promise<void> {
  const bridge = main.bridge();
  const exited = new Promise<void>((resolve) => bridge.once('exit', () => resolve()));
  bridge.kill();
  await exited;
  await waitFor(main.api, 'environments', (e) => native(e).state !== 'connected');
}

describe('a native bridge that dies', () => {
  it('is started again after 1 second', async () => {
    const main = await startMain();
    await waitFor(main.api, 'environments', (e) => native(e).state === 'connected');
    const first = main.bridge();

    await killBridge(main);
    main.clock.advance(999);
    expect(main.bridge()).toBe(first);

    main.clock.advance(1);
    await waitFor(main.api, 'environments', (e) => native(e).state === 'connected');
    expect(main.bridge()).not.toBe(first);
  });
});

/** A path where no bridge is: starting it fails at once. */
const missingBridge = '/nonexistent/loom-bridge';

describe('a native bridge that dies and cannot start again', () => {
  it('is tried again after 1, 5 and 30 seconds, then the Environment is failed', async () => {
    const main = await startMain();
    await waitFor(main.api, 'environments', (e) => native(e).state === 'connected');
    main.setBridgePath(missingBridge);

    await killBridge(main);
    for (const [delay, starts] of [
      [1_000, 2],
      [5_000, 3],
      [30_000, 4],
    ] as const) {
      main.clock.advance(delay - 1);
      expect(main.bridgeStarts()).toBe(starts - 1);
      main.clock.advance(1);
      expect(main.bridgeStarts()).toBe(starts);
      if (starts < 4) await waitFor(main.api, 'environments', (e) => native(e).state === 'disconnected');
    }

    await waitFor(main.api, 'environments', (e) => native(e).state === 'failed');
    main.clock.advance(60_000);
    expect(main.bridgeStarts()).toBe(4);
  });
});

describe('the Sessions of a bridge that dies', () => {
  it('are Waiting on an error, "Environment restarted", when they were Working', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it'], hold: 'never' }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    await killBridge(main);

    expect(await sessionNow(main, id)).toMatchObject({ status: 'waiting', waitingReason: 'error', error: 'Environment restarted', unread: true });
    expect(await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'error'), { sessionId: id })).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Go' },
      { kind: 'agent', id: expect.any(Number), text: 'Working on it', streaming: false },
      { kind: 'error', id: expect.any(Number), message: 'Environment restarted' },
    ]);
  });

  it('are Waiting on an error, "Environment restarted", when their agent was idle, and run the next prompt once it is back', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'finished'));

    await killBridge(main);
    expect(await sessionNow(main, id)).toMatchObject({ status: 'waiting', waitingReason: 'error', error: 'Environment restarted' });

    await main.api.invoke('sessions.send', { id, prompt: 'Again' });
    expect(await sessionNow(main, id)).toMatchObject({ status: 'working' });
    main.clock.advance(1_000);

    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'finished'));
    const prompts = machine.acpMessages().filter((m) => m.message.method === 'session/prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.pid).not.toBe(prompts[0]!.pid);
  });

  it('are left as they were when their agent never ran there', async () => {
    const { machine, checkout } = machineWith([]);
    const { main } = await withProject(machine, checkout);
    await killBridge(main);
    expect(await main.api.invoke('sessions.list')).toEqual([]);
  });
});

/** A bridge that starts but never answers its handshake: node, reading a script from its stdin. */
const silentBridge = process.execPath;

describe('a native bridge starting again', () => {
  it('keeps a Session Working while it starts, giving up on a start after 20 seconds', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'finished'));
    main.setBridgePath(silentBridge);
    await killBridge(main);

    await main.api.invoke('sessions.send', { id, prompt: 'Again' });
    main.clock.advance(1_000);
    expect(await envNow(main)).toMatchObject({ state: 'starting' });
    const silent = main.bridge();
    const silentExited = new Promise((resolve) => silent.once('exit', resolve));
    main.clock.advance(19_999);
    expect(await envNow(main)).toMatchObject({ state: 'starting' });
    expect(await sessionNow(main, id)).toMatchObject({ status: 'working' });

    main.clock.advance(1);
    await silentExited;
    const envs = await waitFor(main.api, 'environments', (e) => native(e).state === 'disconnected');
    expect(native(envs).error).toMatch(/within 20000 ms/);
    expect(await sessionNow(main, id)).toMatchObject({ status: 'working' });

    main.setBridgePath(undefined);
    main.clock.advance(5_000);
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'finished'));
  });
});

describe('a native bridge that fails to start', () => {
  it('puts a Session in Waiting on an error, and Retry starts the bridge again and sends the prompt', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const userDataDir = tempDir('loom-seam-a-');
    const first = await startMain({ machine, userDataDir });
    await waitFor(first.api, 'environments', agentReady);
    const project = await first.api.invoke('projects.link', { path: checkout });
    await first.close();

    const main = await startMain({ machine, userDataDir, bridgePath: missingBridge });
    await waitFor(main.api, 'environments', (e) => native(e).state === 'failed');
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix it' });

    const failed = (await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'))).find((s) => s.id === id)!;
    expect(failed).toMatchObject({ waitingReason: 'error', error: expect.stringMatching(/^Native could not start: /) });
    expect(await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'error'), { sessionId: id })).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Fix it' },
      { kind: 'error', id: expect.any(Number), message: failed.error },
    ]);

    main.setBridgePath(realBridgePath);
    await main.api.invoke('sessions.retry', { id });
    expect(await sessionNow(main, id)).toMatchObject({ status: 'working' });

    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'finished'));
    expect(await envNow(main)).toMatchObject({ state: 'connected' });
    const prompts = machine.acpMessages().filter((m) => m.message.method === 'session/prompt');
    expect(prompts.map((m) => (m.message.params?.prompt as Array<{ text: string }>)[0]!.text)).toEqual(['Fix it']);
  });

  it('refuses Retry once the prompt has had an answer, and Continue once the run had finished', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'finished'));
    await killBridge(main);
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'error'));

    await expect(main.api.invoke('sessions.retry', { id })).rejects.toThrow(/nothing to retry/i);
    await expect(main.api.invoke('sessions.continue', { id })).rejects.toThrow(/nothing to continue/i);
  });
});
