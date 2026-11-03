import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type AcpTurn, type Machine } from './harness';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

/** A machine with a ready OpenCode playing `turns`, and a git checkout. */
function machineWith(turns: AcpTurn[]): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

async function started(machine: Machine, userDataDir?: string) {
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  return main;
}

/** Main with a Project on `checkout`. */
async function withProject(machine: Machine, checkout: string, userDataDir?: string) {
  const main = await started(machine, userDataDir);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

const agentText = (items: TranscriptItem[]) =>
  items
    .filter((i) => i.kind === 'agent')
    .map((i) => i.text)
    .join('');

describe('a checkout Session', () => {
  it("streams the agent's reply while Working, then waits as finished", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Hello', ', world'], hold: 'reply' }]);
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Say hello' });

    expect(created).toMatchObject({ projectId: project.id, title: 'Say hello', agent: 'OpenCode', workingCopy: { kind: 'checkout', path: checkout }, status: 'working' });
    const streaming = await waitFor(main.api, 'transcript', (items) => agentText(items) === 'Hello, world', { sessionId: created.id });
    expect(streaming).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Say hello' },
      { kind: 'agent', id: expect.any(Number), text: 'Hello, world', streaming: true },
    ]);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)?.status).toBe('working');

    machine.release('reply');

    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting' && s.waitingReason === 'finished'));
    expect(await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && !i.streaming), { sessionId: created.id })).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Say hello' },
      { kind: 'agent', id: expect.any(Number), text: 'Hello, world', streaming: false },
    ]);
  });

  it('waits on an error, showing the provider error, when the run fails', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Let me'], error: 'Insufficient credits: add more at https://example.com/billing' }]);
    const { main, project } = await withProject(machine, checkout);

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix it' });

    const [failed] = (await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'))).filter((s) => s.id === id);
    expect(failed).toMatchObject({ waitingReason: 'error', error: 'Insufficient credits: add more at https://example.com/billing' });
    expect(await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'error'), { sessionId: id })).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Fix it' },
      { kind: 'agent', id: expect.any(Number), text: 'Let me', streaming: false },
      { kind: 'error', id: expect.any(Number), message: 'Insufficient credits: add more at https://example.com/billing' },
    ]);
  });

  it("runs its own opencode acp in the checkout, and stores the agent's ses_ id", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const userDataDir = tempDir('loom-sessions-');
    const { main, project } = await withProject(machine, checkout, userDataDir);

    const first = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'One' });
    const second = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Two' });
    const settled = await waitFor(main.api, 'sessions', (list) => [first.id, second.id].every((id) => session(id, (s) => s.status === 'waiting')(list)));

    expect(machine.opencodeInvocations().filter((argv) => argv[0] === 'acp')).toEqual([['acp'], ['acp']]);
    const messages = machine.acpMessages();
    expect(new Set(messages.map((m) => m.pid)).size).toBe(2);
    expect(messages.every((m) => m.cwd === checkout)).toBe(true);
    expect(messages.filter((m) => m.message.method === 'session/new').map((m) => m.message.params?.cwd)).toEqual([checkout, checkout]);
    const ids = [first.id, second.id].map((id) => settled.find((s) => s.id === id)!.agentSessionId);
    for (const [i, prompt] of ['One', 'Two'].entries()) {
      expect(ids[i]).toMatch(/^ses_/);
      const sent = messages.find((m) => m.message.method === 'session/prompt' && m.message.params?.sessionId === ids[i]);
      expect(sent?.message.params?.prompt).toEqual([{ type: 'text', text: prompt }]);
    }

    await main.close();
    const again = await started(machine, userDataDir);
    const kept = await again.api.invoke('sessions.list');
    expect(kept.map((s) => [s.title, s.agentSessionId, s.status, s.waitingReason])).toEqual([
      ['Two', ids[1], 'waiting', 'finished'],
      ['One', ids[0], 'waiting', 'finished'],
    ]);
  });

  it('sends a reply to the same agent conversation, Working again until it settles', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['First answer.'] }, { chunks: ['Second answer.'], hold: 'second' }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    await main.api.invoke('sessions.send', { id, prompt: 'Second' });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'working' && s.waitingReason === undefined));
    await expect(main.api.invoke('sessions.send', { id, prompt: 'Third' })).rejects.toThrow('The agent is still working on this Session.');
    machine.release('second');
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'finished'));
    expect((await waitFor(main.api, 'transcript', (items) => items.length === 4, { sessionId: id })).map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([
      ['user', 'First'],
      ['agent', 'First answer.'],
      ['user', 'Second'],
      ['agent', 'Second answer.'],
    ]);
    const prompts = machine.acpMessages().filter((m) => m.message.method === 'session/prompt');
    expect(new Set(prompts.map((m) => m.pid)).size).toBe(1);
    expect(new Set(prompts.map((m) => m.message.params?.sessionId)).size).toBe(1);
  });

  it('waits on an error when the agent process exits during a run', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it'], hold: 'never' }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    process.kill(machine.acpMessages()[0]!.pid, 'SIGKILL');

    const [failed] = (await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'))).filter((s) => s.id === id);
    expect(failed).toMatchObject({ waitingReason: 'error' });
    // Killed on Linux; on Windows, the stand-in's .cmd shim exits with a code.
    expect(failed!.error).toMatch(/^the agent (was killed|exited with code \d+)$/);
  });

  it('waits on an error when OpenCode is not installed', async () => {
    const machine = tempMachine();
    const checkout = machine.gitRepo('billing-api');
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', (envs) => envs[0]?.agent?.state === 'missing');
    const project = await main.api.invoke('projects.link', { path: checkout });

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });

    const [failed] = (await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'))).filter((s) => s.id === id);
    expect(failed).toMatchObject({ waitingReason: 'error', error: "OpenCode isn't installed in Native, or isn't on your shell's PATH." });
  });

  it('is Waiting as interrupted when main starts again after quitting during a run', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Halfway'], hold: 'never' }]);
    const userDataDir = tempDir('loom-sessions-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.close();

    const again = await started(machine, userDataDir);

    expect((await again.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'waiting', waitingReason: 'interrupted' });
  });
});

