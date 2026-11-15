import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { authState } from '../../src/main/projects/forge';
import { openDatabase } from '../../src/main/storage/database';
import { migrations } from '../../src/main/storage/migrations';
import { startMain, tempDir, tempMachine, waitFor, type Machine } from './harness';
import type { EnvironmentStatus } from '../../src/shared/api';
import { splitDetails } from '../../src/shared/errors';

const connected = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.state === 'connected';

async function started(machine = tempMachine(), userDataDir?: string) {
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', connected);
  return main;
}

describe('linking an existing checkout', () => {
  it('adds it as a Project on the native Environment, with the default branch prefix', async () => {
    const machine = tempMachine();
    const path = machine.gitRepo('billing-api');
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path });

    expect(project).toMatchObject({ name: 'billing-api', color: 'blue',
  branchPrefix: 'loom', checkout: { environmentId: 'native', path } });
    expect(await main.api.invoke('projects.list')).toEqual([project]);
  });

  it('keeps the Project and its checkout when main starts again', async () => {
    const machine = tempMachine();
    const userDataDir = tempDir('loom-projects-');
    const path = machine.gitRepo('billing-api');
    const first = await started(machine, userDataDir);
    const { id } = await first.api.invoke('projects.link', { path });
    await first.close();

    const second = await started(machine, userDataDir);

    const projects = await second.api.invoke('projects.list');
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id, name: 'billing-api', color: 'blue',
  branchPrefix: 'loom', checkout: { environmentId: 'native', path } });
  });

  it('links the whole checkout when given a folder inside it', async () => {
    const machine = tempMachine();
    const path = machine.gitRepo('billing-api');
    const inside = machine.folder('billing-api/src/invoices');
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: inside });

    expect(project.checkout.path).toBe(path);
  });

  it('rejects a folder that is not in a git repository', async () => {
    const machine = tempMachine();
    const path = machine.folder('notes');
    const main = await started(machine);

    const refusal = await main.api.invoke('projects.link', { path }).catch((error: Error) => error.message);
    expect(splitDetails(refusal as string)).toEqual({ message: `${path} isn't in a git repository`, details: expect.stringContaining('fatal: not a git repository') });
    expect(await main.api.invoke('projects.list')).toEqual([]);
  });

  it('rejects a checkout that is already a Project', async () => {
    const machine = tempMachine();
    const path = machine.gitRepo('billing-api');
    const main = await started(machine);
    await main.api.invoke('projects.link', { path });

    await expect(main.api.invoke('projects.link', { path })).rejects.toThrow(/already the Project "billing-api"/);
    expect(await main.api.invoke('projects.list')).toHaveLength(1);
  });

  it('rejects the second of two links of the same checkout made at once', async () => {
    const machine = tempMachine();
    const path = machine.gitRepo('billing-api');
    const main = await started(machine);

    const results = await Promise.allSettled([main.api.invoke('projects.link', { path }), main.api.invoke('projects.link', { path })]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/already the Project "billing-api"/);
  });

  it('publishes the Projects as they are added', async () => {
    const machine = tempMachine();
    const main = await started(machine);

    await main.api.invoke('projects.link', { path: machine.gitRepo('docs-site') });
    await main.api.invoke('projects.link', { path: machine.gitRepo('billing-api') });

    const projects = await waitFor(main.api, 'projects', (p) => p.length === 2);
    expect(projects.map((p) => p.name)).toEqual(['billing-api', 'docs-site']);
  });
});

