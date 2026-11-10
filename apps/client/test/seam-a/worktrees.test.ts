import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, processEnded, startMain, tempDir, tempMachine, waitFor, type Machine } from './harness';
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

describe('the branches a worktree Session can start from', () => {
  it("fetches origin, then lists all origin's branches as bases, the branches git can still check out, and the other worktrees", async () => {
    const { machine, origin, checkout } = machineWithClone('trunk');
    pushedByOthers(machine, origin, 'release/1.2');
    pushedByOthers(machine, origin, 'shared');
    // The checkout stays on trunk: neither it nor origin/trunk can be checked out again, but origin/trunk is still a base.
    // On origin too: offered once, as the local branch a checkout would reuse.
    git(checkout, 'branch', 'mine');
    git(checkout, 'push', '--quiet', 'origin', 'mine');
    git(checkout, 'branch', 'busy');
    git(checkout, 'push', '--quiet', 'origin', 'busy');
    // Checked out in another worktree.
    const busyWorktree = machine.folder('busy-wt');
    git(checkout, 'worktree', 'add', '--quiet', busyWorktree, 'busy');
    const elsewhere = machine.folder('elsewhere-wt');
    git(checkout, 'worktree', 'add', '--quiet', '-b', 'elsewhere', elsewhere);
    const detached = machine.folder('detached-wt');
    git(checkout, 'worktree', 'add', '--quiet', '--detach', detached);
    // Locked: git won't remove it, so archiving would fail.
    git(checkout, 'worktree', 'add', '--quiet', '--lock', '-b', 'locked', machine.folder('locked-wt'));
    const { main, project } = await withProject(machine, checkout);

    expect(await main.api.invoke('projects.branches', { id: project.id })).toEqual({
      defaultBranch: 'trunk',
      remote: ['busy', 'mine', 'release/1.2', 'shared', 'trunk'],
      existing: [
        { name: 'mine', remote: false },
        { name: 'release/1.2', remote: true },
        { name: 'shared', remote: true },
      ],
      worktrees: [{ path: busyWorktree, branch: 'busy' }, { path: detached }, { path: elsewhere, branch: 'elsewhere' }],
    });
  });

  it("leaves out the worktrees of Sessions that aren't archived", async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix it' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));

    expect((await main.api.invoke('projects.branches', { id: project.id })).worktrees).toEqual([]);
  });

  it('leaves out the main checkout for a Project linked from one of its worktrees', async () => {
    const { machine, checkout } = machineWithClone();
    const linked = machine.folder('linked-wt');
    git(checkout, 'worktree', 'add', '--quiet', '-b', 'linked', linked);
    const other = machine.folder('other-wt');
    git(checkout, 'worktree', 'add', '--quiet', '-b', 'other', other);
    const { main, project } = await withProject(machine, linked);

    expect((await main.api.invoke('projects.branches', { id: project.id })).worktrees).toEqual([{ path: other, branch: 'other' }]);
  });
});

