import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, startMain, tempMachine, waitFor } from './harness';
import type { DiffFile, DiffSummary, EnvironmentStatus, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];
const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

async function started(workingCopy: 'worktree' | 'checkout' = 'worktree', turns = 1, defaultBranch = 'main', maxUntrackedCounted?: number) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: Array.from({ length: turns }, () => ({ chunks: ['Done.'] })) } });
  const origin = machine.gitOrigin('billing-api', defaultBranch);
  const checkout = machine.gitClone(origin, 'billing-api');
  git(checkout, 'config', 'core.autocrlf', 'false');
  machine.commit(checkout, 'app.js', 'one\ntwo\nthree\n');
  git(checkout, 'push', '--quiet', 'origin', `HEAD:${defaultBranch}`);
  git(checkout, 'fetch', '--quiet', 'origin');
  const main = await startMain({ machine, maxUntrackedCounted });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy, prompt: 'Fix it' });
  await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
  const path = created.workingCopy.path;
  git(path, 'config', 'core.autocrlf', 'false');
  return { machine, origin, checkout, main, id: created.id, path };
}

function files(summary: DiffSummary): Partial<DiffFile>[] {
  if (!summary.available) throw new Error(summary.reason);
  return summary.files.map(({ path, oldPath, status, added, removed, binary }) => ({ path, ...(oldPath ? { oldPath } : {}), status, added, removed, binary }));
}

