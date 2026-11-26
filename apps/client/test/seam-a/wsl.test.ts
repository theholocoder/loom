import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appVersion, launched, realBridgePath, startMain, tempDir, tempMachine, waitFor, type Machine } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const unix = describe.skipIf(process.platform === 'win32');

const env = (envs: EnvironmentStatus[], id: string) => envs.find((e) => e.id === id);
const state = (id: string, wanted: EnvironmentStatus['state']) => (envs: EnvironmentStatus[]) => env(envs, id)?.state === wanted;

const asWindowsShows = (distro: string, path: string) => `\\\\wsl.localhost\\${distro}${path.replaceAll('/', '\\')}`;

const installedBridge = (machine: Machine, distro: string) => join(machine.distroHome(distro), '.local/share/loom/bridge', appVersion, 'loom-bridge');

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
    expect(env(envs, 'wsl:Ubuntu-24.04')).toMatchObject({ label: 'Ubuntu-24.04', distro: 'Ubuntu-24.04', state: 'idle' });
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
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'idle'));
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
    await waitFor(first.api, 'environments', state('wsl:Ubuntu', 'idle'));
    await first.api.invoke('environments.start', { id: 'wsl:Ubuntu' });
    await waitFor(first.api, 'environments', state('wsl:Ubuntu', 'connected'));
    await first.close();
    const installedAt = statSync(installedBridge(machine, 'Ubuntu')).mtimeMs;

    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'idle'));
    await main.api.invoke('environments.start', { id: 'wsl:Ubuntu' });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'connected'));

    expect(statSync(installedBridge(machine, 'Ubuntu')).mtimeMs).toBe(installedAt);
  });

  it("replaces a bridge in the distro that is not this Client's", async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    staleBridge(installedBridge(machine, 'Ubuntu'));
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'idle'));

    await main.api.invoke('environments.start', { id: 'wsl:Ubuntu' });
    const envs = await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'connected'));

    expect(env(envs, 'wsl:Ubuntu')?.bridge?.version).toBe(appVersion);
    expect(readFileSync(installedBridge(machine, 'Ubuntu')).equals(readFileSync(realBridgePath))).toBe(true);
  });

  it('reloads its shell environment on its own', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu', 'Debian']);
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Debian', 'idle'));
    await main.api.invoke('environments.start', { id: 'wsl:Ubuntu' });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'connected'));

    await main.api.invoke('environments.reload', { id: 'wsl:Ubuntu' });

    const envs = await main.api.invoke('environments.list');
    expect(env(envs, 'wsl:Ubuntu')?.shellEnvironment).toBeDefined();
    expect(env(envs, 'wsl:Debian')?.state).toBe('idle');
  });
});

