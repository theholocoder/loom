import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { AgentStatus, EnvironmentStatus, ForgeStatus, Project } from '../../src/shared/api';
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

const connectedNative: EnvironmentStatus = {
  id: 'native',
  label: 'Native',
  state: 'connected',
  bridge: { protocolVersion: 1, version: '0.1.0', os: 'linux', arch: 'amd64' },
  lastSeenAt: 1,
};

describe('the window', () => {
  it('shows the empty three-pane layout', () => {
    renderApp();

    const inbox = screen.getByRole('complementary', { name: 'Inbox' });
    expect(within(inbox).getByRole('button', { name: 'New Session' })).toBeTruthy();
    expect(within(inbox).getByRole('button', { name: 'Search Sessions and actions' })).toBeTruthy();
    expect(within(inbox).getByText('Nothing needs you right now.')).toBeTruthy();
    for (const section of ['Working', 'Archived']) {
      expect(within(inbox).getByRole('button', { name: section }).getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.getByRole('main', { name: 'Session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show changes' }).getAttribute('aria-expanded')).toBe('false');

    const footer = within(inbox).getByRole('navigation');
    expect(within(footer).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Projects', 'Dashboard', 'Settings']);
  });
});

describe('Settings', () => {
  it("shows the native Environment's bridge status and version", () => {
    renderApp(new FakeMain({ environments: [connectedNative] }));

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const row = screen.getByRole('row', { name: /Native/ });
    expect(within(row).getByText('connected')).toBeTruthy();
    expect(within(row).getByText('loom-bridge 0.1.0')).toBeTruthy();
  });

  it('follows the Environment as main reports changes', () => {
    const main = renderApp(new FakeMain({ environments: [{ id: 'native', label: 'Native', state: 'starting' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const row = () => screen.getByRole('row', { name: /Native/ });
    expect(within(row()).getByText('starting')).toBeTruthy();

    act(() => main.publish('environments', [connectedNative]));
    expect(within(row()).getByText('connected')).toBeTruthy();

    act(() => main.publish('environments', [{ ...connectedNative, state: 'disconnected', error: 'bridge exited (SIGKILL)' }]));
    expect(within(row()).getByText('disconnected')).toBeTruthy();
    expect(within(row()).getByText('bridge exited (SIGKILL)')).toBeTruthy();
  });
});

describe('Settings: the agent in each Environment', () => {
  const withAgent = (agent: Partial<AgentStatus>, env: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({
    ...connectedNative,
    shellEnvironment: 'interactive',
    agent: { name: 'OpenCode', state: 'ready', checking: false, ...agent },
    ...env,
  });

  function openSettings(environment: EnvironmentStatus) {
    const main = renderApp(new FakeMain({ environments: [environment] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    return { main, row: screen.getByRole('row', { name: /Native/ }) };
  }

  it('shows a ready OpenCode with its version and no warning', () => {
    const { row } = openSettings(withAgent({ state: 'ready', version: '2.1.4' }));

    expect(within(row).getByText('OpenCode 2.1.4')).toBeTruthy();
    expect(within(row).getByText('ready')).toBeTruthy();
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it.each([
    [{ state: 'missing' }, /isn't installed.*PATH.*2\.1\.4 or later/],
    [{ state: 'unsupported', version: '2.1.3' }, /2\.1\.3 is too old.*2\.1\.4 or later/],
    [{ state: 'unsupported', version: '1.19.4' }, /1\.19\.4 is V1 OpenCode.*not supported.*2\.1\.4 or later/],
    [{ state: 'signed-out', version: '2.1.4' }, /isn't signed in to any model provider/],
    [{ state: 'error', error: 'probe timed out' }, /couldn't check OpenCode: probe timed out/],
  ] as const)('warns what to fix when OpenCode is %o', (agent, warning) => {
    const { row } = openSettings(withAgent(agent));

    expect(within(row).getByRole('alert').textContent).toMatch(warning);
  });

  it("warns when the Environment couldn't read the user's login shell", () => {
    const { row } = openSettings(withAgent({ state: 'missing' }, { shellEnvironment: 'bridge' }));

    expect(within(row).getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/couldn't read your login shell/);
  });

  it("doesn't warn about the shell on native Windows, which has none", () => {
    const { row } = openSettings(
      withAgent({ state: 'ready', version: '2.1.4' }, { shellEnvironment: 'bridge', bridge: { ...connectedNative.bridge!, os: 'windows' } }),
    );

    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('shows that a check is running', () => {
    const { row } = openSettings(withAgent({ state: 'unknown', checking: true }));

    expect(within(row).getByText('checking')).toBeTruthy();
  });

  it('checks the agents again when Settings opens', () => {
    const { main } = openSettings(withAgent({ state: 'ready', version: '2.1.4' }));

    expect(main.invoked.map((i) => i.command)).toContain('environments.detect');
  });

  it("reloads an Environment's shell environment", () => {
    const { main, row } = openSettings(withAgent({ state: 'missing' }));

    fireEvent.click(within(row).getByRole('button', { name: 'Reload' }));

    expect(main.invoked).toContainEqual({ command: 'environments.reload', params: { id: 'native' } });
  });
});

describe('Projects', () => {
  const project = (name: string, forge: Partial<ForgeStatus> = {}, id = 1): Project => ({
    id,
    name,
    branchPrefix: 'loom',
    checkout: { environmentId: 'native', path: `/home/dev/code/${name}` },
    forge: { state: 'available', checking: false, kind: 'github', host: 'github.com', repository: `acme/${name}`, ...forge },
  });

  function openProjects(main: FakeMain) {
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    return main;
  }

  it('lists each Project with its checkout, Environment and branch prefix', () => {
    openProjects(new FakeMain({ environments: [connectedNative], projects: [project('billing-api')] }));

    const row = screen.getByRole('row', { name: /billing-api/ });
    expect(within(row).getByText('/home/dev/code/billing-api')).toBeTruthy();
    expect(within(row).getByText('Native')).toBeTruthy();
    expect((within(row).getByRole('textbox', { name: 'Branch prefix for billing-api' }) as HTMLInputElement).value).toBe('loom');
  });

  it('shows Forge features available, with the repository', () => {
    openProjects(new FakeMain({ projects: [project('loom', { repository: 'theholocoder/loom' })] }));

    const row = screen.getByRole('row', { name: /loom/ });
    expect(within(row).getByText('GitHub')).toBeTruthy();
    expect(within(row).getByText('theholocoder/loom')).toBeTruthy();
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it.each([
    [{ state: 'no-remote', kind: undefined, host: undefined }, /no origin remote/],
    [{ state: 'unsupported', kind: undefined, host: 'bitbucket.org', remote: 'https://bitbucket.org/acme/x.git' }, /https:\/\/bitbucket\.org\/acme\/x\.git.*isn't on GitHub or GitLab/],
    [{ state: 'cli-missing', kind: 'gitlab', host: 'gitlab.com' }, /glab isn't installed in Native/],
    [{ state: 'signed-out', kind: 'github', host: 'github.com' }, /gh isn't signed in to github\.com.*gh auth login --hostname github\.com/],
    [{ state: 'error', error: 'bridge did not answer' }, /couldn't check.*bridge did not answer/],
  ] as const)('shows Forge features off and why when the Forge is %o', (forge, reason) => {
    openProjects(new FakeMain({ environments: [connectedNative], projects: [project('loom', forge)] }));

    const row = screen.getByRole('row', { name: /loom/ });
    expect(within(row).getByText('off')).toBeTruthy();
    expect(within(row).getByRole('alert').textContent).toMatch(reason);
  });

  it('checks the Forges again when Projects opens', () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));

    expect(main.invoked.map((i) => i.command)).toContain('projects.check');
  });

  it('links the folder chosen with "Use existing clone…"', async () => {
    const main = openProjects(new FakeMain({}, { 'dialogs.chooseFolder': () => '/home/dev/code/loom', 'projects.link': () => project('loom') }));

    fireEvent.click(screen.getByRole('button', { name: 'Use existing clone…' }));

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: '/home/dev/code/loom' } }));
  });

  it('links nothing when the folder picker is cancelled', async () => {
    const main = openProjects(new FakeMain({}, { 'dialogs.chooseFolder': () => null }));

    fireEvent.click(screen.getByRole('button', { name: 'Use existing clone…' }));

    await waitFor(() => expect(main.invoked.map((i) => i.command)).toContain('dialogs.chooseFolder'));
    expect(main.invoked.map((i) => i.command)).not.toContain('projects.link');
  });

  it('says why a folder was rejected', async () => {
    openProjects(
      new FakeMain(
        {},
        {
          'dialogs.chooseFolder': () => '/home/dev/notes',
          'projects.link': () => {
            throw new Error('/home/dev/notes is not a git repository');
          },
        },
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use existing clone…' }));

    expect((await screen.findByRole('alert')).textContent).toMatch('/home/dev/notes is not a git repository');
  });

  it('saves a new branch prefix', async () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));
    const input = screen.getByRole('textbox', { name: 'Branch prefix for loom' });

    fireEvent.change(input, { target: { value: 'feat' } });
    fireEvent.submit(input);

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.setBranchPrefix', params: { id: 1, branchPrefix: 'feat' } }));
  });

  it('says why a branch prefix was refused', async () => {
    openProjects(
      new FakeMain(
        { projects: [project('loom')] },
        {
          'projects.setBranchPrefix': () => {
            throw new Error(`"a b" can't be a branch prefix: it contains a space`);
          },
        },
      ),
    );
    const input = screen.getByRole('textbox', { name: 'Branch prefix for loom' });

    fireEvent.change(input, { target: { value: 'a b' } });
    fireEvent.submit(input);

    expect((await screen.findByRole('alert')).textContent).toMatch(/can't be a branch prefix/);
  });

  it('groups the sidebar by Project', () => {
    renderApp(new FakeMain({ projects: [project('billing-api', {}, 1), project('loom', { state: 'no-remote', kind: undefined }, 2)] }));

    const inbox = screen.getByRole('complementary', { name: 'Inbox' });
    expect(within(inbox).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['billing-api', 'loom']);
  });
});
