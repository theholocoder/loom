import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appVersion, realBridgePath, startMain, tempDir, tempMachine, waitFor, type Machine } from './harness';
import type { EnvironmentStatus } from '../../src/shared/api';

// WSL is a stand-in wsl.exe the native bridge reaches (see Machine.installWsl):
// a shell script, so these run on Unix only. Windows itself is checked by hand
// (issue #38).
const unix = describe.skipIf(process.platform === 'win32');

const env = (envs: EnvironmentStatus[], id: string) => envs.find((e) => e.id === id);
const state = (id: string, wanted: EnvironmentStatus['state']) => (envs: EnvironmentStatus[]) => env(envs, id)?.state === wanted;

/** Where Loom installs its bridge in a distro, for this Client's version. */
const installedBridge = (machine: Machine, distro: string) => join(machine.distroHome(distro), '.local/share/loom/bridge', appVersion, 'loom-bridge');

/** A bridge of another Client's version: it answers the handshake as loom-bridge 0.0.1 would. */
function staleBridge(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `#!${process.execPath}
let buf = Buffer.alloc(0);
process.stdin.on('data', (data) => {
  buf = Buffer.concat([buf, data]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const request = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString());
    buf = buf.subarray(4 + buf.readUInt32BE(0));
    const reply = Buffer.from(JSON.stringify({ id: request.id, result: { protocolVersion: 4, version: '0.0.1', os: 'linux', arch: 'amd64', home: '' } }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(reply.length);
    process.stdout.write(Buffer.concat([header, reply]));
  }
});
`,
    { mode: 0o755 },
  );
}

unix('WSL distros', () => {
  it('are each listed as an Environment, not started until used', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu-24.04', 'docker-desktop', 'Debian']);
    const main = await startMain({ machine });

    const envs = await waitFor(main.api, 'environments', (e) => !!env(e, 'wsl:Debian'));

    expect(envs.map((e) => e.id)).toEqual(['native', 'wsl:Ubuntu-24.04', 'wsl:Debian']);
    expect(env(envs, 'wsl:Ubuntu-24.04')).toMatchObject({ label: 'Ubuntu-24.04', distro: 'Ubuntu-24.04', state: 'stopped' });
    expect(existsSync(join(machine.distroHome('Ubuntu-24.04'), '.local'))).toBe(false);
  });

  it('are none where there is no WSL', async () => {
    const main = await startMain();

    const envs = await waitFor(main.api, 'environments', state('native', 'connected'));
    await main.api.invoke('environments.detect');

    expect((await main.api.invoke('environments.list')).map((e) => e.id)).toEqual(['native']);
    expect(envs).toHaveLength(1);
  });
});

unix('starting a WSL Environment', () => {
  it('installs the bridge into the distro, then connects to it there', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'stopped'));
    const seen: EnvironmentStatus[] = [];
    main.api.subscribe('environments', (envs) => {
      const ubuntu = env(envs, 'wsl:Ubuntu');
      if (ubuntu) seen.push(ubuntu);
    });

    await main.api.invoke('environments.start', { id: 'wsl:Ubuntu' });
    const envs = await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'connected'));

    expect(env(envs, 'wsl:Ubuntu')?.bridge).toMatchObject({ version: appVersion, os: 'linux', home: machine.distroHome('Ubuntu') });
    expect(seen.some((e) => e.state === 'starting' && e.installing)).toBe(true);
    expect(readFileSync(installedBridge(machine, 'Ubuntu')).equals(readFileSync(realBridgePath))).toBe(true);
    expect(statSync(installedBridge(machine, 'Ubuntu')).mode & 0o111).not.toBe(0);
  });

  it('starts the bridge already installed in the distro without installing it again', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    const first = await startMain({ machine });
    await waitFor(first.api, 'environments', state('wsl:Ubuntu', 'stopped'));
    await first.api.invoke('environments.start', { id: 'wsl:Ubuntu' });
    await waitFor(first.api, 'environments', state('wsl:Ubuntu', 'connected'));
    await first.close();
    const installedAt = statSync(installedBridge(machine, 'Ubuntu')).mtimeMs;

    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'stopped'));
    await main.api.invoke('environments.start', { id: 'wsl:Ubuntu' });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'connected'));

    expect(statSync(installedBridge(machine, 'Ubuntu')).mtimeMs).toBe(installedAt);
  });

  it('reinstalls a bridge of another version found in the distro', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    staleBridge(installedBridge(machine, 'Ubuntu'));
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'stopped'));

    await main.api.invoke('environments.start', { id: 'wsl:Ubuntu' });
    const envs = await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'connected'));

    expect(env(envs, 'wsl:Ubuntu')?.bridge?.version).toBe(appVersion);
    expect(readFileSync(installedBridge(machine, 'Ubuntu')).equals(readFileSync(realBridgePath))).toBe(true);
  });

  it('reloads its shell environment on its own', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu', 'Debian']);
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Debian', 'stopped'));
    await main.api.invoke('environments.start', { id: 'wsl:Ubuntu' });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'connected'));

    await main.api.invoke('environments.reload', { id: 'wsl:Ubuntu' });

    const envs = await main.api.invoke('environments.list');
    expect(env(envs, 'wsl:Ubuntu')?.shellEnvironment).toBeDefined();
    expect(env(envs, 'wsl:Debian')?.state).toBe('stopped');
  });
});

unix('a Project checked out in a WSL distro', () => {
  it('starts its Environment when linked, and at every start of Loom after', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu', 'Debian']);
    const path = machine.gitRepo('billing-api');
    const userDataDir = tempDir('loom-wsl-');
    const first = await startMain({ machine, userDataDir });
    await waitFor(first.api, 'environments', state('wsl:Ubuntu', 'stopped'));

    const project = await first.api.invoke('projects.link', { path, environmentId: 'wsl:Ubuntu' });
    expect(project.checkout).toEqual({ environmentId: 'wsl:Ubuntu', path });
    await first.close();

    const main = await startMain({ machine, userDataDir });
    const envs = await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'connected'));
    expect(env(envs, 'wsl:Debian')?.state).toBe('stopped');
  });

  it('has its Environment failed when its distro is gone', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    const path = machine.gitRepo('billing-api');
    const userDataDir = tempDir('loom-wsl-');
    const first = await startMain({ machine, userDataDir });
    await waitFor(first.api, 'environments', state('wsl:Ubuntu', 'stopped'));
    await first.api.invoke('projects.link', { path, environmentId: 'wsl:Ubuntu' });
    await first.close();
    machine.installWsl([]);

    const main = await startMain({ machine, userDataDir });

    const envs = await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'failed'));
    expect(env(envs, 'wsl:Ubuntu')?.error).toMatch(/no distribution/);
  });
});
