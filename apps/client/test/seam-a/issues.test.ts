import { describe, expect, it } from 'vitest';
import { git, startMain, tempDir, tempMachine, waitFor, type ForgeCliScript, type Machine } from './harness';
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

async function withProject(machine: Machine, checkout: string, userDataDir?: string) {
  const main = await startMain({ machine, userDataDir });
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

describe('linking an issue to a Session', () => {
  it('links it, in place of any it had, kept when main starts again', async () => {
    const { machine, checkout } = machineOn('gh', 'https://github.com/theholocoder/loom.git');
    const userDataDir = tempDir('loom-issues-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix SSO' });
    expect(created.issue).toBeUndefined();

    await main.api.invoke('sessions.linkIssue', { id: created.id, issue: { number: darkMode.number, url: darkMode.url } });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.issue?.number === 7));
    await main.api.invoke('sessions.linkIssue', { id: created.id, issue: { number: loginBug.number, url: loginBug.url } });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.issue?.number === 31));
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    await main.close();

    const again = await startMain({ machine, userDataDir });
    expect((await again.api.invoke('sessions.list')).find((s) => s.id === created.id)?.issue).toEqual({ number: 31, url: loginBug.url });
  });

  it('rejects an issue with no number, or whose link is not a web page', async () => {
    const { machine, checkout } = machineOn('gh', 'https://github.com/theholocoder/loom.git');
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix SSO' });

    await expect(main.api.invoke('sessions.linkIssue', { id: created.id, issue: { number: 31, url: 'file:///etc/passwd' } })).rejects.toThrow('An issue needs a number and an http(s) link.');
    await expect(main.api.invoke('sessions.linkIssue', { id: created.id, issue: { number: 0, url: loginBug.url } })).rejects.toThrow('An issue needs a number and an http(s) link.');
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)?.issue).toBeUndefined();
  });
});

describe("the Issue Panel's read of the linked issue", () => {
  const scripted = { ...loginBug, labels: ['bug', 'sso'], author: 'aduval', createdAt: '2026-11-09T10:00:00Z', comments: 2 };

  it('reads its state, labels, title, author, age, comment count and body from GitHub', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['On it.'] }] } });
    machine.installForgeCli('gh', { signedInHosts: ['github.com'], issues: [scripted, { ...darkMode, state: 'closed' }] });
    const { main, project } = await withProject(machine, machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' }));
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', issue: loginBug, prompt: '' });

    expect(await main.api.invoke('sessions.issue', { id: created.id })).toEqual({
      number: 31,
      url: loginBug.url,
      title: 'Fix the login bug',
      state: 'open',
      labels: ['bug', 'sso'],
      author: 'aduval',
      at: Date.parse('2026-11-09T10:00:00Z'),
      comments: 2,
      body: loginBug.body,
    });
    const read = machine.forgeCliInvocations('gh').findLast((args) => args[0] === 'api')!;
    expect(read).toEqual(expect.arrayContaining(['repos/theholocoder/loom/issues/31', '--hostname', 'github.com']));

    // One closed since is read all the same.
    await main.api.invoke('sessions.linkIssue', { id: created.id, issue: { number: 7, url: darkMode.url } });
    expect(await main.api.invoke('sessions.issue', { id: created.id })).toMatchObject({ number: 7, state: 'closed', labels: [], comments: 0 });
  });

  it('reads it from GitLab through glab, in the working copy', async () => {
    const { machine, checkout } = machineOn('glab', 'git@gitlab.example.org:acme/loom.git');
    machine.installForgeCli('glab', { signedInHosts: ['gitlab.example.org'], issues: [scripted] });
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', issue: loginBug, prompt: '' });

    expect(await main.api.invoke('sessions.issue', { id: created.id })).toEqual({
      number: 31,
      url: loginBug.url,
      title: 'Fix the login bug',
      state: 'open',
      labels: ['bug', 'sso'],
      author: 'aduval',
      at: Date.parse('2026-11-09T10:00:00Z'),
      comments: 2,
      body: loginBug.body,
    });
    const at = machine.forgeCliInvocations('glab').findLastIndex((args) => args[0] === 'api');
    expect(machine.forgeCliInvocations('glab')[at]).toEqual(['api', 'projects/acme%2Floom/issues/31']);
    expect(machine.forgeCliCwds('glab')[at]).toBe(checkout);
  });

  it('rejects a Session with no issue, and says why the Forge could not answer', async () => {
    const { machine, checkout } = machineOn('gh', 'https://github.com/theholocoder/loom.git');
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix SSO' });
    await expect(main.api.invoke('sessions.issue', { id: created.id })).rejects.toThrow('This Session has no issue.');

    await main.api.invoke('sessions.linkIssue', { id: created.id, issue: { number: 99, url: 'https://github.com/theholocoder/loom/issues/99' } });
    await expect(main.api.invoke('sessions.issue', { id: created.id })).rejects.toThrow("gh api repos/theholocoder/loom/issues/99 failed: it wasn't found, or you don't have access to it\n\nDetails:\ngh: Not Found (HTTP 404)");
  });

  it("rejects one of GitHub's pull requests linked as an issue", async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['On it.'] }] } });
    const pull = { number: 40, title: 'Fix SSO', body: '', url: 'https://github.com/theholocoder/loom/pull/40', pullRequest: true };
    machine.installForgeCli('gh', { signedInHosts: ['github.com'], issues: [pull] });
    const { main, project } = await withProject(machine, machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' }));
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix SSO' });
    await main.api.invoke('sessions.linkIssue', { id: created.id, issue: { number: 40, url: pull.url } });

    await expect(main.api.invoke('sessions.issue', { id: created.id })).rejects.toThrow('#40 is a pull request on GitHub, not an issue.');
  });
});

describe('unlinking the issue from a Session', () => {
  it('unlinks it, kept when main starts again', async () => {
    const { machine, checkout } = machineOn('gh', 'https://github.com/theholocoder/loom.git');
    const userDataDir = tempDir('loom-issues-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', issue: loginBug, prompt: '' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));

    await main.api.invoke('sessions.unlinkIssue', { id: created.id });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.issue === undefined));
    await main.close();

    const again = await startMain({ machine, userDataDir });
    expect((await again.api.invoke('sessions.list')).find((s) => s.id === created.id)?.issue).toBeUndefined();
  });
});
