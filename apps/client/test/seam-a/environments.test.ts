import { describe, expect, it } from 'vitest';
import { appVersion, startMain, waitFor } from './harness';
import type { EnvironmentStatus } from '../../src/shared/api';

const native = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native');

// What Go reports for this machine, written out rather than derived from the
// code under test.
const goOS = { linux: 'linux', win32: 'windows', darwin: 'darwin' }[process.platform as string];
const goArch = { x64: 'amd64', arm64: 'arm64' }[process.arch as string];

describe('the native Environment', () => {
  it('connects at startup and reports the bridge handshake', async () => {
    const main = await startMain();

    const envs = await waitFor(main.api, 'environments', (e) => native(e)?.state === 'connected');

    expect(native(envs)).toMatchObject({
      label: 'Native',
      state: 'connected',
      bridge: { protocolVersion: 1, version: appVersion, os: goOS, arch: goArch },
    });
  });
});

describe('pinging the native bridge', () => {
  it('pings every 30 seconds and records when the bridge last answered', async () => {
    const main = await startMain();
    const connected = native(await waitFor(main.api, 'environments', (e) => native(e)?.state === 'connected'))!;
    const startedAt = main.clock.now();
    expect(connected.lastSeenAt).toBe(startedAt);

    main.clock.advance(30_000);
    await waitFor(main.api, 'environments', (e) => native(e)?.lastSeenAt === startedAt + 30_000);

    main.clock.advance(30_000);
    await waitFor(main.api, 'environments', (e) => native(e)?.lastSeenAt === startedAt + 60_000);
  });

  // Freezing the bridge needs SIGSTOP, which Windows doesn't have.
  it.skipIf(process.platform === 'win32')('marks the bridge unresponsive when a ping goes unanswered for 10 seconds, and connected again once it answers', async () => {
    const main = await startMain();
    await waitFor(main.api, 'environments', (e) => native(e)?.state === 'connected');
    main.bridge().kill('SIGSTOP');

    main.clock.advance(30_000);
    main.clock.advance(9_999);
    expect(native(await main.api.invoke('environments.list'))?.state).toBe('connected');
    main.clock.advance(1);
    await waitFor(main.api, 'environments', (e) => native(e)?.state === 'unresponsive');

    // Pings keep their 30 s cadence from the one that went unanswered.
    main.bridge().kill('SIGCONT');
    main.clock.advance(20_000);
    await waitFor(main.api, 'environments', (e) => native(e)?.state === 'connected');
  });

  it('reports the Environment disconnected when its bridge exits', async () => {
    const main = await startMain();
    await waitFor(main.api, 'environments', (e) => native(e)?.state === 'connected');

    main.bridge().kill();

    const envs = await waitFor(main.api, 'environments', (e) => native(e)?.state === 'disconnected');
    expect(native(envs)?.error).toMatch(/bridge exited/);
  });
});

describe('a bridge that cannot start', () => {
  it('reports the Environment failed', async () => {
    const main = await startMain({ bridgePath: '/nonexistent/loom-bridge' });

    const envs = await waitFor(main.api, 'environments', (e) => native(e)?.state === 'failed');
    expect(native(envs)?.error).toBeTruthy();
  });
});

describe('a bridge from another Client version', () => {
  it('is reported failed rather than connected', async () => {
    const main = await startMain({ appVersion: '9.9.9' });

    const envs = await waitFor(main.api, 'environments', (e) => native(e)?.state === 'failed');
    expect(native(envs)?.error).toMatch(/0\.1\.0.*9\.9\.9|9\.9\.9.*0\.1\.0/);
  });
});
