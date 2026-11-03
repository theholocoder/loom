// Environment resilience: a bridge that dies is restarted with backoff, and
// one that can't start leaves its Sessions Waiting (error) with Retry. These
// tests kill only the bridge processes their own main started, by handle.
import { describe, expect, it } from 'vitest';
import { startMain, tempMachine, waitFor, type AcpTurn, type MainHarness, type Machine } from './harness';
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