unix('a Project checked out in a WSL distro', () => {
  it('starts its Environment when linked, and at every start of Loom after', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu', 'Debian']);
    const path = machine.gitRepo('billing-api');
    const userDataDir = tempDir('loom-wsl-');
    const first = await startMain({ machine, userDataDir });
    await waitFor(first.api, 'environments', state('wsl:Ubuntu', 'idle'));

    const project = await first.api.invoke('projects.link', { path, environmentId: 'wsl:Ubuntu' });
    expect(project.checkout).toEqual({ environmentId: 'wsl:Ubuntu', path });
    await first.close();

    const main = await startMain({ machine, userDataDir });
    const envs = await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'connected'));
    expect(env(envs, 'wsl:Debian')?.state).toBe('idle');
  });

  it("is linked from the folder Windows shows for it, as the distro's own path", async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    const path = machine.gitRepo('billing-api');
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'idle'));

    const project = await main.api.invoke('projects.link', { path: asWindowsShows('Ubuntu', path), environmentId: 'wsl:Ubuntu' });

    expect(project.checkout).toEqual({ environmentId: 'wsl:Ubuntu', path });
    await expect(main.api.invoke('projects.link', { path: asWindowsShows('Debian', path).replace('wsl.localhost', 'wsl$'), environmentId: 'wsl:Ubuntu' })).rejects.toThrow('is in Debian, not Ubuntu');
  });

  it("is picked in a folder picker that opens in the distro's home", async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    const opened: Array<string | undefined> = [];
    const main = await startMain({ machine, chooseFolder: async (defaultPath) => (opened.push(defaultPath), null) });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'idle'));

    await main.api.invoke('dialogs.chooseFolder', { environmentId: 'wsl:Ubuntu' });
    await main.api.invoke('dialogs.chooseFolder');

    expect(opened).toEqual([asWindowsShows('Ubuntu', machine.distroHome('Ubuntu')), undefined]);
  });

  it('is linked from a Windows drive as the distro sees it, under /mnt', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'idle'));

    await expect(main.api.invoke('projects.link', { path: 'C:\\Users\\dev\\billing-api', environmentId: 'wsl:Ubuntu' })).rejects.toThrow('/mnt/c/Users/dev/billing-api');
  });

  it("has its worktree Sessions work in the distro's ~/loom/worktrees and /tmp, with nothing else of Loom's in the distro", async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }], acp: { turns: [{ chunks: ['Done.'] }] } });
    const checkout = machine.gitClone(machine.gitOrigin('billing-api', 'main'), 'billing-api');
    const userDataDir = tempDir('loom-wsl-');
    const main = await startMain({ machine, userDataDir });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'idle'));
    const project = await main.api.invoke('projects.link', { path: checkout, environmentId: 'wsl:Ubuntu' });

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    const sessions = await waitFor(main.api, 'sessions', (list: Session[]) => list.some((s) => s.id === id && s.status === 'waiting'));

    const home = machine.distroHome('Ubuntu');
    const worktree = `${home}/loom/worktrees/billing-api/fix-the-login-bug`;
    expect(sessions.find((s) => s.id === id)?.workingCopy).toEqual({ kind: 'worktree', path: worktree });
    const config = machine.acpMessages().find((m) => m.config)?.config;
    expect((JSON.parse(config!) as { permission: { external_directory: unknown } }).permission.external_directory).toEqual({ '*': 'ask', [`${worktree}/*`]: 'allow', '/tmp/*': 'allow' });
    expect(readdirSync(join(home, 'loom'))).toEqual(['worktrees']);
    expect(readdirSync(join(home, '.local/share/loom'))).toEqual(['bridge']);
    expect(readdirSync(userDataDir)).toContain('loom.db');
  });

  it('opens in the editor run in the distro, or in a Windows-only one with the path Windows shows for it', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }], acp: { turns: [{ chunks: ['Done.'] }] } });
    machine.installEditor('code');
    machine.installEditor('notepad.exe');
    const checkout = machine.gitRepo('billing-api');
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'idle'));
    const project = await main.api.invoke('projects.link', { path: checkout, environmentId: 'wsl:Ubuntu' });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix it' });
    await waitFor(main.api, 'sessions', (list: Session[]) => list.some((s) => s.id === id && s.status === 'waiting'));

    await main.api.invoke('sessions.openInEditor', { id, file: 'src/app.ts' });
    await main.api.invoke('settings.setEditorCommand', { editorCommand: 'notepad.exe' });
    await main.api.invoke('sessions.openInEditor', { id, file: 'src/app.ts' });

    expect(await launched(machine, 'code')).toEqual([{ args: [`${checkout}/src/app.ts`], cwd: checkout }]);
    expect((await launched(machine, 'notepad.exe')).map((run) => run.args)).toEqual([[asWindowsShows('Ubuntu', `${checkout}/src/app.ts`)]]);
  });

  it('has its Environment failed when its distro is gone', async () => {
    const machine = tempMachine();
    machine.installWsl(['Ubuntu']);
    const path = machine.gitRepo('billing-api');
    const userDataDir = tempDir('loom-wsl-');
    const first = await startMain({ machine, userDataDir });
    await waitFor(first.api, 'environments', state('wsl:Ubuntu', 'idle'));
    await first.api.invoke('projects.link', { path, environmentId: 'wsl:Ubuntu' });
    await first.close();
    machine.installWsl([]);

    const main = await startMain({ machine, userDataDir });

    const envs = await waitFor(main.api, 'environments', state('wsl:Ubuntu', 'failed'));
    expect(env(envs, 'wsl:Ubuntu')?.error).toMatch(/no distribution/);
  });
});
