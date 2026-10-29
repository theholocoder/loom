import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Machine, startMain, waitFor } from './harness';
import type { EnvironmentStatus } from '../../src/shared/api';

const connected = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.state === 'connected';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-projects-'));
  dirs.push(dir);
  return dir;
}

function newMachine() {
  const machine = new Machine();
  dirs.push(machine.dir);
  return machine;
}

async function started(machine = newMachine(), userDataDir?: string) {
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', connected);
  return main;
}

describe('linking an existing checkout', () => {
  it('adds it as a Project on the native Environment, with the default branch prefix', async () => {
    const machine = newMachine();
    const path = machine.gitRepo('billing-api');
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path });

    expect(project).toMatchObject({ name: 'billing-api', branchPrefix: 'loom', checkout: { environmentId: 'native', path } });
    expect(await main.api.invoke('projects.list')).toEqual([project]);
  });

  it('keeps the Project and its checkout when main starts again', async () => {
    const machine = newMachine();
    const userDataDir = tempUserData();
    const path = machine.gitRepo('billing-api');
    const first = await started(machine, userDataDir);
    const { id } = await first.api.invoke('projects.link', { path });
    await first.close();

    const second = await started(machine, userDataDir);

    const projects = await second.api.invoke('projects.list');
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id, name: 'billing-api', branchPrefix: 'loom', checkout: { environmentId: 'native', path } });
  });

  it('links the whole checkout when given a folder inside it', async () => {
    const machine = newMachine();
    const path = machine.gitRepo('billing-api');
    const inside = machine.folder('billing-api/src/invoices');
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: inside });

    expect(project.checkout.path).toBe(path);
  });

  it('rejects a folder that is not in a git repository', async () => {
    const machine = newMachine();
    const path = machine.folder('notes');
    const main = await started(machine);

    await expect(main.api.invoke('projects.link', { path })).rejects.toThrow(`${path} is not a git repository`);
    expect(await main.api.invoke('projects.list')).toEqual([]);
  });

  it('rejects a checkout that is already a Project', async () => {
    const machine = newMachine();
    const path = machine.gitRepo('billing-api');
    const main = await started(machine);
    await main.api.invoke('projects.link', { path });

    await expect(main.api.invoke('projects.link', { path })).rejects.toThrow(/already the Project "billing-api"/);
    expect(await main.api.invoke('projects.list')).toHaveLength(1);
  });

  it('publishes the Projects as they are added', async () => {
    const machine = newMachine();
    const main = await started(machine);

    await main.api.invoke('projects.link', { path: machine.gitRepo('docs-site') });
    await main.api.invoke('projects.link', { path: machine.gitRepo('billing-api') });

    const projects = await waitFor(main.api, 'projects', (p) => p.length === 2);
    expect(projects.map((p) => p.name)).toEqual(['billing-api', 'docs-site']);
  });
});

