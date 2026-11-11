import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session } from '../../src/shared/api';
import { DEFAULT_SESSION_PANELS } from '../../src/shared/panels';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};

const worktreeSession: Session = {
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
};

/** The app with Session info open on `session`. */
function renderInfo(session: Session = worktreeSession, handlers: ConstructorParameters<typeof FakeMain>[1] = {}) {
  const main = new FakeMain({ projects: [project], sessions: [session], settings: DEFAULT_SETTINGS }, handlers);
  main.publish('panels', { ...DEFAULT_SESSION_PANELS, side: { panels: ['info', 'changes'], shown: 'info', open: true } }, { sessionId: session.id });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  const inbox = within(screen.getByRole('complementary', { name: 'Inbox' }));
  if (session.status === 'archived') fireEvent.click(inbox.getByRole('button', { name: 'Archived' }));
  fireEvent.click(inbox.getByRole('button', { name: session.title }));
  return main;
}

const info = () => within(screen.getByRole('complementary', { name: 'Side area' })).getByRole('tabpanel');
const deleteCalls = (main: FakeMain) => main.invoked.filter((i) => i.command === 'sessions.delete').map((i) => i.params);

describe('deleting a Session', () => {
  it('asks first, saying the worktree goes and its branch stays, and deletes once confirmed', async () => {
    const main = renderInfo(worktreeSession, {
      'sessions.delete': () => {
        main.publish('sessions', []);
        return { deleted: true };
      },
    });

    fireEvent.click(within(info()).getByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Fix login”?' });
    expect(dialog.textContent).toMatch(/can't be undone/);
    expect(dialog.textContent).toMatch(/worktree is removed/);
    expect(dialog.textContent).toContain('loom/fix-login');
    expect(deleteCalls(main)).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteCalls(main)).toEqual([{ id: 7 }]));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('No Session selected.')).toBeTruthy();
  });

  it('deletes nothing when cancelled', () => {
    const main = renderInfo();

    fireEvent.click(within(info()).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteCalls(main)).toEqual([]);
  });

  it('warns about unsaved work, and deletes only once told to discard it', async () => {
    const main = renderInfo(worktreeSession, {
      'sessions.delete': ({ discard }) => (discard ? { deleted: true } : { deleted: false, unsavedWork: { uncommitted: true, unpushedCommits: 2, detached: false } }),
    });
    fireEvent.click(within(info()).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

    const warning = await screen.findByRole('alertdialog', { name: 'Delete with unsaved work?' });
    expect(warning.textContent).toMatch(/uncommitted changes and 2 unpushed commits/);

    fireEvent.click(within(warning).getByRole('button', { name: 'Discard and delete' }));

    await waitFor(() => expect(deleteCalls(main)).toEqual([{ id: 7 }, { id: 7, discard: true }]));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('shows why the deletion failed, in the dialog', async () => {
    renderInfo(worktreeSession, {
      'sessions.delete': () => {
        throw new Error('This Session is being archived.');
      },
    });
    fireEvent.click(within(info()).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

    expect((await within(screen.getByRole('alertdialog')).findByRole('alert')).textContent).toBe('This Session is being archived.');
  });

  it('deletes an archived Session too, from Session info or the palette', async () => {
    const archived: Session = { ...worktreeSession, status: 'archived', waitingReason: undefined };
    const main = renderInfo(archived);

    const dialogText = () => screen.getByRole('alertdialog', { name: 'Delete “Fix login”?' }).textContent;
    fireEvent.click(within(info()).getByRole('button', { name: 'Delete' }));
    // An archived worktree Session's worktree is gone already.
    expect(dialogText()).not.toMatch(/worktree is removed/);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));

    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole('option', { name: 'Delete this Session…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteCalls(main)).toEqual([{ id: 7 }]));
  });

  it("says a checkout Session's checkout is left as it is", () => {
    renderInfo({ ...worktreeSession, workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' } });
    fireEvent.click(within(info()).getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog').textContent).toMatch(/checkout is left as it is/);
  });
});
