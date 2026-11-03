import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, startMain, tempDir, tempMachine, waitFor, type Machine } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

/** A machine with a ready OpenCode, a Forge repository and the user's clone of it. */
function machineWithClone(defaultBranch = 'main'): { machine: Machine; origin: string; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [] } });
  const origin = machine.gitOrigin('billing-api', defaultBranch);
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

/** A commit pushed to `origin`'s `branch` by someone else, after the user cloned it. */
function pushedByOthers(machine: Machine, origin: string, branch = 'main'): string {
  const other = machine.gitClone(origin, `other-${Math.random().toString(36).slice(2)}`);
  const commit = machine.commit(other, 'CHANGELOG.md', 'Newer\n');
  git(other, 'push', '--quiet', 'origin', `HEAD:${branch}`);
  return commit;
}

describe('a worktree Session', () => {
  it("branches from a freshly fetched origin/<default>, whatever the checkout's state, under ~/loom/worktrees", async () => {
    const { machine, origin, checkout } = machineWithClone('trunk');
    const newest = pushedByOthers(machine, origin, 'trunk');
    // The user's checkout is behind, on another branch, with uncommitted work.
    git(checkout, 'switch', '--quiet', '-c', 'experiment');
    machine.commit(checkout, 'experiment.txt', 'local only\n');
    writeFileSync(join(checkout, 'README.md'), 'dirty\n');
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug!\nIt 500s.' });

    const path = `${machine.home}/loom/worktrees/billing-api/fix-the-login-bug`;
    expect(created).toMatchObject({ workingCopy: { kind: 'worktree', path }, branch: 'loom/fix-the-login-bug', status: 'working' });
    expect(git(path, 'rev-parse', 'HEAD')).toBe(newest);
    expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe('loom/fix-the-login-bug');
    expect(git(path, 'status', '--porcelain')).toBe('');
    // Not tracking origin/trunk, so a plain push never goes to the default branch.
    expect(() => git(path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
    // The checkout is left as it was.
    expect(git(checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('experiment');
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('dirty\n');

    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    expect(machine.acpMessages().filter((m) => m.message.method === 'session/new').map((m) => m.message.params?.cwd)).toEqual([path]);
  });

  it('takes the branch name the user edited, placing its folder by the name', async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', branch: ' feature/login ', prompt: 'Fix the login bug' });

    expect(created).toMatchObject({ branch: 'feature/login', workingCopy: { path: `${machine.home}/loom/worktrees/billing-api/feature-login` } });
    expect(git(created.workingCopy.path, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/login');
  });

  it('adds -2, -3, … to a name already taken locally, on origin, or by a folder', async () => {
    const { machine, checkout } = machineWithClone();
    git(checkout, 'branch', 'loom/fix-it');
    git(checkout, 'push', '--quiet', 'origin', 'HEAD:loom/fix-it-2');
    git(checkout, 'fetch', '--quiet', 'origin');
    git(checkout, 'branch', '-r', '-d', 'origin/loom/fix-it-2');
    mkdirSync(`${machine.home}/loom/worktrees/billing-api/fix-it-3`, { recursive: true });
    const { main, project } = await withProject(machine, checkout);

    const first = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix it' });
    const second = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix it' });

    expect([first, second].map((s) => [s.branch, s.workingCopy.path])).toEqual([
      ['loom/fix-it-4', `${machine.home}/loom/worktrees/billing-api/fix-it-4`],
      ['loom/fix-it-5', `${machine.home}/loom/worktrees/billing-api/fix-it-5`],
    ]);
  });

  it("rejects a branch name git wouldn't accept, making nothing", async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);

    await expect(main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', branch: 'bad..name', prompt: 'Go' })).rejects.toThrow(
      '"bad..name" can\'t be a branch name',
    );
    expect(await main.api.invoke('sessions.list')).toEqual([]);
    expect(existsSync(`${machine.home}/loom`)).toBe(false);
  });

  it('rejects when origin cannot be fetched', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [] } });
    const checkout = machine.gitRepo('billing-api');
    const { main, project } = await withProject(machine, checkout);

    await expect(main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Go' })).rejects.toThrow("Couldn't fetch origin");
    expect(await main.api.invoke('sessions.list')).toEqual([]);
  });

  it('gets copies of the files .worktreeinclude lists that git ignores', async () => {
    const { machine, checkout } = machineWithClone();
    writeFileSync(join(checkout, '.gitignore'), '.env*\nconfig/local/\nnode_modules/\n');
    writeFileSync(join(checkout, '.worktreeinclude'), '.env*\nconfig/local/\nnotes.txt\n');
    machine.commit(checkout, '.gitignore', readFileSync(join(checkout, '.gitignore'), 'utf8'));
    machine.commit(checkout, '.worktreeinclude', readFileSync(join(checkout, '.worktreeinclude'), 'utf8'));
    git(checkout, 'push', '--quiet', 'origin', 'HEAD:main');
    writeFileSync(join(checkout, '.env'), 'SECRET=1\n');
    writeFileSync(join(checkout, '.env.local'), 'LOCAL=1\n');
    mkdirSync(join(checkout, 'config', 'local'), { recursive: true });
    writeFileSync(join(checkout, 'config', 'local', 'db.json'), '{}');
    // Listed but not ignored: a real change, which the worktree must not get.
    writeFileSync(join(checkout, 'notes.txt'), 'draft\n');
    // Ignored but not listed.
    mkdirSync(join(checkout, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(checkout, 'node_modules', 'left-pad', 'index.js'), '');
    const { main, project } = await withProject(machine, checkout);

    const { workingCopy } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Go' });

    expect(readFileSync(join(workingCopy.path, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(readFileSync(join(workingCopy.path, '.env.local'), 'utf8')).toBe('LOCAL=1\n');
    expect(readFileSync(join(workingCopy.path, 'config', 'local', 'db.json'), 'utf8')).toBe('{}');
    expect(existsSync(join(workingCopy.path, 'notes.txt'))).toBe(false);
    expect(existsSync(join(workingCopy.path, 'node_modules'))).toBe(false);
    expect(git(workingCopy.path, 'status', '--porcelain')).toBe('');
  });

  it('goes under the worktree root setting, which is kept', async () => {
    const { machine, checkout } = machineWithClone();
    const userDataDir = tempDir('loom-worktrees-');
    const { main } = await withProject(machine, checkout, userDataDir);
    expect(await waitFor(main.api, 'settings', () => true)).toMatchObject({ worktreeRoot: '~/loom/worktrees' });
    const root = machine.folder('elsewhere');

    expect(await main.api.invoke('settings.setWorktreeRoot', { worktreeRoot: `${root}/` })).toMatchObject({ worktreeRoot: `${root}/` });
    await expect(main.api.invoke('settings.setWorktreeRoot', { worktreeRoot: 'relative/path' })).rejects.toThrow('must be an absolute path or start with ~');
    await main.close();

    const again = await startMain({ machine, userDataDir });
    await waitFor(again.api, 'environments', ready);
    expect(await waitFor(again.api, 'settings', () => true)).toMatchObject({ worktreeRoot: `${root}/` });
    const [project] = await again.api.invoke('projects.list');
    const created = await again.api.invoke('sessions.create', { projectId: project!.id, workingCopy: 'worktree', prompt: 'Go' });
    expect(created.workingCopy.path).toBe(`${root}/billing-api/go`);
  });
});

describe("a Session's branch", () => {
  it("follows the working copy's branch after each turn, and when main starts again", async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['ok'], hold: 'first' }, { chunks: ['ok'] }] } });
    const checkout = machine.gitRepo('billing-api');
    git(checkout, 'commit', '--quiet', '--allow-empty', '-m', 'init');
    git(checkout, 'switch', '--quiet', '-c', 'start');
    const userDataDir = tempDir('loom-branches-');
    const { main, project } = await withProject(machine, checkout, userDataDir);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.branch === 'start'));

    // The agent switches branch during its turn.
    git(checkout, 'switch', '--quiet', '-c', 'agent-made');
    machine.release('first');
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting' && s.branch === 'agent-made'));
    await main.close();

    git(checkout, 'switch', '--quiet', '--detach');
    git(checkout, 'switch', '--quiet', '-c', 'by-hand');
    const again = await startMain({ machine, userDataDir });
    expect((await again.api.invoke('sessions.list'))[0]?.branch).toBe('agent-made');
    await waitFor(again.api, 'sessions', session(created.id, (s) => s.branch === 'by-hand'));
  });

  it('is read again when its conversation is opened, after a switch by hand', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['ok'] }] } });
    const checkout = machine.gitRepo('billing-api');
    git(checkout, 'commit', '--quiet', '--allow-empty', '-m', 'init');
    git(checkout, 'switch', '--quiet', '-c', 'start');
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));

    git(checkout, 'switch', '--quiet', '-c', 'by-hand');
    main.api.subscribe('transcript', () => {}, { sessionId: created.id })();

    await waitFor(main.api, 'sessions', session(created.id, (s) => s.branch === 'by-hand'));
  });
});
