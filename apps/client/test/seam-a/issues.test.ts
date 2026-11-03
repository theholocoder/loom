import { describe, expect, it } from 'vitest';
import { git, startMain, tempMachine, waitFor, type ForgeCliScript, type Machine } from './harness';
import type { EnvironmentStatus, Issue, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

const loginBug: Issue = {
  number: 31,
  title: 'Fix the login bug',
  body: 'Signing in with SSO returns a 500.\nSteps: …',
  url: 'https://github.com/theholocoder/loom/issues/31',
};
const darkMode: Issue = { number: 7, title: 'Dark mode', body: 'Assigned to someone else.', url: 'https://github.com/theholocoder/loom/issues/7' };
const issues: ForgeCliScript['issues'] = [loginBug, darkMode];

async function withProject(machine: Machine, checkout: string) {
  const main = await startMain({ machine });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

function machineOn(cli: 'gh' | 'glab', origin: string, turns = [{ chunks: ['On it.'] }]) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  machine.installForgeCli(cli, { signedInHosts: [cli === 'gh' ? 'github.com' : 'gitlab.example.org'], issues });
  return { machine, checkout: machine.gitRepo('loom', { origin }) };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

async function eventually<T>(check: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('the issue picker', () => {
  it("lists any open issue on a GitHub Project's repository, and searches them", async () => {
    const { machine, checkout } = machineOn('gh', 'https://github.com/theholocoder/loom.git');
    const { main, project } = await withProject(machine, checkout);

    expect(await main.api.invoke('projects.issues', { id: project.id })).toEqual([loginBug, darkMode]);
    expect(await main.api.invoke('projects.issues', { id: project.id, search: 'SSO' })).toEqual([loginBug]);

    const lists = machine.forgeCliInvocations('gh').filter((args) => args[0] === 'issue');
    expect(lists[0]).toEqual(expect.arrayContaining(['issue', 'list', '--repo', 'github.com/theholocoder/loom', '--state', 'open', '--limit', '100']));
    expect(lists[0]).not.toContain('--assignee');
    expect(lists[1]).toEqual(expect.arrayContaining(['--search', 'SSO']));
  });

  it("lists a GitLab Project's open issues through glab", async () => {
    const { machine, checkout } = machineOn('glab', 'git@gitlab.example.org:acme/loom.git');
    const { main, project } = await withProject(machine, checkout);

    expect(await main.api.invoke('projects.issues', { id: project.id, search: 'login' })).toEqual([loginBug]);
    const list = machine.forgeCliInvocations('glab').find((args) => args[0] === 'issue')!;
    expect(list).toEqual(expect.arrayContaining(['issue', 'list', '--per-page', '100', '--search', 'login']));
    expect(list).not.toContain('--repo');
    expect(machine.forgeCliCwds('glab')[machine.forgeCliInvocations('glab').findIndex((args) => args[0] === 'issue')]).toBe(checkout);
  });

  it("is refused when the Project's Forge is off", async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [] } });
    const { main, project } = await withProject(machine, machine.gitRepo('loom'));

    await expect(main.api.invoke('projects.issues', { id: project.id })).rejects.toThrow("Issues need the Project's Forge, which is off.");
  });
});

describe('a Session started from an issue', () => {
  it('is linked to the issue, its first prompt giving the title, body and URL', async () => {
    const { machine, checkout } = machineOn('gh', 'https://github.com/theholocoder/loom.git');
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', issue: loginBug, prompt: 'Keep it small.' });

    expect(created).toMatchObject({ title: '#31 Fix the login bug', issue: { number: 31, url: loginBug.url } });
    expect(created.issue).toEqual({ number: 31, url: loginBug.url });
    const prompt = await eventually(() => machine.acpMessages().find((m) => m.message.method === 'session/prompt'));
    expect(prompt.message.params?.prompt).toEqual([
      {
        type: 'text',
        text: `#31 Fix the login bug\n${loginBug.url}\n\nSigning in with SSO returns a 500.\nSteps: …\n\nKeep it small.`,
      },
    ]);
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    // Kept when main starts again.
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)?.issue).toEqual({ number: 31, url: loginBug.url });
  });

  it("needs no prompt of the user's own", async () => {
    const { machine, checkout } = machineOn('gh', 'https://github.com/theholocoder/loom.git');
    const { main, project } = await withProject(machine, checkout);

    await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', issue: darkMode, prompt: '' });

    const prompt = await eventually(() => machine.acpMessages().find((m) => m.message.method === 'session/prompt'));
    expect(prompt.message.params?.prompt).toEqual([{ type: 'text', text: `#7 Dark mode\n${darkMode.url}\n\nAssigned to someone else.` }]);
  });

  it('rejects an issue whose link is not a web page', async () => {
    const { machine, checkout } = machineOn('gh', 'https://github.com/theholocoder/loom.git');
    const { main, project } = await withProject(machine, checkout);

    await expect(
      main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', issue: { ...loginBug, url: 'file:///etc/passwd' }, prompt: '' }),
    ).rejects.toThrow('An issue needs a number and an http(s) link.');
  });

  it('gets a worktree on <prefix>/<issue#>-<slug>, and an issue can have several Sessions', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [] } });
    const origin = machine.gitOrigin('billing-api', 'main');
    const checkout = machine.gitClone(origin, 'billing-api');
    const { main, project } = await withProject(machine, checkout);

    const first = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', issue: loginBug, prompt: '' });
    const second = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', issue: loginBug, prompt: 'Another try' });

    expect(first).toMatchObject({ branch: 'loom/31-fix-the-login-bug', issue: { number: 31 } });
    expect(git(first.workingCopy.path, 'symbolic-ref', '--short', 'HEAD')).toBe('loom/31-fix-the-login-bug');
    expect(second).toMatchObject({ branch: 'loom/31-fix-the-login-bug-2', issue: { number: 31 } });
    // The branch the user typed wins.
    const third = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', issue: loginBug, branch: 'loom/sso', prompt: '' });
    expect(third.branch).toBe('loom/sso');
  });
});
