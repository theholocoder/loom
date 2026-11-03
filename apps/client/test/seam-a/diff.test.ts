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

async function started(workingCopy: 'worktree' | 'checkout' = 'worktree', turns = 1) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: Array.from({ length: turns }, () => ({ chunks: ['Done.'] })) } });
  const origin = machine.gitOrigin('billing-api');
  const checkout = machine.gitClone(origin, 'billing-api');
  git(checkout, 'config', 'core.autocrlf', 'false');
  machine.commit(checkout, 'app.js', 'one\ntwo\nthree\n');
  git(checkout, 'push', '--quiet', 'origin', 'HEAD:main');
  git(checkout, 'fetch', '--quiet', 'origin');
  const main = await startMain({ machine });
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
    const app = await main.api.invoke('sessions.diffFile', { id, file: byPath(summary, 'app.js') });
    expect(app.text).toContain('-two\n+2\n');
    expect(app.text).toContain('+four\n');
    const appUncommitted = await main.api.invoke('sessions.diffFile', { id, file: byPath(uncommitted, 'app.js'), uncommittedOnly: true });
    expect(appUncommitted.text).not.toContain('-two');
    expect(appUncommitted.text).toContain('+four\n');
    const added = await main.api.invoke('sessions.diffFile', { id, file: byPath(summary, 'new file.txt') });
    expect(added.text).toContain('+x\n+y\n+z\n');
    const renamed = await main.api.invoke('sessions.diffFile', { id, file: byPath(summary, 'READ ME.md') });
    expect(renamed.text).toContain('rename to READ ME.md');
    expect(await main.api.invoke('sessions.diffFile', { id, file: byPath(summary, 'logo.png') })).toEqual({ text: '', truncated: false });

    // Working out the diff updates the rail badge: 6 files, untracked ones' lines as additions.
    await waitFor(main.api, 'sessions', session(id, (s) => s.diffStat?.files === 6 && s.diffStat.added === 1 + 2 + 2 + 3 && s.diffStat.removed === 1));
    expect(git(checkout, 'log', '--oneline', 'origin/main').split('\n')).toHaveLength(3);
  });

  it('shows the rail badge from git diff --shortstat at the end of each turn', async () => {
    const { machine, main, id, path } = await started('worktree', 2);
    machine.commit(path, 'a.txt', 'a\nb\n');
    writeFileSync(join(path, 'b.txt'), 'c\n');

    await main.api.invoke('sessions.send', { id, prompt: 'More' });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.diffStat?.files === 2 && s.diffStat.added === 3 && s.diffStat.removed === 0));
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
    const file = await main.api.invoke('sessions.diffFile', { id, file: (summary as { files: DiffFile[] }).files[0]! });
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