describe('a worktree Session on an existing branch', () => {
  it("checks out an origin branch as-is, on a new same-named local branch tracking it, with .worktreeinclude's files", async () => {
    const { machine, origin, checkout } = machineWithClone();
    const tip = pushedByOthers(machine, origin, 'feature/login');
    writeFileSync(join(checkout, '.worktreeinclude'), '.env\n');
    writeFileSync(join(checkout, '.gitignore'), '.env\n.worktreeinclude\n.gitignore\n');
    writeFileSync(join(checkout, '.env'), 'SECRET=1\n');
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { branch: { name: 'feature/login', remote: true } }, prompt: 'Carry on' });

    const path = `${machine.home}/loom/worktrees/billing-api/feature-login`;
    expect(created).toMatchObject({ workingCopy: { kind: 'worktree', path }, branch: 'feature/login', status: 'working' });
    expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/login');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/login');
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n');
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
  });

  it('reuses the local namesake of an origin branch as it is, ahead of origin', async () => {
    const { machine, origin, checkout } = machineWithClone();
    pushedByOthers(machine, origin, 'feature/login');
    git(checkout, 'fetch', '--quiet', 'origin');
    git(checkout, 'branch', '--quiet', '--track', 'feature/login', 'origin/feature/login');
    git(checkout, 'switch', '--quiet', 'feature/login');
    const local = machine.commit(checkout, 'local.txt', 'mine\n');
    git(checkout, 'switch', '--quiet', 'main');
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { branch: { name: 'feature/login', remote: true } }, prompt: 'Carry on' });

    expect(created.branch).toBe('feature/login');
    expect(git(created.workingCopy.path, 'rev-parse', 'HEAD')).toBe(local);
  });

  it('checks out a local branch as it is, in a free folder, and archiving keeps it', async () => {
    const { machine, checkout } = machineWithClone();
    git(checkout, 'switch', '--quiet', '-c', 'loom/spike');
    const tip = machine.commit(checkout, 'spike.txt', 'spike\n');
    git(checkout, 'switch', '--quiet', 'main');
    mkdirSync(`${machine.home}/loom/worktrees/billing-api/spike`, { recursive: true });
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { branch: { name: 'loom/spike', remote: false } }, prompt: 'Carry on' });

    expect(created).toMatchObject({ branch: 'loom/spike', workingCopy: { kind: 'worktree', path: `${machine.home}/loom/worktrees/billing-api/spike-2` } });
    expect(git(created.workingCopy.path, 'rev-parse', 'HEAD')).toBe(tip);
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));

    expect(await main.api.invoke('sessions.archive', { id: created.id, discard: true })).toEqual({ archived: true });
    expect(existsSync(created.workingCopy.path)).toBe(false);
    expect(git(checkout, 'rev-parse', 'refs/heads/loom/spike')).toBe(tip);
  });

  it('links an issue without renaming the branch', async () => {
    const { machine, origin, checkout } = machineWithClone();
    pushedByOthers(machine, origin, 'feature/login');
    const { main, project } = await withProject(machine, checkout);
    const issue = { number: 31, title: 'Login 500s', url: 'https://github.com/acme/billing-api/issues/31', body: '' };

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { branch: { name: 'feature/login', remote: true } }, issue, prompt: '' });

    expect(created).toMatchObject({ branch: 'feature/login', issue: { number: 31, url: issue.url } });
  });

  it('rejects a branch that is missing, or checked out elsewhere, making nothing', async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const create = (branch: { name: string; remote: boolean }) => main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { branch }, prompt: 'Go' });

    await expect(create({ name: 'nope', remote: true })).rejects.toThrow('origin has no branch "nope"');
    await expect(create({ name: 'nope', remote: false })).rejects.toThrow('There\'s no local branch "nope"');
    await expect(create({ name: 'main', remote: false })).rejects.toThrow(`"main" is checked out in ${checkout}; work there instead`);
    await expect(create({ name: 'main', remote: true })).rejects.toThrow(`"main" is checked out in ${checkout}; work there instead`);
    await expect(main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { branch: { name: 'main', remote: true } }, branch: 'x', prompt: 'Go' })).rejects.toThrow(
      "doesn't name or base a new one",
    );
    expect(await main.api.invoke('sessions.list')).toEqual([]);
    expect(existsSync(`${machine.home}/loom/worktrees/billing-api`) ? readdirSync(`${machine.home}/loom/worktrees/billing-api`) : []).toEqual([]);
  });
});

describe('a worktree Session in an existing worktree', () => {
  it('works in the worktree as it is, on its branch, and archiving removes it like any worktree', async () => {
    const { machine, checkout } = machineWithClone();
    const path = machine.folder('by-hand');
    git(checkout, 'worktree', 'add', '--quiet', '-b', 'feat/49-cards', path);
    const tip = machine.commit(path, 'cards.txt', 'wip\n');
    writeFileSync(join(path, 'scratch.txt'), 'mine\n');
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { worktree: path }, prompt: 'Carry on' });

    expect(created).toMatchObject({ workingCopy: { kind: 'worktree', path }, branch: 'feat/49-cards' });
    expect(git(path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(readFileSync(join(path, 'scratch.txt'), 'utf8')).toBe('mine\n');
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    expect(machine.acpMessages().filter((m) => m.message.method === 'session/new').map((m) => m.message.params?.cwd)).toEqual([path]);

    expect(await main.api.invoke('sessions.archive', { id: created.id })).toMatchObject({ archived: false, unsavedWork: { uncommitted: true } });
    expect(await main.api.invoke('sessions.archive', { id: created.id, discard: true })).toEqual({ archived: true });
    expect(existsSync(path)).toBe(false);
    expect(git(checkout, 'rev-parse', 'refs/heads/feat/49-cards')).toBe(tip);
  });

  it("rejects a folder that isn't one of the checkout's other worktrees, making nothing", async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const create = (worktree: string) => main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { worktree }, prompt: 'Go' });

    await expect(create(machine.folder('not-a-worktree'))).rejects.toThrow("isn't a worktree of billing-api");
    await expect(create(checkout)).rejects.toThrow("isn't a worktree of billing-api");
    const locked = machine.folder('locked-wt');
    git(checkout, 'worktree', 'add', '--quiet', '--lock', '-b', 'locked', locked);
    await expect(create(locked)).rejects.toThrow(`${locked} is locked; unlock it with \`git worktree unlock\` to work in it`);
    await expect(main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { worktree: checkout }, base: 'main', prompt: 'Go' })).rejects.toThrow(
      "doesn't name or base a new one",
    );
    expect(await main.api.invoke('sessions.list')).toEqual([]);
  });
});

