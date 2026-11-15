import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, processEnded, startMain, tempDir, tempMachine, waitFor, type Machine } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

/** A machine with a ready OpenCode, a Forge repository and the user's clone of it. */
function machineWithClone(): { machine: Machine; origin: string; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done.'] }, { chunks: ['Again.'] }] } });
  const origin = machine.gitOrigin('billing-api');
  return { machine, origin, checkout: machine.gitClone(origin, 'billing-api') };
}

async function withProject(machine: Machine, checkout: string, userDataDir?: string) {
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

const bytes = (text: string) => new TextEncoder().encode(text);
const branches = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');

describe('deleting a Session', () => {
  it('forgets a worktree Session for good, removes its worktree, keeps its branch and stops its agent', async () => {
    const { machine, checkout } = machineWithClone();
    const userDataDir = tempDir('loom-delete-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    const path = created.workingCopy.path;

    expect(await main.api.invoke('sessions.delete', { id: created.id })).toEqual({ deleted: true });

    expect((await main.api.invoke('sessions.list')).map((s) => s.id)).not.toContain(created.id);
    expect(existsSync(path)).toBe(false);
    expect(git(checkout, 'worktree', 'list', '--porcelain')).not.toContain(path);
    expect(branches(checkout)).toContain('loom/fix-the-login-bug');
    await processEnded(machine.acpMessages()[0]!.pid);

    // Gone from the database too: a restart doesn't bring it back.
    await main.close();
    const again = await startMain({ machine, userDataDir });
    expect((await again.api.invoke('sessions.list')).map((s) => s.id)).not.toContain(created.id);
  });

  it("holds back on a worktree's unsaved work, touching nothing, until told to discard it", async () => {
    const { checkout, machine } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    const path = created.workingCopy.path;
    writeFileSync(join(path, 'notes.txt'), 'half done\n');

    expect(await main.api.invoke('sessions.delete', { id: created.id })).toEqual({ deleted: false, unsavedWork: { uncommitted: true, unpushedCommits: 0, detached: false } });
    expect(existsSync(join(path, 'notes.txt'))).toBe(true);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)).toMatchObject({ status: 'waiting' });

    expect(await main.api.invoke('sessions.delete', { id: created.id, discard: true })).toEqual({ deleted: true });
    expect(existsSync(path)).toBe(false);
    expect((await main.api.invoke('sessions.list')).map((s) => s.id)).not.toContain(created.id);
  });

  it("says what unsaved work a worktree has before it is deleted, touching nothing, and none for a clean one or a checkout's", async () => {
    const { checkout, machine } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    expect(await main.api.invoke('sessions.unsavedWork', { id: created.id })).toBeNull();

    writeFileSync(join(created.workingCopy.path, 'notes.txt'), 'half done\n');
    expect(await main.api.invoke('sessions.unsavedWork', { id: created.id })).toEqual({ uncommitted: true, unpushedCommits: 0, detached: false });
    expect(existsSync(join(created.workingCopy.path, 'notes.txt'))).toBe(true);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)).toMatchObject({ status: 'waiting' });

    writeFileSync(join(checkout, 'README.md'), 'dirty\n');
    const inCheckout = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Look around' });
    expect(await main.api.invoke('sessions.unsavedWork', { id: inCheckout.id })).toBeNull();
  });

  it('deletes an archived Session, which then has nothing to reopen', async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    expect(await main.api.invoke('sessions.archive', { id: created.id })).toEqual({ archived: true });

    expect(await main.api.invoke('sessions.delete', { id: created.id })).toEqual({ deleted: true });

    expect((await main.api.invoke('sessions.list')).map((s) => s.id)).not.toContain(created.id);
    await expect(main.api.invoke('sessions.send', { id: created.id, prompt: 'More' })).rejects.toThrow(`unknown Session ${created.id}`);
    expect(branches(checkout)).toContain('loom/fix-the-login-bug');
  });

  it("leaves a checkout Session's checkout as it is, and removes its attachments", async () => {
    const { machine, checkout } = machineWithClone();
    const userDataDir = tempDir('loom-delete-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    writeFileSync(join(checkout, 'README.md'), 'dirty\n');
    const created = await main.api.invoke('sessions.create', {
      projectId: project.id,
      workingCopy: 'checkout',
      prompt: 'Why does this time out?',
      attachments: [{ name: 'config.yaml', data: bytes('timeout: 5\n') }],
    });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    expect(existsSync(join(userDataDir, 'attachments', String(created.id)))).toBe(true);

    expect(await main.api.invoke('sessions.delete', { id: created.id })).toEqual({ deleted: true });

    expect((await main.api.invoke('sessions.list')).map((s) => s.id)).not.toContain(created.id);
    expect(existsSync(join(checkout, '.git'))).toBe(true);
    expect(git(checkout, 'status', '--porcelain')).toContain('README.md');
    expect(existsSync(join(userDataDir, 'attachments', String(created.id)))).toBe(false);
    await processEnded(machine.acpMessages()[0]!.pid);
  });

  it('deletes a Working Session, stopping its agent mid-run', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Thinking'], hold: 'run' }] } });
    const checkout = machine.gitClone(machine.gitOrigin('billing-api'), 'billing-api');
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: created.id });

    expect(await main.api.invoke('sessions.delete', { id: created.id })).toEqual({ deleted: true });

    expect((await main.api.invoke('sessions.list')).map((s) => s.id)).not.toContain(created.id);
    expect(existsSync(created.workingCopy.path)).toBe(false);
    await processEnded(machine.acpMessages()[0]!.pid);
  });
});