describe('detecting the Forge of a linked checkout', () => {
  it('turns Forge features on for a GitHub origin when gh is signed in to github.com', async () => {
    const machine = newMachine();
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });
    const path = machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path });

    expect(project.forge).toMatchObject({ state: 'available', kind: 'github', host: 'github.com', repository: 'theholocoder/loom', checking: false });
  });

  it('turns Forge features on for a GitLab origin when glab is signed in to its host', async () => {
    const machine = newMachine();
    machine.installForgeCli('glab', { signedInHosts: ['gitlab.com'] });
    const path = machine.gitRepo('billing-api', { origin: 'git@gitlab.com:acme/payments/billing-api.git' });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path });

    expect(project.forge).toMatchObject({ state: 'available', kind: 'gitlab', host: 'gitlab.com', repository: 'acme/payments/billing-api' });
  });

  it.each([
    ['https://github.com/theholocoder/loom', 'github.com', 'theholocoder/loom'],
    ['ssh://git@github.com:22/theholocoder/loom.git', 'github.com', 'theholocoder/loom'],
    ['git@github.acme.com:platform/loom.git', 'github.acme.com', 'platform/loom'],
  ])('recognises GitHub from the origin %s', async (origin, host, repository) => {
    const machine = newMachine();
    machine.installForgeCli('gh', { signedInHosts: [host] });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('loom', { origin }) });

    expect(project.forge).toMatchObject({ state: 'available', kind: 'github', host, repository });
  });

  it('recognises a self-hosted GitLab', async () => {
    const machine = newMachine();
    machine.installForgeCli('glab', { signedInHosts: ['gitlab.example.org'] });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('docs', { origin: 'https://gitlab.example.org/team/docs.git' }) });

    expect(project.forge).toMatchObject({ state: 'available', kind: 'gitlab', host: 'gitlab.example.org' });
  });

  it('accepts a checkout with no origin, with Forge features off', async () => {
    const machine = newMachine();
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('scratch') });

    expect(project.forge).toMatchObject({ state: 'no-remote', checking: false });
  });

  it.each(['https://bitbucket.org/acme/legacy.git', 'git@git.internal:acme/legacy.git', '/srv/git/legacy.git'])(
    'accepts a checkout whose origin %s is on no supported Forge, with Forge features off',
    async (origin) => {
      const machine = newMachine();
      const main = await started(machine);

      const project = await main.api.invoke('projects.link', { path: machine.gitRepo('legacy', { origin }) });

      expect(project.forge).toMatchObject({ state: 'unsupported', remote: origin });
    },
  );

  it("turns Forge features off when the Forge's CLI isn't installed", async () => {
    const machine = newMachine();
    machine.installForgeCli('glab', { signedInHosts: ['github.com'] });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' }) });

    expect(project.forge).toMatchObject({ state: 'cli-missing', kind: 'github', host: 'github.com' });
  });

  it("turns Forge features off when the CLI isn't signed in to origin's host", async () => {
    const machine = newMachine();
    machine.installForgeCli('glab', { signedInHosts: ['gitlab.com'] });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('docs', { origin: 'https://gitlab.example.org/team/docs.git' }) });

    expect(project.forge).toMatchObject({ state: 'signed-out', kind: 'gitlab', host: 'gitlab.example.org' });
    expect(project.forge.error).toMatch(/not logged into any accounts on gitlab\.example\.org/);
  });

  it('only asks the CLI for its sign-in status for the host', async () => {
    const machine = newMachine();
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });
    const main = await started(machine);

    await main.api.invoke('projects.link', { path: machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' }) });

    expect(machine.forgeCliInvocations('gh')).toEqual([['auth', 'status', '--hostname', 'github.com']]);
  });

  it('checks again when asked, as the Projects page does when it opens', async () => {
    const machine = newMachine();
    const main = await started(machine);
    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' }) });
    expect(project.forge.state).toBe('cli-missing');
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });

    await main.api.invoke('projects.check');

    expect((await main.api.invoke('projects.list'))[0]?.forge.state).toBe('available');
  });

  it('checks the Forge of every Project again when main starts', async () => {
    const machine = newMachine();
    const userDataDir = tempUserData();
    const path = machine.gitRepo('loom', { origin: 'git@github.com:theholocoder/loom.git' });
    const first = await started(machine, userDataDir);
    await first.api.invoke('projects.link', { path });
    await first.close();
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });

    const second = await startMain({ machine, userDataDir });

    const projects = await waitFor(second.api, 'projects', (p) => p[0]?.forge.state === 'available' && !p[0].forge.checking);
    expect(projects[0]?.forge).toMatchObject({ kind: 'github', host: 'github.com', repository: 'theholocoder/loom' });
  });
});

describe("a Project's branch prefix", () => {
  it('can be changed, and is kept when main starts again', async () => {
    const machine = newMachine();
    const userDataDir = tempUserData();
    const first = await started(machine, userDataDir);
    const { id } = await first.api.invoke('projects.link', { path: machine.gitRepo('loom') });

    await first.api.invoke('projects.setBranchPrefix', { id, branchPrefix: 'feat/loom' });

    expect((await waitFor(first.api, 'projects', (p) => p[0]?.branchPrefix !== 'loom'))[0]?.branchPrefix).toBe('feat/loom');
    await first.close();
    const second = await started(machine, userDataDir);
    expect((await second.api.invoke('projects.list'))[0]?.branchPrefix).toBe('feat/loom');
  });

  it.each(['', '  ', 'my prefix', 'feat..x', 'feat/', '/feat', 'feat~1', 'a:b', '.hidden', 'x.lock', 'a@{b', '@', '-feat'])(
    'refuses %j, which git would not accept at the start of a branch name',
    async (branchPrefix) => {
      const machine = newMachine();
      const main = await started(machine);
      const { id } = await main.api.invoke('projects.link', { path: machine.gitRepo('loom') });

      await expect(main.api.invoke('projects.setBranchPrefix', { id, branchPrefix })).rejects.toThrow(/branch prefix/);
      expect((await main.api.invoke('projects.list'))[0]?.branchPrefix).toBe('loom');
    },
  );

  it('rejects an unknown Project', async () => {
    const main = await started();

    await expect(main.api.invoke('projects.setBranchPrefix', { id: 42, branchPrefix: 'feat' })).rejects.toThrow(/unknown Project 42/);
  });
});