describe('a worktree Session in a worktree another Session works in', () => {
  it("is refused while that Session isn't archived", async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);
    const first = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix it' });
    await waitFor(main.api, 'sessions', session(first.id, (s) => s.status === 'waiting'));

    await expect(main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { worktree: first.workingCopy.path }, prompt: 'Go' })).rejects.toThrow(
      `The Session "Fix it" works in ${first.workingCopy.path}`,
    );
    expect((await main.api.invoke('sessions.list')).map((s) => s.id)).toEqual([first.id]);
  });
});

describe('a worktree Session branching from another base', () => {
  it('branches from the freshly fetched origin branch chosen, and diffs against it', async () => {
    const { machine, origin, checkout } = machineWithClone();
    const tip = pushedByOthers(machine, origin, 'release/1.2');
    pushedByOthers(machine, origin, 'main');
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', base: 'release/1.2', prompt: 'Backport the fix' });

    expect(created.branch).toBe('loom/backport-the-fix');
    expect(git(created.workingCopy.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(() => git(created.workingCopy.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    expect(await main.api.invoke('sessions.diff', { id: created.id })).toMatchObject({ available: true, base: 'origin/release/1.2', files: [] });
  });

  it('rejects a base origin does not have, making nothing', async () => {
    const { machine, checkout } = machineWithClone();
    const { main, project } = await withProject(machine, checkout);

    await expect(main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', base: 'nope', prompt: 'Go' })).rejects.toThrow('origin has no branch "nope"');
    expect(await main.api.invoke('sessions.list')).toEqual([]);
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

describe('archiving a worktree Session', () => {
  /** A Waiting worktree Session, its agent done. */
  async function worktreeSession() {
    const { machine, origin, checkout } = machineWithClone();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done.'] }, { chunks: ['Again.'] }] } });
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    return { machine, origin, checkout, main, id: created.id, path: created.workingCopy.path };
  }

  const branches = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
  const remoteRefs = (origin: string) => git(origin, 'for-each-ref', '--format=%(refname) %(objectname)');

  it('removes a clean worktree, keeps its local branch, stops its agent and leaves the remote alone', async () => {
    const { machine, origin, checkout, main, id, path } = await worktreeSession();
    const before = remoteRefs(origin);

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: true });

    expect(existsSync(path)).toBe(false);
    expect(git(checkout, 'worktree', 'list', '--porcelain')).not.toContain(path);
    expect(branches(checkout)).toContain('loom/fix-the-login-bug');
    expect(remoteRefs(origin)).toBe(before);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'archived' });
    await processEnded(machine.acpMessages()[0]!.pid);
  });

  it('holds back on uncommitted changes, touching nothing, until told to discard them', async () => {
    const { machine, checkout, main, id, path } = await worktreeSession();
    writeFileSync(join(path, 'README.md'), 'half done\n');
    writeFileSync(join(path, 'notes.txt'), 'untracked\n');

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: false, unsavedWork: { uncommitted: true, unpushedCommits: 0, detached: false } });
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('half done\n');
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'waiting' });
    await main.api.invoke('sessions.send', { id, prompt: 'Keep going' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    expect(await main.api.invoke('sessions.archive', { id, discard: true })).toEqual({ archived: true });
    expect(existsSync(path)).toBe(false);
    expect(branches(checkout)).toContain('loom/fix-the-login-bug');
    await processEnded(machine.acpMessages()[0]!.pid);
  });

  it('holds back on commits on no remote branch, and keeps them on the local branch once discarded', async () => {
    const { machine, origin, checkout, main, id, path } = await worktreeSession();
    const before = remoteRefs(origin);
    const commit = machine.commit(path, 'fix.txt', 'fixed\n');

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: false, unsavedWork: { uncommitted: false, unpushedCommits: 1, detached: false } });
    expect(await main.api.invoke('sessions.archive', { id, discard: true })).toEqual({ archived: true });

    expect(existsSync(path)).toBe(false);
    expect(git(checkout, 'rev-parse', 'loom/fix-the-login-bug')).toBe(commit);
    expect(remoteRefs(origin)).toBe(before);
  });

  it('archives a pushed branch without asking', async () => {
    const { machine, main, id, path } = await worktreeSession();
    machine.commit(path, 'fix.txt', 'fixed\n');
    git(path, 'push', '--quiet', 'origin', 'HEAD');

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: true });
    expect(existsSync(path)).toBe(false);
  });

  it('flags a worktree deleted outside Loom as missing, which can only be archived', async () => {
    // Windows can't delete a process's cwd, so remove the worktree while no Loom process (and no agent) holds it.
    const { machine, checkout } = machineWithClone();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done.'] }] } });
    const userDataDir = tempDir('loom-archive-');
    const first = await withProject(machine, checkout, userDataDir);
    const created = await first.main.api.invoke('sessions.create', { projectId: first.project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(first.main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    const { id, path } = { id: created.id, path: created.workingCopy.path };
    await first.main.close();
    rmSync(path, { recursive: true, force: true });
    const main = await startMain({ machine, userDataDir });

    main.api.subscribe('transcript', () => {}, { sessionId: id })();
    await waitFor(main.api, 'sessions', session(id, (s) => s.worktreeMissing === true));
    await expect(main.api.invoke('sessions.send', { id, prompt: 'More' })).rejects.toThrow("This Session's worktree is missing; it can only be archived.");

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: true });
    const archived = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    expect(archived.status).toBe('archived');
    expect(archived.worktreeMissing).toBeUndefined();
    expect(git(checkout, 'worktree', 'list', '--porcelain')).not.toContain(path);
    expect(branches(checkout)).toContain('loom/fix-the-login-bug');
  });

  it('flags a worktree deleted outside Loom as missing when asked to check', async () => {
    const { machine, checkout } = machineWithClone();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done.'] }] } });
    const userDataDir = tempDir('loom-archive-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix it' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    // Started again so no agent holds the worktree (Windows can't delete a process's cwd).
    await main.close();
    const again = await startMain({ machine, userDataDir });
    await waitFor(again.api, 'environments', ready);
    await again.api.invoke('sessions.check');
    expect((await again.api.invoke('sessions.list')).find((s) => s.id === created.id)?.worktreeMissing).toBeFalsy();
    rmSync(created.workingCopy.path, { recursive: true, force: true });

    await again.api.invoke('sessions.check');

    await waitFor(again.api, 'sessions', session(created.id, (s) => s.worktreeMissing === true));
  });

  it('flags a missing worktree when Loom starts again', async () => {
    const { machine, checkout } = machineWithClone();
    const userDataDir = tempDir('loom-archive-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix it' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    await main.close();
    rmSync(created.workingCopy.path, { recursive: true, force: true });

    const again = await startMain({ machine, userDataDir });

    await waitFor(again.api, 'sessions', session(created.id, (s) => s.worktreeMissing === true));
  });
});

describe('archiving a worktree Session whose agent is working', () => {
  async function workingSession() {
    const { machine, checkout } = machineWithClone();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['On it.'], hold: 'run' }] } });
    const { main, project } = await withProject(machine, checkout);
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'working'));
    // The agent is running once it has received its 3 messages: initialize, session/new, prompt.
    const deadline = Date.now() + 5000;
    while (machine.acpMessages().length < 3) {
      if (Date.now() > deadline) throw new Error('the agent never received its prompt');
      await new Promise((r) => setTimeout(r, 20));
    }
    return { machine, checkout, main, id: created.id, path: created.workingCopy.path };
  }
  const statusOf = async (main: Awaited<ReturnType<typeof workingSession>>['main'], id: number) =>
    (await main.api.invoke('sessions.list')).find((s) => s.id === id)!.status;

  it('stops the agent and removes the worktree', async () => {
    const { machine, checkout, main, id, path } = await workingSession();

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: true });

    expect(existsSync(path)).toBe(false);
    expect(await statusOf(main, id)).toBe('archived');
    expect(git(checkout, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toContain('loom/fix-the-login-bug');
    await processEnded(machine.acpMessages()[0]!.pid);
  });

  it('is not archived while its worktree is still on disk, and archiving again retries', async () => {
    const { machine, checkout, main, id, path } = await workingSession();
    git(checkout, 'worktree', 'lock', path);

    await expect(main.api.invoke('sessions.archive', { id })).rejects.toThrow(/still there/);
    expect(existsSync(path)).toBe(true);
    expect(await statusOf(main, id)).not.toBe('archived');
    await processEnded(machine.acpMessages()[0]!.pid);

    git(checkout, 'worktree', 'unlock', path);
    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: true });
    expect(existsSync(path)).toBe(false);
    expect(await statusOf(main, id)).toBe('archived');
  });

  it('archiving an archived Session again resolves and changes nothing', async () => {
    const { main, id } = await workingSession();
    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: true });
    const before = await waitFor(main.api, 'transcript', () => true, { sessionId: id });

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: true });
    expect(await waitFor(main.api, 'transcript', () => true, { sessionId: id })).toEqual(before);
    expect(await statusOf(main, id)).toBe('archived');
  });

  it('archiving an archived Session again resolves when its Environment is disconnected', async () => {
    const { main, id } = await workingSession();
    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: true });
    main.bridge().kill();
    await waitFor(main.api, 'environments', (e) => e[0]?.state === 'disconnected');

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: true });
    expect(await statusOf(main, id)).toBe('archived');
  });

  it('holds back on work the stopped agent left, without archiving', async () => {
    const { main, id, path } = await workingSession();
    writeFileSync(join(path, 'README.md'), 'half done\n');

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: false, unsavedWork: { uncommitted: true, unpushedCommits: 0, detached: false } });
    expect(existsSync(path)).toBe(true);
    // Cancel keeps the agent: the Session is still working, with its run going.
    expect(await statusOf(main, id)).toBe('working');
    await main.api.invoke('sessions.send', { id, prompt: 'more' });
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)?.queue?.map((m) => m.text)).toEqual(['more']);
    expect(await main.api.invoke('sessions.archive', { id, discard: true })).toEqual({ archived: true });
    expect(existsSync(path)).toBe(false);
  });

  it('leaves an agent that is still starting alone when the archive is held back', async () => {
    const { machine, checkout } = machineWithClone();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['On it.'], hold: 'run' }], holdNew: 'start' } });
    const { main, project } = await withProject(machine, checkout);
    const { id, workingCopy } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Fix the login bug' });
    const deadline = Date.now() + 5000;
    while (!machine.acpMessages().some((m) => m.message.method === 'session/new')) {
      if (Date.now() > deadline) throw new Error('the agent was never asked for a session');
      await new Promise((r) => setTimeout(r, 20));
    }
    writeFileSync(join(workingCopy.path, 'README.md'), 'half done\n');
    // The agent finishes starting while the archive looks for unsaved work: git status runs
    // the fsmonitor hook, which lets the agent go on, then gives it a moment before git carries on.
    const hook = join(tempDir('loom-fsmonitor-'), 'fsmonitor.mjs');
    writeFileSync(hook, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(machine.releaseFile('start'))}, '');\nsetTimeout(() => {}, 1000);\n`);
    git(workingCopy.path, 'config', 'core.fsmonitor', `"${process.execPath.replaceAll('\\', '/')}" "${hook.replaceAll('\\', '/')}"`);

    // The archive is held back while the agent is still starting; once started, it carries on.
    const archiving = main.api.invoke('sessions.archive', { id });
    expect(await archiving).toMatchObject({ archived: false, unsavedWork: { uncommitted: true } });
    // Where git couldn't run the hook, the agent starts now, after the archive.
    machine.release('start');
    const prompted = Date.now() + 5000;
    while (!machine.acpMessages().some((m) => m.message.method === 'session/prompt')) {
      if (Date.now() > prompted) throw new Error('the agent never got its prompt');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'working' });
    machine.release('run');
    await waitFor(main.api, 'sessions', (list) => list.some((s) => s.id === id && s.status === 'waiting' && s.waitingReason === 'finished'));
  });

  it('flags commits on a detached HEAD as lost with the worktree', async () => {
    const { machine, main, id, path } = await workingSession();
    git(path, 'checkout', '--detach');
    machine.commit(path, 'fix.txt', 'fixed\n');

    expect(await main.api.invoke('sessions.archive', { id })).toEqual({ archived: false, unsavedWork: { uncommitted: false, unpushedCommits: 1, detached: true } });
  });
});