describe("a Session's diff", () => {
  it('shows committed, modified and untracked files against the merge-base with origin/<default>, never ignored ones, and never fetches', async () => {
    const { machine, origin, checkout, main, id, path } = await started();
    machine.commit(path, 'committed file.txt', 'a\nb\n');
    machine.commit(path, 'app.js', 'one\n2\nthree\n');
    writeFileSync(join(path, 'app.js'), 'one\n2\nthree\nfour\n');
    git(path, 'mv', 'README.md', 'READ ME.md');
    git(path, 'commit', '--quiet', '-m', 'Rename');
    writeFileSync(join(path, '.gitignore'), 'build/\n');
    mkdirSync(join(path, 'build'));
    writeFileSync(join(path, 'build', 'out.js'), 'ignored\n');
    writeFileSync(join(path, 'new file.txt'), 'x\ny\nz\n');
    writeFileSync(join(path, 'logo.png'), Buffer.from([0, 1, 2, 0, 255]));
    // The base moves on after branching; its changes aren't the Session's.
    const other = machine.gitClone(origin, 'other');
    machine.commit(other, 'CHANGELOG.md', 'Newer\n');
    git(other, 'push', '--quiet', 'origin', 'HEAD:main');
    git(checkout, 'fetch', '--quiet', 'origin');
    // Nothing is fetched: origin can't be reached any more.
    git(checkout, 'remote', 'set-url', 'origin', join(machine.dir, 'nowhere.git'));

    const summary = await main.api.invoke('sessions.diff', { id });

    expect(summary).toMatchObject({ available: true, readOnly: false, base: 'origin/main' });
    expect(files(summary)).toEqual([
      { path: '.gitignore', status: 'untracked', added: 1, removed: 0, binary: false },
      { path: 'READ ME.md', oldPath: 'README.md', status: 'committed', added: 0, removed: 0, binary: false },
      { path: 'app.js', status: 'modified', added: 2, removed: 1, binary: false },
      { path: 'committed file.txt', status: 'committed', added: 2, removed: 0, binary: false },
      { path: 'logo.png', status: 'untracked', added: 0, removed: 0, binary: true },
      { path: 'new file.txt', status: 'untracked', added: 3, removed: 0, binary: false },
    ]);

    const uncommitted = await main.api.invoke('sessions.diff', { id, uncommittedOnly: true });
    expect(files(uncommitted).map((f) => [f.path, f.status])).toEqual([
      ['.gitignore', 'untracked'],
      ['app.js', 'modified'],
      ['logo.png', 'untracked'],
      ['new file.txt', 'untracked'],
    ]);

    const byPath = (s: DiffSummary, p: string) => (s.available ? s.files.find((f) => f.path === p)! : undefined!);
    const app = await main.api.invoke('sessions.diffFile', { id, path: 'app.js' });
    expect(app.text).toContain('-two\n+2\n');
    expect(app.text).toContain('+four\n');
    const appUncommitted = await main.api.invoke('sessions.diffFile', { id, path: 'app.js', uncommittedOnly: true });
    expect(appUncommitted.text).not.toContain('-two');
    expect(appUncommitted.text).toContain('+four\n');
    const added = await main.api.invoke('sessions.diffFile', { id, path: 'new file.txt' });
    expect(added.text).toContain('+x\n+y\n+z\n');
    const renamed = await main.api.invoke('sessions.diffFile', { id, path: 'READ ME.md' });
    expect(renamed.text).toContain('rename to READ ME.md');
    expect(await main.api.invoke('sessions.diffFile', { id, path: 'logo.png' })).toEqual({ text: '', truncated: false });

    // Working out the diff updates the Session header changes control: 6 files, untracked ones' lines as additions.
    await waitFor(main.api, 'sessions', session(id, (s) => s.diffStat?.files === 6 && s.diffStat.added === 1 + 2 + 2 + 3 && s.diffStat.removed === 1));
    expect(git(checkout, 'log', '--oneline', 'origin/main').split('\n')).toHaveLength(3);
  });

  it('shows the Session header changes control from git diff --shortstat at the end of each turn', async () => {
    const { machine, main, id, path } = await started('worktree', 2);
    machine.commit(path, 'a.txt', 'a\nb\n');
    writeFileSync(join(path, 'b.txt'), 'c\n');

    await main.api.invoke('sessions.send', { id, prompt: 'More' });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.diffStat?.files === 2 && s.diffStat.added === 3 && s.diffStat.removed === 0));
  });

  it("refuses paths the diff doesn't list, so no file outside it is read", async () => {
    const { main, id, path } = await started();
    writeFileSync(join(path, '..', 'outside.txt'), 'secret\n');
    writeFileSync(join(path, 'inside.txt'), 'ok\n');
    await main.api.invoke('sessions.diff', { id });

    await expect(main.api.invoke('sessions.diffFile', { id, path: '../outside.txt' })).rejects.toThrow(/isn't in this diff/);
    await expect(main.api.invoke('sessions.diffFile', { id, path: join(path, '..', 'outside.txt') })).rejects.toThrow(/isn't in this diff/);
    await expect(main.api.invoke('sessions.diffFile', { id, path: '*.txt' })).rejects.toThrow(/isn't in this diff/);
    expect((await main.api.invoke('sessions.diffFile', { id, path: 'inside.txt' })).text).toContain('+ok');
  });

  it("doesn't read big untracked files, and says so for those past the counting limit", async () => {
    const { main, id, path } = await started('worktree', 1, 'main', 3);
    writeFileSync(join(path, 'big.log'), Buffer.alloc(1024 * 1024 + 10, 'a\n'));
    mkdirSync(join(path, 'many'));
    for (let i = 0; i < 5; i++) writeFileSync(join(path, 'many', `f${String(i).padStart(3, '0')}.txt`), 'x\n');

    const summary = await main.api.invoke('sessions.diff', { id });
    if (!summary.available) throw new Error(summary.reason);
    expect(summary.files.find((f) => f.path === 'big.log')).toMatchObject({ binary: true });
    expect(await main.api.invoke('sessions.diffFile', { id, path: 'big.log' })).toEqual({ text: '', truncated: false });
    const uncounted = summary.files.filter((f) => f.uncounted);
    expect(uncounted.length).toBeGreaterThan(0);
    expect(await main.api.invoke('sessions.diffFile', { id, path: uncounted[0]!.path })).toEqual({ text: '', truncated: true });
  });

  it("keeps using the base the worktree was made from when origin/HEAD isn't there", async () => {
    const { checkout, main, id, path } = await started('worktree', 1, 'develop');
    git(checkout, 'remote', 'set-head', 'origin', '--delete');
    writeFileSync(join(path, 'x.txt'), 'x\n');

    const summary = await main.api.invoke('sessions.diff', { id });
    expect(summary).toMatchObject({ available: true, base: 'origin/develop' });
    expect(files(summary).map((f) => f.path)).toEqual(['x.txt']);
    await expect(main.api.invoke('sessions.diff', { id, uncommittedOnly: true })).resolves.toMatchObject({ available: true });
  });

  it('says clearly when the base ref is missing', async () => {
    const { checkout, main, id } = await started();
    git(checkout, 'remote', 'remove', 'origin');

    await expect(main.api.invoke('sessions.diff', { id })).rejects.toThrow(/no local origin\/main/);
  });

  it("shows an archived worktree Session's committed branch read-only, and no diff once its branch is gone", async () => {
    const { machine, checkout, main, id, path } = await started();
    machine.commit(path, 'feature.txt', 'f\n');
    // The commit isn't pushed, so the archive is confirmed.
    const archived = await main.api.invoke('sessions.archive', { id, discard: true });
    expect(archived).toEqual({ archived: true });
    const branch = (await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'archived'))).find((s) => s.id === id)!.branch!;

    const summary = await main.api.invoke('sessions.diff', { id });
    expect(summary).toMatchObject({ available: true, readOnly: true });
    expect(files(summary)).toEqual([{ path: 'feature.txt', status: 'committed', added: 1, removed: 0, binary: false }]);
    const file = await main.api.invoke('sessions.diffFile', { id, path: 'feature.txt' });
    expect(file.text).toContain('+f\n');

    git(checkout, 'branch', '-D', branch);
    expect(await main.api.invoke('sessions.diff', { id })).toEqual({ available: false, reason: 'No diff available' });
  });

  it('has no diff for an archived checkout Session', async () => {
    const { main, id } = await started('checkout');
    await main.api.invoke('sessions.archive', { id });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'archived'));

    expect(await main.api.invoke('sessions.diff', { id })).toEqual({ available: false, reason: 'No diff available' });
  });
});

