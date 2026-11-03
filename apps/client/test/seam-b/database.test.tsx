import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { DatabaseStatus } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

function renderApp(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const damaged: DatabaseStatus = {
  state: 'damaged',
  path: '/home/dev/.config/Loom/loom.db',
  problem: 'file is not a database',
  snapshots: ['/home/dev/.config/Loom/snapshots/2026-11-02T10-00-00-000Z-v4.db', '/home/dev/.config/Loom/snapshots/2026-11-01T10-00-00-000Z-v3.db'],
};

describe('a damaged database', () => {
  it('blocks the window with its path, the problem and the snapshots', () => {
    renderApp(new FakeMain({ database: damaged }));

    const screenEl = screen.getByRole('alert', { name: 'The database is damaged' });
    expect(screenEl.textContent).toContain('/home/dev/.config/Loom/loom.db');
    expect(screenEl.textContent).toContain('file is not a database');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(damaged.snapshots);
    expect(screen.queryByRole('complementary', { name: 'Inbox' })).toBeNull();
  });

  it('restores the latest snapshot, then shows the window', async () => {
    const main: FakeMain = new FakeMain({ database: damaged }, { 'database.restoreLatestSnapshot': () => main.publish('database', { state: 'ok' }) });
    renderApp(main);

    fireEvent.click(screen.getByRole('button', { name: 'Restore latest snapshot' }));

    await waitFor(() => expect(screen.getByRole('complementary', { name: 'Inbox' })).toBeTruthy());
    expect(main.invoked.map((i) => i.command)).toContain('database.restoreLatestSnapshot');
  });

  it('shows a failed restore', async () => {
    renderApp(
      new FakeMain({ database: damaged }, {
        'database.restoreLatestSnapshot': () => {
          throw new Error('the snapshot is damaged too');
        },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restore latest snapshot' }));

    expect(await screen.findByText(/the snapshot is damaged too/)).toBeTruthy();
  });

  it('with no snapshot, says so and offers no restore', () => {
    renderApp(new FakeMain({ database: { ...damaged, snapshots: [] } }));

    expect(screen.getByRole('alert', { name: 'The database is damaged' }).textContent).toContain('There are no snapshots');
    expect(screen.queryByRole('button', { name: 'Restore latest snapshot' })).toBeNull();
  });
});