describe('Session status for the Inbox', () => {
  it('is unread once it goes Waiting, until the user marks it read, and stays as marked after a restart', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const userDataDir = tempDir('loom-sessions-');
    const { main, project } = await withProject(machine, checkout, userDataDir);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    expect(created.unread).toBe(false);
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting' && s.unread));

    await main.api.invoke('sessions.setUnread', { id: created.id, unread: false });
    await waitFor(main.api, 'sessions', session(created.id, (s) => !s.unread));
    await main.api.invoke('sessions.setUnread', { id: created.id, unread: true });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.unread));
    await main.api.invoke('sessions.setUnread', { id: created.id, unread: false });
    await main.close();

    const again = await started(machine, userDataDir);
    expect((await again.api.invoke('sessions.list')).find((s) => s.id === created.id)).toMatchObject({ status: 'waiting', unread: false });
  });

  it('is unread when it comes back interrupted after a restart', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Halfway'], hold: 'never' }]);
    const userDataDir = tempDir('loom-sessions-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.close();

    const again = await started(machine, userDataDir);

    expect((await again.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ waitingReason: 'interrupted', unread: true });
  });

  it('is read again once the user replies', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['First.'] }, { chunks: ['Second.'], hold: 'second' }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.unread));

    await main.api.invoke('sessions.send', { id, prompt: 'Second' });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'working' && !s.unread));
    machine.release('second');
  });

  it("shows its working copy's branch, following it after each turn", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['First.'] }, { chunks: ['Second.'] }]);
    execFileSync('git', ['-C', checkout, 'checkout', '--quiet', '-b', 'loom/31-mr-button']);
    const { main, project } = await withProject(machine, checkout);

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.branch === 'loom/31-mr-button'));

    execFileSync('git', ['-C', checkout, 'checkout', '--quiet', '-b', 'loom/32-other']);
    await main.api.invoke('sessions.send', { id, prompt: 'Second' });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.branch === 'loom/32-other'));
  });

  it('archives a checkout Session: read, its agent stopped, no more messages, and kept after a restart', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const userDataDir = tempDir('loom-sessions-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    await main.api.invoke('sessions.archive', { id });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'archived' && s.waitingReason === undefined && !s.unread));
    await processEnded(machine.acpMessages()[0]!.pid);
    await expect(main.api.invoke('sessions.send', { id, prompt: 'More' })).rejects.toThrow('This Session is archived.');
    await main.close();
    const again = await started(machine, userDataDir);
    expect((await again.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'archived', unread: false });
  });

  it('archives a Working Session, stopping its run', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it'], hold: 'never' }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    await main.api.invoke('sessions.archive', { id });

    await processEnded(machine.acpMessages()[0]!.pid);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'archived' });
    expect((await waitFor(main.api, 'transcript', () => true, { sessionId: id })).some((i) => i.kind === 'error')).toBe(false);
  });
});