describe('detecting the Forge of a linked checkout', () => {
  it('turns Forge features on for a GitHub origin when gh is signed in to github.com', async () => {
    const machine = tempMachine();
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });
    const path = machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path });

    expect(project.forge).toMatchObject({ state: 'available', kind: 'github', host: 'github.com', repository: 'theholocoder/loom', checking: false });
  });

  it('turns Forge features on for a GitLab origin when glab is signed in to its host', async () => {
    const machine = tempMachine();
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
    const machine = tempMachine();
    machine.installForgeCli('gh', { signedInHosts: [host] });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('loom', { origin }) });

    expect(project.forge).toMatchObject({ state: 'available', kind: 'github', host, repository });
  });

  it('recognises a self-hosted GitLab', async () => {
    const machine = tempMachine();
    machine.installForgeCli('glab', { signedInHosts: ['gitlab.example.org'] });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('docs', { origin: 'https://gitlab.example.org/team/docs.git' }) });

    expect(project.forge).toMatchObject({ state: 'available', kind: 'gitlab', host: 'gitlab.example.org' });
  });

  it('accepts a checkout with no origin, with Forge features off', async () => {
    const machine = tempMachine();
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('scratch') });

    expect(project.forge).toMatchObject({ state: 'no-remote', checking: false });
  });

  it.each(['https://bitbucket.org/acme/legacy.git', 'git@git.internal:acme/legacy.git', '/srv/git/legacy.git'])(
    'accepts a checkout whose origin %s is on no supported Forge, with Forge features off',
    async (origin) => {
      const machine = tempMachine();
      const main = await started(machine);

      const project = await main.api.invoke('projects.link', { path: machine.gitRepo('legacy', { origin }) });

      expect(project.forge).toMatchObject({ state: 'unsupported', remote: origin });
    },
  );

  it("turns Forge features off when the Forge's CLI isn't installed", async () => {
    const machine = tempMachine();
    machine.installForgeCli('glab', { signedInHosts: ['github.com'] });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' }) });

    expect(project.forge).toMatchObject({ state: 'cli-missing', kind: 'github', host: 'github.com' });
  });

  it("turns Forge features off when the CLI isn't signed in to origin's host", async () => {
    const machine = tempMachine();
    machine.installForgeCli('glab', { signedInHosts: ['gitlab.com'] });
    const main = await started(machine);

    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('docs', { origin: 'https://gitlab.example.org/team/docs.git' }) });

    expect(project.forge).toMatchObject({ state: 'signed-out', kind: 'gitlab', host: 'gitlab.example.org' });
    expect(project.forge.error).toMatch(/not logged into any accounts on gitlab\.example\.org/);
  });

  it('only asks the CLI for its sign-in status for the host', async () => {
    const machine = tempMachine();
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });
    const main = await started(machine);

    await main.api.invoke('projects.link', { path: machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' }) });

    expect(machine.forgeCliInvocations('gh')).toEqual([['auth', 'status', '--hostname', 'github.com']]);
  });

  it('checks again when asked, as the Projects page does when it opens', async () => {
    const machine = tempMachine();
    const main = await started(machine);
    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' }) });
    expect(project.forge.state).toBe('cli-missing');
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });

    await main.api.invoke('projects.check');

    expect((await main.api.invoke('projects.list'))[0]?.forge.state).toBe('available');
  });

  it('checks the Forge of every Project again when main starts', async () => {
    const machine = tempMachine();
    const userDataDir = tempDir('loom-projects-');
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

describe('a Project whose Environment is not connected', () => {
  it('keeps its last Forge status rather than reporting the check failed', async () => {
    const machine = tempMachine();
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });
    const main = await started(machine);
    await main.api.invoke('projects.link', { path: machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' }) });
    main.bridge().kill();
    await waitFor(main.api, 'environments', (e) => e[0]?.state === 'disconnected');

    await main.api.invoke('projects.check');

    expect((await main.api.invoke('projects.list'))[0]?.forge).toMatchObject({ state: 'available', checking: false });
  });
});

describe("a Project's branch prefix", () => {
  it('can be changed, and is kept when main starts again', async () => {
    const machine = tempMachine();
    const userDataDir = tempDir('loom-projects-');
    const first = await started(machine, userDataDir);
    const { id } = await first.api.invoke('projects.link', { path: machine.gitRepo('loom') });

    await first.api.invoke('projects.setBranchPrefix', { id, branchPrefix: 'feat/loom' });

    expect((await waitFor(first.api, 'projects', (p) => p[0]?.branchPrefix !== 'loom'))[0]?.branchPrefix).toBe('feat/loom');
    await first.close();
    const second = await started(machine, userDataDir);
    expect((await second.api.invoke('projects.list'))[0]?.branchPrefix).toBe('feat/loom');
  });

  it.each(['', '  ', 'my prefix', 'feat..x', '/', '/feat', 'feat~1', 'a:b', '.hidden', 'x.lock', 'a@{b', '@', '-feat'])(
    'refuses %j, which git would not accept at the start of a branch name',
    async (branchPrefix) => {
      const machine = tempMachine();
      const main = await started(machine);
      const { id } = await main.api.invoke('projects.link', { path: machine.gitRepo('loom') });

      await expect(main.api.invoke('projects.setBranchPrefix', { id, branchPrefix })).rejects.toThrow(/branch prefix/);
      expect((await main.api.invoke('projects.list'))[0]?.branchPrefix).toBe('loom');
    },
  );

  it.each(['feat/', 'feat//', ' feat/ '])('takes %j as "feat": Loom adds the / itself', async (branchPrefix) => {
    const machine = tempMachine();
    const main = await started(machine);
    const { id } = await main.api.invoke('projects.link', { path: machine.gitRepo('loom') });

    expect((await main.api.invoke('projects.setBranchPrefix', { id, branchPrefix })).branchPrefix).toBe('feat');
  });

  it('rejects an unknown Project', async () => {
    const main = await started();

    await expect(main.api.invoke('projects.setBranchPrefix', { id: 42, branchPrefix: 'feat' })).rejects.toThrow(/unknown Project 42/);
  });
});

describe("a Project's Forge on GitLab, as glab reports it", () => {
  const link = async (machine: Machine, origin: string) => (await started(machine)).api.invoke('projects.link', { path: machine.gitRepo('app', { origin }) });

  const repoView = { stdout: { path_with_namespace: 'axio/team/app', web_url: 'https://gitlab.axiocode.net/axio/team/app' } };

  it('lets glab resolve a GitLab on a different SSH host, from the checkout', async () => {
    const machine = tempMachine();
    machine.installForgeCli('glab', { signedInHosts: ['gitlab.axiocode.net'], repoView });
    const checkout = machine.gitRepo('app', { origin: 'git@gitlab-ssh.axiocode.net:axio/team/app.git' });

    const project = await (await started(machine)).api.invoke('projects.link', { path: checkout });

    expect(project.forge).toMatchObject({ state: 'available', kind: 'gitlab', host: 'gitlab.axiocode.net', repository: 'axio/team/app' });
    const index = machine.forgeCliInvocations('glab').findIndex((args) => args[0] === 'repo');
    expect(machine.forgeCliInvocations('glab')[index]).toEqual(['repo', 'view', '--output', 'json']);
    expect(machine.forgeCliCwds('glab')[index]).toBe(checkout);
  });

  it('keeps the port of the web URL glab reports', async () => {
    const machine = tempMachine();
    machine.installForgeCli('glab', { signedInHosts: [], repoView: { stdout: { path_with_namespace: 'a/b', web_url: 'https://git.acme.dev:8443/a/b' } } });

    expect((await link(machine, 'ssh://git@git.acme.dev:2222/a/b.git')).forge).toMatchObject({ state: 'available', kind: 'gitlab', host: 'git.acme.dev:8443', repository: 'a/b' });
  });

  const fixture = readFileSync(new URL('../fixtures/glab-auth-status-loic.txt', import.meta.url), 'utf8');
  const SSH = 'gitlab-ssh.axiocode.net';
  const origin = `git@${SSH}:axio/team/app.git`;

  it('reads the real glab auth status as signed in', () => {
    expect(authState(fixture, SSH)).toBe('signed-in');
  });

  it.each([
    ['stdout', 0], ['stdout', 1], ['stderr', 0], ['stderr', 1],
  ] as const)('falls back to glab auth status when repo view fails, printed on %s with exit %i', async (stream, exitCode) => {
    const machine = tempMachine();
    machine.installForgeCli('glab', {
      signedInHosts: [],
      repoView: { exitCode: 1, stderr: 'unknown flag: --output' },
      authStatus: { [SSH]: { [stream]: fixture, exitCode } },
    });

    expect((await link(machine, origin)).forge).toMatchObject({ kind: 'gitlab', host: SSH, repository: 'axio/team/app', state: 'available' });
  });

  it('prefers what repo view resolves for a hyphenated GitLab host', async () => {
    const machine = tempMachine();
    machine.installForgeCli('glab', { signedInHosts: [], repoView: { stdout: { path_with_namespace: 'axio/team/app', web_url: 'https://code.axiocode.net/axio/team/app' } } });

    expect((await link(machine, origin)).forge).toMatchObject({ kind: 'gitlab', host: 'code.axiocode.net', repository: 'axio/team/app', state: 'available' });
  });

  it("leaves a host glab can't resolve unsupported, with glab's reason", async () => {
    const machine = tempMachine();
    machine.installForgeCli('glab', { signedInHosts: [], repoView: { exitCode: 1, stderr: 'ERROR: none of the git remotes configured for this repository point to a known GitLab host.\n' } });

    const { forge } = await link(machine, 'git@git.internal:acme/app.git');

    expect(forge).toMatchObject({ state: 'unsupported', host: 'git.internal' });
    expect(forge.error).toMatch(/known GitLab host/);
  });

  it('leaves a host unsupported when glab is not installed', async () => {
    expect((await link(tempMachine(), 'git@git.internal:acme/app.git')).forge).toMatchObject({ state: 'unsupported', host: 'git.internal' });
  });

  const H = 'gitlab.acme.dev';
  it.each([
    ['logged in, exit 0', { stderr: `${H}\n  ✓ Logged in to ${H} as loic (/home/loic/.config/glab-cli/config.yml)\n  ✓ Git operations for ${H} configured to use ssh protocol.\n  ✓ Token: **************************\n`, exitCode: 0 }, 'available'],
    ['logged in with a warning, exit 1', { stderr: `${H}\n  ✓ Logged in to ${H} as loic (/home/loic/.config/glab-cli/config.yml)\n  ! Git operations for ${H} configured to use ssh protocol but no ssh key found.\n`, exitCode: 1 }, 'available'],
    ['not logged in, exit 0', { stderr: `x ${H} has not been authenticated with glab. Run \`glab auth login --hostname ${H}\` to authenticate.\n`, exitCode: 0 }, 'signed-out'],
    ['not logged in, exit 1', { stderr: `x ${H} has not been authenticated with glab. Run \`glab auth login --hostname ${H}\` to authenticate.\n`, exitCode: 1 }, 'signed-out'],
    ['an invalid token', { stderr: `${H}\n  x ${H}: API call failed: GET https://${H}/api/v4/user: 401 {message: 401 Unauthorized}\n  ✓ Token: **************************\n`, exitCode: 1 }, 'signed-out'],
    ['no token', { stderr: `${H}\n  x No token provided\n`, exitCode: 0 }, 'signed-out'],
    ['something unexpected, exit 1', { stderr: 'glab: some new message\n', exitCode: 1 }, 'available'],
  ] as const)('reads glab auth status from its output, not its exit code: %s', async (_, status, state) => {
    const machine = tempMachine();
    machine.installForgeCli('glab', { signedInHosts: [], authStatus: { [H]: status } });

    expect((await link(machine, `git@${H}:team/app.git`)).forge.state).toBe(state);
  });

  it('finds gh and glab through the same login-shell PATH lookup', async () => {
    const machine = tempMachine();
    // Both live only on the login shell's PATH, not on the bridge's own.
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });
    machine.installForgeCli('glab', { signedInHosts: ['gitlab.com'] });
    const main = await started(machine);

    const github = await main.api.invoke('projects.link', { path: machine.gitRepo('a', { origin: 'git@github.com:acme/a.git' }) });
    const gitlab = await main.api.invoke('projects.link', { path: machine.gitRepo('b', { origin: 'git@gitlab.com:acme/b.git' }) });

    expect([github.forge.state, gitlab.forge.state]).toEqual(['available', 'available']);
  });
});