describe("a Session's diff base", () => {
  /** A Project whose origin has `main` and `release`, the release one a commit ahead, and a Session in a worktree made by hand with `add`. */
  async function inHandMadeWorktree(add: (checkout: string, path: string) => void) {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done.'] }] } });
    const origin = machine.gitOrigin('billing-api');
    const checkout = machine.gitClone(origin, 'billing-api');
    git(checkout, 'switch', '--quiet', '-c', 'release');
    machine.commit(checkout, 'release.txt', 'r\n');
    git(checkout, 'push', '--quiet', 'origin', 'release');
    git(checkout, 'switch', '--quiet', 'main');
    git(checkout, 'branch', '--quiet', '-D', 'release');
    const path = machine.folder('by-hand');
    add(checkout, path);
    machine.commit(path, 'work.txt', 'w\n');
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', ready);
    const project = await main.api.invoke('projects.link', { path: checkout });
    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', existing: { worktree: path }, prompt: 'Carry on' });
    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting'));
    return { machine, checkout, main, id: created.id, path };
  }

  it('is the one Loom recorded when it made the branch', async () => {
    const { main, id } = await started();

    expect(await main.api.invoke('sessions.diff', { id })).toMatchObject({ available: true, base: 'origin/main', baseSource: 'recorded' });
  });

  it("is what the branch's reflog says it was created from, for a worktree made outside Loom", async () => {
    const { main, id } = await inHandMadeWorktree((checkout, path) => git(checkout, 'worktree', 'add', '--quiet', '-b', 'feat', path, 'origin/release'));

    const summary = await main.api.invoke('sessions.diff', { id });

    expect(summary).toMatchObject({ available: true, base: 'origin/release', baseSource: 'created-from' });
    expect(files(summary).map((f) => f.path)).toEqual(['work.txt']);
  });

  it("follows origin/HEAD, and a local branch to its origin namesake, as the reflog names them", async () => {
    const fromHead = await inHandMadeWorktree((checkout, path) => git(checkout, 'worktree', 'add', '--quiet', '-b', 'feat', path, 'origin/HEAD'));
    expect(await fromHead.main.api.invoke('sessions.diff', { id: fromHead.id })).toMatchObject({ base: 'origin/main', baseSource: 'created-from' });

    const fromLocal = await inHandMadeWorktree((checkout, path) => {
      git(checkout, 'branch', '--quiet', 'release', 'origin/release');
      git(checkout, 'worktree', 'add', '--quiet', '-b', 'feat', path, 'release');
    });
    expect(await fromLocal.main.api.invoke('sessions.diff', { id: fromLocal.id })).toMatchObject({ base: 'origin/release', baseSource: 'created-from' });
  });

  it("falls back to origin's default when the reflog can't say, and takes the base the user sets, kept in git config", async () => {
    // Created from HEAD: which branch that was isn't recorded.
    const { checkout, main, id, path } = await inHandMadeWorktree((checkout, path) => {
      git(checkout, 'switch', '--quiet', '--detach', 'origin/release');
      git(checkout, 'worktree', 'add', '--quiet', '-b', 'feat', path);
      git(checkout, 'switch', '--quiet', 'main');
    });
    expect(await main.api.invoke('sessions.diff', { id })).toMatchObject({ base: 'origin/main', baseSource: 'default' });
    expect(await main.api.invoke('sessions.diffBases', { id })).toEqual(['origin/main', 'origin/release']);

    await main.api.invoke('sessions.setDiffBase', { id, base: 'origin/release' });

    const summary = await main.api.invoke('sessions.diff', { id });
    expect(summary).toMatchObject({ base: 'origin/release', baseSource: 'recorded' });
    expect(files(summary).map((f) => f.path)).toEqual(['work.txt']);
    expect(git(checkout, 'config', '--get', 'branch.feat.loomBase')).toBe('origin/release');
    expect(git(path, 'status', '--porcelain')).toBe('');
  });

  it("doesn't take its own origin branch as the base of a branch made to track it", async () => {
    const { main, id } = await inHandMadeWorktree((checkout, path) => git(checkout, 'worktree', 'add', '--quiet', '--track', '-b', 'release', path, 'origin/release'));

    expect(await main.api.invoke('sessions.diff', { id })).toMatchObject({ base: 'origin/main', baseSource: 'default' });
  });

  it("rejects a base that isn't one of origin's branches, or a Session that isn't on a branch", async () => {
    const { main, id, path } = await inHandMadeWorktree((checkout, path) => git(checkout, 'worktree', 'add', '--quiet', '-b', 'feat', path, 'origin/main'));

    await expect(main.api.invoke('sessions.setDiffBase', { id, base: 'origin/nope' })).rejects.toThrow('origin/nope isn\'t one of origin\'s branches here; fetch origin if it is new.');
    await expect(main.api.invoke('sessions.setDiffBase', { id, base: 'main' })).rejects.toThrow("main isn't one of origin's branches here");
    git(path, 'switch', '--quiet', '--detach');
    await expect(main.api.invoke('sessions.setDiffBase', { id, base: 'origin/main' })).rejects.toThrow("isn't on a branch");
  });
});
