// First run: the empty states lead somewhere. With no Project, a welcome
// with one way forward, Add a Project…, and a check of the Environments and
// their agent; after adding a Project, a way to start a Session in it.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { EnvironmentStatus, Project } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

function renderApp(main = new FakeMain()) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const loom: Project = {
  id: 1,
  name: 'loom',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/code/loom' },
  forge: { state: 'no-remote', checking: false },
};

const native = (agent: EnvironmentStatus['agent']): EnvironmentStatus => ({
  id: 'native',
  label: 'Native',
  state: 'connected',
  bridge: { protocolVersion: 3, version: '0.1.0', os: 'linux', arch: 'amd64', home: '/home/dev' },
  lastSeenAt: 1,
  agent,
});

/** Main linking `/home/dev/code/loom` as the loom Project, and publishing it as main does. */
function linking(initial: ConstructorParameters<typeof FakeMain>[0] = {}): FakeMain {
  const main: FakeMain = new FakeMain(initial, {
    'dialogs.chooseFolder': () => '/home/dev/code/loom',
    'projects.link': () => {
      main.publish('projects', [...main.value('projects'), loom]);
      return loom;
    },
  });
  return main;
}

describe('the welcome, with no Project', () => {
  it('says what Loom is, with one way forward: Add a Project…', () => {
    renderApp();

    const welcome = screen.getByRole('region', { name: 'Welcome' });
    expect(within(welcome).getByRole('heading', { name: 'Welcome to Loom' })).toBeTruthy();
    expect(within(welcome).getByText(/coding agents/)).toBeTruthy();
    const add = within(welcome).getByRole('button', { name: 'Add a Project…' });
    expect(add.classList.contains('primary')).toBe(true);
    expect(screen.queryByText('No Session selected.')).toBeNull();
  });

  it('adds the folder chosen as a Project', async () => {
    const main = renderApp(linking());

    fireEvent.click(within(screen.getByRole('region', { name: 'Welcome' })).getByRole('button', { name: 'Add a Project…' }));

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: '/home/dev/code/loom' } }));
  });

  it('checks each Environment and its agent', () => {
    const main = renderApp(new FakeMain({ environments: [native({ name: 'OpenCode', state: 'ready', checking: false, version: '2.2.0' })] }));

    const check = within(screen.getByRole('region', { name: 'Welcome' })).getByRole('list', { name: 'Environments' });
    const row = within(check).getByRole('listitem');
    expect(row.textContent).toMatch('Native');
    expect(row.textContent).toMatch('connected');
    expect(row.textContent).toMatch('OpenCode 2.2.0');
    expect(row.textContent).toMatch('ready');
    expect(main.invoked.map((i) => i.command)).toContain('environments.detect');
  });

  it('says the Environments are starting until main reports them', () => {
    renderApp();

    expect(within(screen.getByRole('region', { name: 'Welcome' })).getByText('Starting your Environments…')).toBeTruthy();
  });

  it('says what to fix when the agent is missing', () => {
    renderApp(new FakeMain({ environments: [native({ name: 'OpenCode', state: 'missing', checking: false })] }));

    const welcome = screen.getByRole('region', { name: 'Welcome' });
    expect(within(welcome).getByRole('alert').textContent).toMatch("OpenCode isn't installed in this Environment");
  });

  it('gives way to "No Session selected." once there is a Project', () => {
    renderApp(new FakeMain({ projects: [loom] }));

    expect(screen.queryByRole('region', { name: 'Welcome' })).toBeNull();
    expect(screen.getByRole('main', { name: 'Session' })).toBeTruthy();
  });
});

describe('with no Session selected', () => {
  it('offers to start one', () => {
    renderApp(new FakeMain({ projects: [loom] }));

    const pane = screen.getByRole('main', { name: 'Session' });
    expect(within(pane).getByText('No Session selected.')).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'New Session' }));
    // As Ctrl+N does: the Project first.
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter Projects' }), { key: 'Enter' });

    expect(within(screen.getByRole('main', { name: 'New Session' })).getByRole('button', { name: 'Project' }).textContent).toBe('loom');
  });
});

describe('New Session, with no Project', () => {
  it('offers to add one', async () => {
    const main = renderApp(linking());
    fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true });

    const pane = screen.getByRole('main', { name: 'New Session' });
    expect(within(pane).getByText('Add a Project before starting a Session.')).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Add a Project…' }));

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: '/home/dev/code/loom' } }));
  });
});

describe('after adding a Project', () => {
  const docs: Project = { ...loom, id: 2, name: 'docs', checkout: { environmentId: 'native', path: '/home/dev/code/docs' } };

  it('offers to start a Session in it, from the welcome', async () => {
    renderApp(linking());
    fireEvent.click(within(screen.getByRole('region', { name: 'Welcome' })).getByRole('button', { name: 'Add a Project…' }));

    const page = screen.getByRole('dialog', { name: 'Projects' });
    expect((await within(page).findByRole('status')).textContent).toMatch('Added loom.');
    fireEvent.click(within(page).getByRole('button', { name: 'Start a Session' }));

    expect(screen.queryByRole('dialog', { name: 'Projects' })).toBeNull();
    const pane = screen.getByRole('main', { name: 'New Session' });
    expect(within(pane).getByRole('button', { name: 'Project' }).textContent).toBe('loom');
  });

  it('starts the Session in the Project just added, not the first', async () => {
    renderApp(linking({ projects: [docs] }));
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a Project…' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Start a Session' }));

    expect(within(screen.getByRole('main', { name: 'New Session' })).getByRole('button', { name: 'Project' }).textContent).toBe('loom');
  });

  it('says a restored Project was restored, and offers a Session in it too', async () => {
    const main: FakeMain = new FakeMain(
      {},
      {
        'dialogs.chooseFolder': () => '/home/dev/code/loom',
        'projects.restorable': () => ({ id: 1, name: 'loom', sessions: 3 }),
        'projects.link': () => {
          main.publish('projects', [loom]);
          return loom;
        },
      },
    );
    renderApp(main);
    fireEvent.click(within(screen.getByRole('region', { name: 'Welcome' })).getByRole('button', { name: 'Add a Project…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Restore loom?' })).getByRole('button', { name: 'Restore' }));

    const page = screen.getByRole('dialog', { name: 'Projects' });
    expect((await within(page).findByRole('status')).textContent).toBe('Restored loom.');
    fireEvent.click(within(page).getByRole('button', { name: 'Start a Session' }));

    expect(within(screen.getByRole('main', { name: 'New Session' })).getByRole('button', { name: 'Project' }).textContent).toBe('loom');
  });

  it('forgets the offer when leaving Projects', async () => {
    renderApp(linking());
    fireEvent.click(within(screen.getByRole('region', { name: 'Welcome' })).getByRole('button', { name: 'Add a Project…' }));
    await screen.findByRole('button', { name: 'Start a Session' });

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));

    expect(screen.queryByRole('button', { name: 'Start a Session' })).toBeNull();
  });
});