describe("a Project's name, colour, avatar and default model", () => {
  it('can be changed together, and are kept when main starts again', async () => {
    const machine = tempMachine();
    const userDataDir = tempDir('loom-projects-');
    const first = await started(machine, userDataDir);
    const { id } = await first.api.invoke('projects.link', { path: machine.gitRepo('web-frontend') });

    const edited = await first.api.invoke('projects.edit', { id, name: '  Web  ', color: 'violet', avatar: '🦊', defaultModel: { model: 'anthropic/claude-haiku-5-5', effort: 'high' } });

    const expected = { id, name: 'Web', color: 'violet', avatar: '🦊', defaultModel: { model: 'anthropic/claude-haiku-5-5', effort: 'high' } };
    expect(edited).toMatchObject(expected);
    expect((await waitFor(first.api, 'projects', (p) => p[0]?.name === 'Web'))[0]).toMatchObject(expected);
    await first.close();
    const second = await started(machine, userDataDir);
    expect((await second.api.invoke('projects.list'))[0]).toMatchObject(expected);
  });

  it('changes only what is given', async () => {
    const machine = tempMachine();
    const main = await started(machine);
    const { id } = await main.api.invoke('projects.link', { path: machine.gitRepo('loom') });
    await main.api.invoke('projects.edit', { id, avatar: 'LM', defaultModel: { model: 'anthropic/claude-haiku-5-5' } });

    const edited = await main.api.invoke('projects.edit', { id, color: 'red' });

    expect(edited).toMatchObject({ name: 'loom', color: 'red', avatar: 'LM', defaultModel: { model: 'anthropic/claude-haiku-5-5' } });
  });

  it('clears the avatar and the default model with null, or an empty avatar', async () => {
    const machine = tempMachine();
    const main = await started(machine);
    const { id } = await main.api.invoke('projects.link', { path: machine.gitRepo('loom') });
    await main.api.invoke('projects.edit', { id, avatar: 'LM', defaultModel: { model: 'anthropic/claude-haiku-5-5', effort: 'high' } });

    const cleared = await main.api.invoke('projects.edit', { id, avatar: null, defaultModel: null });
    expect(cleared.avatar).toBeUndefined();
    expect(cleared.defaultModel).toBeUndefined();

    await main.api.invoke('projects.edit', { id, avatar: 'LM' });
    expect((await main.api.invoke('projects.edit', { id, avatar: '  ' })).avatar).toBeUndefined();
  });

  it.each([
    [{ name: '   ' }, /needs a name/],
    [{ name: 'x'.repeat(61) }, /at most 60 characters/],
    [{ avatar: 'ABC' }, /at most 2 characters/],
    [{ avatar: 'A B' }, /no spaces/],
    [{ color: 'beige' as never }, /unknown Project colour/],
    [{ defaultModel: { effort: 'high' } }, /pick the model too/],
  ])('refuses %o, and changes nothing', async (edit, error) => {
    const machine = tempMachine();
    const main = await started(machine);
    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('loom') });

    await expect(main.api.invoke('projects.edit', { id: project.id, ...edit })).rejects.toThrow(error);
    expect((await main.api.invoke('projects.list'))[0]).toEqual(expect.objectContaining({ name: 'loom', color: project.color }));
  });

  it('takes an emoji with its modifiers as one character of an avatar', async () => {
    const machine = tempMachine();
    const main = await started(machine);
    const { id } = await main.api.invoke('projects.link', { path: machine.gitRepo('loom') });

    expect((await main.api.invoke('projects.edit', { id, avatar: '👩🏽‍💻X' })).avatar).toBe('👩🏽‍💻X');
  });

  it('rejects an unknown Project', async () => {
    const main = await started();

    await expect(main.api.invoke('projects.edit', { id: 42, name: 'x' })).rejects.toThrow(/unknown Project 42/);
  });

  it('gives each new Project a colour no Project in use has yet', async () => {
    const machine = tempMachine();
    const main = await started(machine);
    const a = await main.api.invoke('projects.link', { path: machine.gitRepo('a') });
    await main.api.invoke('projects.edit', { id: a.id, color: 'orange' });

    const b = await main.api.invoke('projects.link', { path: machine.gitRepo('b') });
    const c = await main.api.invoke('projects.link', { path: machine.gitRepo('c') });

    expect([b.color, c.color]).toEqual(['blue', 'aqua']);
  });

  it("gives a new Project a removed Project's colour only once every other is taken", async () => {
    const machine = tempMachine();
    const main = await started(machine);
    const a = await main.api.invoke('projects.link', { path: machine.gitRepo('a') });
    await main.api.invoke('projects.remove', { id: a.id });

    expect((await main.api.invoke('projects.link', { path: machine.gitRepo('b') })).color).toBe('orange');
  });

  it('keeps its name and colour while removed, and brings them back on restore', async () => {
    const machine = tempMachine();
    const main = await started(machine);
    const path = machine.gitRepo('loom');
    const { id } = await main.api.invoke('projects.link', { path });
    await main.api.invoke('projects.edit', { id, name: 'Loom app', color: 'green', avatar: 'LA' });

    await main.api.invoke('projects.remove', { id });

    expect(await main.api.invoke('projects.restorable', { path })).toMatchObject({ id, name: 'Loom app' });
    expect((await waitFor(main.api, 'removedProjects', (r) => r.length === 1))[0]).toEqual({ id, name: 'Loom app', color: 'green' });
    const restored = await main.api.invoke('projects.link', { path, restore: id });
    expect(restored).toMatchObject({ id, name: 'Loom app', color: 'green', avatar: 'LA' });
  });
});

