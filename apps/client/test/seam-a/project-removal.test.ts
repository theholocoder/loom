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
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done.'] }, { chunks: ['Done.'] }] } });
  const origin = machine.gitOrigin('billing-api');
  return { machine, origin, checkout: machine.gitClone(origin, 'billing-api') };
}

/** A machine with a ready OpenCode. */
function readyMachine(): Machine {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done.'] }] } });
  return machine;
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

describe('removing a Project', () => {
  it('forgets it, leaves its checkout on disk, and keeps its Sessions as archived history', async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));

    expect(await main.api.invoke('projects.remove', { id: project.id })).toEqual({ removed: true });

    expect(await main.api.invoke('projects.list')).toEqual([]);
    await waitFor(main.api, 'removedProjects', (removed) => removed.length === 1 && removed[0]!.id === project.id && removed[0]!.name === 'billing-api');
    expect(existsSync(join(checkout, '.git'))).toBe(true);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)).toMatchObject({ status: 'archived', projectId: project.id });
    await processEnded(machine.acpMessages()[0]!.pid);
  });

  it("holds back on a worktree's unsaved work, touching nothing, until told to discard it", async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    const path = created.workingCopy.path;
    writeFileSync(join(path, 'notes.txt'), 'half done\n');

    expect(await main.api.invoke('projects.remove', { id: project.id })).toEqual({
      removed: false,
      unsaved: [{ sessionId: created.id, title: created.title, unsavedWork: { uncommitted: true, unpushedCommits: 0, detached: false } }],
    });
    expect(await main.api.invoke('projects.list')).toHaveLength(1);
    expect(existsSync(join(path, 'notes.txt'))).toBe(true);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)).toMatchObject({ status: 'waiting' });

    expect(await main.api.invoke('projects.remove', { id: project.id, discard: true })).toEqual({ removed: true });
    expect(existsSync(path)).toBe(false);
    expect(git(checkout, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toContain('loom/fix-the-login-bug');
    expect(await main.api.invoke('projects.list')).toEqual([]);
  });

  it('leaves its archived Sessions with no diff to show, rather than an error', async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    await main.api.invoke('projects.remove', { id: project.id });

    expect(await main.api.invoke('sessions.diff', { id: created.id })).toEqual({ available: false, reason: 'No diff available' });
  });

  it('refuses a new Session on it while it is being removed', async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));

    const removing = main.api.invoke('projects.remove', { id: project.id });
    const late = main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'One more thing' });

    await expect(late).rejects.toThrow(/being removed|unknown Project/);
    expect(await removing).toEqual({ removed: true });
    expect((await main.api.invoke('sessions.list')).filter((s) => s.status !== 'archived')).toEqual([]);
  });

  it('stays removed when main starts again, its Sessions still archived', async () => {
    const { machine, checkout } = machineWithClone();
    const userDataDir = tempDir('loom-removal-');
    const first = await withProject(machine, checkout, userDataDir);
    const created = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(first.main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    await first.main.api.invoke('projects.remove', { id: first.project.id });
    await first.main.close();

    const second = await startMain({ machine, userDataDir });

    expect(await second.api.invoke('projects.list')).toEqual([]);
    await waitFor(second.api, 'removedProjects', (removed) => removed.some((p) => p.id === first.project.id && p.name === 'billing-api'));
    expect((await second.api.invoke('sessions.list')).find((s) => s.id === created.id)).toMatchObject({ status: 'archived' });
  });
});

describe('adding back a removed Project', () => {
  /** A checkout whose origin is on GitHub, though never fetched from. */
  function onGithub(machine: Machine, name: string): string {
    const checkout = machine.gitRepo(name);
    git(checkout, 'remote', 'add', 'origin', 'git@github.com:acme/billing-api.git');
    return checkout;
  }

  it('offers to restore it from another clone of the same repository, with its id, settings and Sessions', async () => {
    const machine = readyMachine();
    const checkout = onGithub(machine, 'billing-api');
    const { main, project } = await withProject(machine, checkout);
    await main.api.invoke('projects.setBranchPrefix', { id: project.id, branchPrefix: 'lb' });
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    await main.api.invoke('projects.remove', { id: project.id });
    const elsewhere = onGithub(machine, 'code/billing');
    git(elsewhere, 'remote', 'set-url', 'origin', 'https://github.com/acme/billing-api.git');

    expect(await main.api.invoke('projects.restorable', { path: elsewhere })).toEqual({ id: project.id, name: 'billing-api', sessions: 1 });
    const restored = await main.api.invoke('projects.link', { path: elsewhere, restore: project.id });

    expect(restored).toMatchObject({ id: project.id, name: 'billing-api', branchPrefix: 'lb', checkout: { environmentId: 'native', path: elsewhere } });
    expect(await main.api.invoke('projects.list')).toEqual([restored]);
    await waitFor(main.api, 'removedProjects', (removed) => removed.length === 0);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)).toMatchObject({ status: 'archived', projectId: project.id });
  });

  it('starts a new Project instead when not told to restore', async () => {
    const machine = readyMachine();
    const checkout = onGithub(machine, 'billing-api');
    const { main, project } = await withProject(machine, checkout);
    await main.api.invoke('projects.remove', { id: project.id });

    const fresh = await main.api.invoke('projects.link', { path: checkout });

    expect(fresh.id).not.toBe(project.id);
    expect(fresh.branchPrefix).toBe('loom');
    await waitFor(main.api, 'removedProjects', (removed) => removed.length === 1 && removed[0]!.id === project.id);
  });

  it('matches a checkout with no network origin by where it is', async () => {
    const machine = readyMachine();
    const checkout = machine.gitRepo('notes');
    const other = machine.gitRepo('other-notes');
    const { main, project } = await withProject(machine, checkout);
    await main.api.invoke('projects.remove', { id: project.id });

    expect(await main.api.invoke('projects.restorable', { path: other })).toBeNull();
    expect(await main.api.invoke('projects.restorable', { path: checkout })).toEqual({ id: project.id, name: 'notes', sessions: 0 });
    await expect(main.api.invoke('projects.link', { path: other, restore: project.id })).rejects.toThrow(/can't restore that Project/);
  });

  it('offers the one removed last when several match', async () => {
    const machine = readyMachine();
    const first = onGithub(machine, 'billing-api');
    const second = onGithub(machine, 'billing-api-2');
    const { main, project } = await withProject(machine, first);
    const other = await main.api.invoke('projects.link', { path: second });
    await main.api.invoke('projects.remove', { id: project.id });
    main.clock.advance(1000);
    await main.api.invoke('projects.remove', { id: other.id });

    expect(await main.api.invoke('projects.restorable', { path: first })).toMatchObject({ id: other.id });
  });
});