describe('Merge requests and links', () => {
  it('asks the agent to open or update the Merge request, Working until it settles', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done.'] }, { chunks: ['Opened !12.'], hold: 'mr' }] } });
    machine.installForgeCli('glab', { signedInHosts: ['gitlab.com'] });
    const checkout = machine.gitRepo('billing-api', { origin: 'git@gitlab.com:acme/billing-api.git' });
    const { main, project } = await withProject(machine, checkout);
    expect(project.forge.state).toBe('available');
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix it' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    await main.api.invoke('sessions.requestMergeRequest', { id });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'working'));
    const prompts = await eventually(() => {
      const sent = machine.acpMessages().filter((m) => m.message.method === 'session/prompt');
      return sent.length === 2 ? sent : undefined;
    });
    expect(prompts[1]!.message.params?.prompt).toEqual([
      {
        type: 'text',
        text: 'Open a Merge request for this branch with glab, or update it if one is already open: push the branch, then write its title and description from our conversation.',
      },
    ]);
    machine.release('mr');
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'finished'));
  });

  it("refuses to ask for a Merge request when the Project's Forge is off", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix it' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    await expect(main.api.invoke('sessions.requestMergeRequest', { id })).rejects.toThrow("Merge requests need the Project's Forge, which is off.");
    expect(machine.acpMessages().filter((m) => m.message.method === 'session/prompt')).toHaveLength(1);
  });

  it('refuses to ask for a Merge request on the default branch, or off any branch', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done.'] }] } });
    machine.installForgeCli('gh', { signedInHosts: ['github.com'] });
    const checkout = machine.gitRepo('loom', { origin: 'https://github.com/theholocoder/loom.git' });
    const git = (...args: string[]) => execFileSync('git', ['-C', checkout, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args]);
    git('symbolic-ref', 'HEAD', 'refs/heads/main');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git('commit', '--quiet', '--allow-empty', '-m', 'Start');
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Look around' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    await expect(main.api.invoke('sessions.requestMergeRequest', { id })).rejects.toThrow(
      "This Session is on main, the default branch. A Merge request needs a branch of its own.",
    );
    git('checkout', '--quiet', '--detach');
    await expect(main.api.invoke('sessions.requestMergeRequest', { id })).rejects.toThrow("This Session's working copy isn't on a branch.");
    git('checkout', '--quiet', '-b', 'loom/31-mr-button');
    await main.api.invoke('sessions.requestMergeRequest', { id });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'finished'));
    expect(machine.acpMessages().filter((m) => m.message.method === 'session/prompt')).toHaveLength(2);
  });

  it("says when the Project's Forge hasn't been checked yet", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const userDataDir = tempDir('loom-sessions-');
    const first = await withProject(machine, checkout, userDataDir);
    const { id } = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(first.main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    await first.main.close();
    // With no bridge, the Environment never connects, so no Forge is checked.
    const again = await startMain({ machine, userDataDir, bridgePath: '/nonexistent/loom-bridge' });
    await waitFor(again.api, 'environments', (envs) => envs[0]?.state === 'failed');
    expect((await again.api.invoke('projects.list'))[0]?.forge.state).toBe('unknown');

    await expect(again.api.invoke('sessions.requestMergeRequest', { id })).rejects.toThrow("Loom hasn't checked this Project's Forge yet.");
  });

  it("reports a Session's linked issue and Merge request", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const userDataDir = tempDir('loom-sessions-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix it' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).not.toHaveProperty('issue');
    await main.close();
    // Linking issues and Merge requests comes later (#65, #66); until then, the database is the only way in.
    const db = new Database(join(userDataDir, 'loom.db'));
    db.prepare('update sessions set issue_number = 31, issue_url = ?, merge_request_number = 40, merge_request_url = ? where id = ?').run(
      'https://github.com/theholocoder/loom/issues/31',
      'https://github.com/theholocoder/loom/pull/40',
      id,
    );
    db.close();

    const again = await started(machine, userDataDir);

    expect((await again.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({
      issue: { number: 31, url: 'https://github.com/theholocoder/loom/issues/31' },
      mergeRequest: { number: 40, url: 'https://github.com/theholocoder/loom/pull/40' },
    });
  });

  it("opens web links in the user's browser, and nothing else", async () => {
    const main = await startMain();

    await main.api.invoke('links.open', { url: 'https://gitlab.com/acme/billing-api/-/merge_requests/87' });
    await expect(main.api.invoke('links.open', { url: 'file:///etc/passwd' })).rejects.toThrow('Loom only opens web links.');
    await expect(main.api.invoke('links.open', { url: 'not a url' })).rejects.toThrow('Loom only opens web links.');

    expect(main.opened).toEqual(['https://gitlab.com/acme/billing-api/-/merge_requests/87']);
  });
});