describe('Projects from before they had a colour', () => {
  it('keep the colour each had, by id, among the first three', async () => {
    const machine = tempMachine();
    const userDataDir = tempDir('loom-projects-');
    // The migration before colours, avatars and default models came in.
    await (await openDatabase(userDataDir, { migrations: migrations.slice(0, COLOR_MIGRATION - 1) })).destroy();
    const db = new Database(join(userDataDir, 'loom.db'));
    for (const [i, name] of ['a', 'b', 'c', 'd'].entries()) {
      db.prepare('insert into projects (id, name, branch_prefix, created_at) values (?, ?, ?, 0)').run(i + 1, name, 'loom');
      db.prepare("insert into checkouts (project_id, environment_id, path) values (?, 'native', ?)").run(i + 1, machine.gitRepo(name));
    }
    db.close();

    const main = await started(machine, userDataDir);

    const projects = await main.api.invoke('projects.list');
    expect(projects.map((p) => [p.name, p.color])).toEqual([['a', 'orange'], ['b', 'aqua'], ['c', 'blue'], ['d', 'orange']]);
    expect(projects.every((p) => p.avatar === undefined && p.defaultModel === undefined)).toBe(true);
  });
});

/** The migration that brought in Projects' colours, avatars and default models (with the Panel model and Session highlights). */
const COLOR_MIGRATION = 18;
