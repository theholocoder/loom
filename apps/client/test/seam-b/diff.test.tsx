import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { DiffPanel } from '../../src/renderer/DiffPanel';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type DiffFile, type DiffSummary, type Project, type Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const session: Session = {
  id: 7,
  projectId: 1,
  title: 'Fix login',
  workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/billing-api/fix-login' },
  branch: 'loom/fix-login',
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
  diffStat: { files: 4, added: 1210, removed: 3 },
};

const files: DiffFile[] = [
  { path: 'src/auth/login.ts', status: 'committed', added: 5, removed: 2, binary: false },
  { path: 'src/auth/session.ts', status: 'modified', added: 2, removed: 1, binary: false },
  { path: 'docs/logo.png', status: 'untracked', added: 0, removed: 0, binary: true },
  { path: 'pnpm-lock.yaml', status: 'committed', added: 1200, removed: 0, binary: false },
];
const summary: DiffSummary = { available: true, readOnly: false, base: 'origin/main', files };
const text = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n context\n-old line\n+new line\n`;

function renderOpen(main: FakeMain, s: Session = session) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: s.title }));
  return main;
}

function fakeMain(result: DiffSummary = summary, s: Session = session) {
  return new FakeMain(
    { projects: [project], sessions: [s], settings: DEFAULT_SETTINGS },
    {
      'sessions.diff': ({ uncommittedOnly }) => (uncommittedOnly && result.available ? { ...result, files: result.files.filter((f) => f.status !== 'committed') } : result),
      'sessions.diffFile': ({ path }) => ({ text: text(path), truncated: false }),
    },
  );
}

const panel = () => screen.getByRole('region', { name: 'Changes' });
const diffCalls = (main: FakeMain, command: string) => main.invoked.filter((c) => c.command === command);

describe('the diff panel', () => {
  it('shows the files/+/− counts in the Session header control, with no rail, and works out the diff only once opened', () => {
    const main = renderOpen(fakeMain());
    const header = screen.getByRole('main', { name: 'Session' });
    const control = within(header).getByRole('button', { name: 'Show changes: 4 files, 1210 added, 3 removed' });
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(control.getAttribute('aria-controls')).toBe('diff-panel');
    expect(control.getAttribute('title')).toBe('Show changes: 4 files, 1210 added, 3 removed');
    expect(control.querySelector('.files')?.textContent).toBe('4');
    expect(control.querySelector('.add')?.textContent).toBe('+1210');
    expect(control.querySelector('.del')?.textContent).toBe('−3');
    expect(document.querySelector('.diff-rail, .diff-badge')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();
    expect(diffCalls(main, 'sessions.diff')).toHaveLength(0);

    fireEvent.click(control);
    expect(within(header).getByRole('button', { name: /^Hide changes: 4 files/ }).getAttribute('aria-expanded')).toBe('true');
    expect(panel()).toBeTruthy();
  });

  it('shows a file tree and per-file sections, large, binary and lockfiles collapsed, loading a diff on expand', async () => {
    const main = renderOpen(fakeMain());
    fireEvent.click(screen.getByRole('button', { name: /^Show changes/ }));
    await waitFor(() => expect(within(panel()).getByRole('navigation', { name: 'Changed files' })).toBeTruthy());
    const tree = within(panel()).getByRole('navigation', { name: 'Changed files' });
    expect(within(tree).getByRole('button', { name: 'src' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(tree).getByRole('button', { name: /login\.ts.*committed/ })).toBeTruthy();
    expect(within(tree).getByRole('button', { name: /session\.ts.*modified/ })).toBeTruthy();
    expect(within(tree).getByRole('button', { name: /logo\.png.*untracked/ })).toBeTruthy();
    fireEvent.click(within(tree).getByRole('button', { name: 'src' }));
    expect(within(tree).queryByRole('button', { name: /login\.ts/ })).toBeNull();

    const section = (path: string) => within(panel()).getByRole('region', { name: path });
    const toggle = (path: string) => within(section(path)).getByRole('button', { name: new RegExp(`^${path.replaceAll('.', '\\.')}`) });
    expect(toggle('src/auth/login.ts').getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(within(section('src/auth/login.ts')).getByText('+new line').className).toContain('add'));
    expect(within(section('src/auth/login.ts')).getByText('-old line').className).toContain('del');
    for (const collapsed of ['docs/logo.png', 'pnpm-lock.yaml']) expect(toggle(collapsed).getAttribute('aria-expanded')).toBe('false');
    expect(diffCalls(main, 'sessions.diffFile').map((c) => (c.params as { path: string }).path).sort()).toEqual(['src/auth/login.ts', 'src/auth/session.ts']);

    fireEvent.click(toggle('pnpm-lock.yaml'));
    await waitFor(() => expect(within(section('pnpm-lock.yaml')).getByText('+new line')).toBeTruthy());

    fireEvent.click(within(section('src/auth/login.ts')).getByRole('button', { name: 'Open src/auth/login.ts in the editor' }));
    expect(main.invoked).toContainEqual({ command: 'sessions.openInEditor', params: { id: 7, file: 'src/auth/login.ts' } });
  });

  it('toggles to uncommitted changes only, and refreshes', async () => {
    const main = renderOpen(fakeMain());
    fireEvent.click(screen.getByRole('button', { name: /^Show changes/ }));
    const only = await within(panel()).findByRole('button', { name: 'Uncommitted only' });
    fireEvent.click(only);
    await waitFor(() => expect(within(panel()).queryByRole('region', { name: 'src/auth/login.ts' })).toBeNull());
    expect(only.getAttribute('aria-pressed')).toBe('true');
    expect(diffCalls(main, 'sessions.diff').at(-1)?.params).toEqual({ id: 7, uncommittedOnly: true });

    const before = diffCalls(main, 'sessions.diff').length;
    fireEvent.click(within(panel()).getByRole('button', { name: 'Refresh changes' }));
    await waitFor(() => expect(diffCalls(main, 'sessions.diff').length).toBe(before + 1));
  });

  it('refreshes at the end of a turn and on reopening', async () => {
    const main = renderOpen(fakeMain());
    fireEvent.click(screen.getByRole('button', { name: /^Show changes/ }));
    await waitFor(() => expect(diffCalls(main, 'sessions.diff')).toHaveLength(1));
    act(() => main.publish('sessions', [{ ...session, status: 'working' }]));
    act(() => main.publish('sessions', [{ ...session, status: 'waiting', updatedAt: 5 }]));
    await waitFor(() => expect(diffCalls(main, 'sessions.diff')).toHaveLength(2));
    // An update that isn't a turn ending doesn't refresh it.
    act(() => main.publish('sessions', [{ ...session, status: 'waiting', updatedAt: 6, unread: true }]));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Hide changes' }));
    fireEvent.click(screen.getByRole('button', { name: /^Show changes/ }));
    await waitFor(() => expect(diffCalls(main, 'sessions.diff')).toHaveLength(3));
  });

  it("shows an archived Session's branch read-only, or no diff available", async () => {
    const archived = { ...session, status: 'archived' as const };
    const renderPanel = (main: FakeMain) =>
      render(
        <ApiProvider api={main}>
          <DiffPanel session={archived} open onToggle={() => {}} />
        </ApiProvider>,
      );
    renderPanel(fakeMain({ ...summary, readOnly: true, files: [files[0]!] }, archived));
    await within(panel()).findByRole('region', { name: 'src/auth/login.ts' });
    expect(within(panel()).queryByRole('button', { name: 'Uncommitted only' })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: /in the editor/ })).toBeNull();
    cleanup();

    renderPanel(fakeMain({ available: false, reason: 'No diff available' }, archived));
    expect(await within(panel()).findByText('No diff available')).toBeTruthy();
  });

  it('shows why the diff could not be worked out', async () => {
    const main = new FakeMain(
      { projects: [project], sessions: [session], settings: DEFAULT_SETTINGS },
      {
        'sessions.diff': () => {
          throw new Error("There's no local origin/main to compare with; fetch origin to see this diff.");
        },
      },
    );
    renderOpen(main);
    fireEvent.click(screen.getByRole('button', { name: /^Show changes/ }));
    expect((await within(panel()).findByRole('alert')).textContent).toMatch(/no local origin\/main/);
  });
});