/** Resolves once the process with `pid` has exited. */
async function processEnded(pid: number): Promise<void> {
  await eventually(() => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
}

/** Resolves with what `check` returns once it returns something. */
async function eventually<T>(check: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("a Session's transcript", () => {
  it('loses at most about a second of streaming text when main is killed mid-stream', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Hello', ', wor', { hold: 'rest' }, 'ld!'], hold: 'never' }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Say hello' });
    await waitFor(main.api, 'transcript', (items) => agentText(items) === 'Hello, wor', { sessionId: id });
    main.clock.advance(1000);
    await eventually(() => (savedAgentText(main.userDataDir, id) === 'Hello, wor' ? true : undefined));
    machine.release('rest');
    await waitFor(main.api, 'transcript', (items) => agentText(items) === 'Hello, world!', { sessionId: id });

    // A kill leaves the database as it is on disk: start main on a copy of it.
    // Main runs in this process and writes synchronously, so the copy can't be torn.
    const killed = killedCopy(main.userDataDir);
    const again = await started(machine, killed);

    expect(await waitFor(again.api, 'transcript', (items) => items.length > 0, { sessionId: id })).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Say hello' },
      { kind: 'agent', id: expect.any(Number), text: 'Hello, wor', streaming: false },
    ]);
    expect((await again.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'waiting', waitingReason: 'interrupted' });
  });

  it('is replayed from the database when main starts again', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Hello', ', world'] }, { error: 'provider overloaded' }]);
    const userDataDir = tempDir('loom-transcript-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Say hello' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    await main.api.invoke('sessions.send', { id, prompt: 'Again' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.waitingReason === 'error'));
    await main.close();

    const again = await started(machine, userDataDir);

    expect(await waitFor(again.api, 'transcript', (items) => items.length > 0, { sessionId: id })).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Say hello' },
      { kind: 'agent', id: expect.any(Number), text: 'Hello, world', streaming: false },
      { kind: 'user', id: expect.any(Number), text: 'Again' },
      { kind: 'error', id: expect.any(Number), message: 'provider overloaded' },
    ]);
  });
});

/** A copy of main's database files as they are on disk now, as a kill would leave them. */
function killedCopy(userDataDir: string): string {
  const copy = tempDir('loom-killed-');
  for (const file of ['loom.db', 'loom.db-wal']) {
    if (existsSync(join(userDataDir, file))) copyFileSync(join(userDataDir, file), join(copy, file));
  }
  return copy;
}

/** The agent text main has written so far for the Session, read as another process would. */
function savedAgentText(userDataDir: string, sessionId: number): string {
  const db = new Database(join(userDataDir, 'loom.db'), { readonly: true });
  try {
    const rows = db.prepare("SELECT data FROM events WHERE session_id = ? AND kind = 'agent' ORDER BY seq").all(sessionId) as Array<{ data: string }>;
    return rows.map((r) => (JSON.parse(r.data) as { text: string }).text).join('');
  } finally {
    db.close();
  }
}
