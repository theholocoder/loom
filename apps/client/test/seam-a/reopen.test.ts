import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, processEnded, startMain, tempDir, tempMachine, waitFor, type Machine, type OpencodeScript } from './harness';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

const models = [
  { providerID: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 200_000 },
  { providerID: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', context: 200_000 },
];

function machineWith(acp: OpencodeScript['acp']): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, models, acp });
  const origin = machine.gitOrigin('billing-api');
  return { machine, checkout: machine.gitClone(origin, 'billing-api') };
}

async function withProject(machine: Machine, checkout: string) {
  const main = await startMain({ machine });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};
const texts = (items: TranscriptItem[]) => items.map((i) => [i.kind, 'text' in i ? i.text : '']);

describe('a new message to an archived Session', () => {
  it('reopens a checkout Session, resuming its conversation', async () => {
    const { machine, checkout } = machineWith({ turns: [{ chunks: ['Done.'] }], resumedTurns: [{ chunks: ['Back at it.'] }] });
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    const { agentSessionId } = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    await main.api.invoke('sessions.archive', { id });
    await processEnded(machine.acpMessages()[0]!.pid);

    await main.api.invoke('sessions.send', { id, prompt: 'One more thing' });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'finished'));
    expect(machine.acpMessages().find((m) => m.message.method === 'session/resume')?.message.params?.sessionId).toBe(agentSessionId);
    expect(texts(await waitFor(main.api, 'transcript', (items) => items.filter((i) => i.kind === 'agent').length === 2, { sessionId: id })).filter(([kind]) => kind !== 'merge-request-ended')).toEqual([
      ['user', 'First'],
      ['agent', 'Done.'],
      ['user', 'One more thing'],
      ['agent', 'Back at it.'],
    ]);
  });

  it('reopens a worktree Session in a worktree made again on its kept branch, where it was', async () => {
    const { machine, checkout } = machineWith({ turns: [{ chunks: ['Done.'] }], resumedTurns: [{ chunks: ['Back at it.'] }] });
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    const path = created.workingCopy.path;
    const commit = machine.commit(path, 'fix.txt', 'fixed\n');
    await main.api.invoke('sessions.archive', { id: created.id, discard: true });
    expect(existsSync(path)).toBe(false);

    await main.api.invoke('sessions.send', { id: created.id, prompt: 'One more thing' });

    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting' && s.waitingReason === 'finished'));
    expect(readFileSync(join(path, 'fix.txt'), 'utf8')).toBe('fixed\n');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(commit);
    expect(git(path, 'branch', '--show-current')).toBe('loom/fix-the-login-bug');
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)).toMatchObject({ workingCopy: { kind: 'worktree', path }, branch: 'loom/fix-the-login-bug' });
    expect(machine.acpMessages().filter((m) => m.message.method === 'session/resume').at(-1)?.cwd).toBe(path);
  });

  it("is turned down, leaving it archived, when its worktree's branch is gone", async () => {
    const { machine, checkout } = machineWith({ turns: [{ chunks: ['Done.'] }] });
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    await main.api.invoke('sessions.archive', { id: created.id });
    git(checkout, 'branch', '-D', 'loom/fix-the-login-bug');

    await expect(main.api.invoke('sessions.send', { id: created.id, prompt: 'One more thing' })).rejects.toThrow(/There's no local branch "loom\/fix-the-login-bug"/);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)).toMatchObject({ status: 'archived' });
  });

  it("is turned down when the Session's Project was removed", async () => {
    const { machine, checkout } = machineWith({ turns: [{ chunks: ['Done.'] }] });
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    await main.api.invoke('projects.remove', { id: project.id });

    await expect(main.api.invoke('sessions.send', { id, prompt: 'One more thing' })).rejects.toThrow("This Session's Project was removed, so it can't be reopened.");
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'archived' });
  });

  /** An archived worktree Session, its worktree gone, its branch kept. */
  async function archivedWorktreeSession(acp: OpencodeScript['acp'] = { turns: [{ chunks: ['Done.'] }], resumedTurns: [{ chunks: ['Back at it.'] }] }) {
    const { machine, checkout } = machineWith(acp);
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    await main.api.invoke('sessions.archive', { id: created.id });
    return { machine, checkout, main, project, id: created.id, path: created.workingCopy.path };
  }

  it('makes its worktree again where it was, even with the worktree root changed since', async () => {
    const { main, id, path } = await archivedWorktreeSession();
    await main.api.invoke('settings.setWorktreeRoot', { worktreeRoot: tempDir('loom-other-root-') });

    await main.api.invoke('sessions.send', { id, prompt: 'One more thing' });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    expect(existsSync(path)).toBe(true);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.workingCopy.path).toBe(path);
  });

  it("is turned down when a folder that isn't its worktree is where its worktree was", async () => {
    const { main, id, path } = await archivedWorktreeSession();
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'unrelated.txt'), 'mine\n');

    await expect(main.api.invoke('sessions.send', { id, prompt: 'One more thing' })).rejects.toThrow(`${path} isn't this Session's worktree`);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'archived' });
    expect(readFileSync(join(path, 'unrelated.txt'), 'utf8')).toBe('mine\n');
  });

  it('goes straight from Archived to Working, never Waiting in between', async () => {
    const { main, id } = await archivedWorktreeSession();
    const seen: string[] = [];
    const stop = main.api.subscribe('sessions', (list) => {
      const status = list.find((s) => s.id === id)?.status;
      if (status && seen.at(-1) !== status) seen.push(status);
    });

    await main.api.invoke('sessions.send', { id, prompt: 'One more thing' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    stop();

    expect(seen).toEqual(['archived', 'working', 'waiting']);
  });

  it('takes a model pick and lists files for @-mentions before it is reopened', async () => {
    const { main, id } = await archivedWorktreeSession();

    await main.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-haiku-5-5' });

    expect(await main.api.invoke('sessions.files', { id })).toContain('README.md');
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'archived', model: 'anthropic/claude-haiku-5-5' });
  });

  it('is archived again, its worktree gone, when its Project is removed while it reopens', async () => {
    const { main, project, id, path } = await archivedWorktreeSession();

    const results = await Promise.allSettled([main.api.invoke('sessions.send', { id, prompt: 'One more thing' }), main.api.invoke('projects.remove', { id: project.id })]);

    expect(results[1]).toEqual({ status: 'fulfilled', value: { removed: true } });
    expect(await main.api.invoke('projects.list')).toEqual([]);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'archived' });
    expect(existsSync(path)).toBe(false);
  });
});
