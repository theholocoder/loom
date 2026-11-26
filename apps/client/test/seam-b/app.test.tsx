import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { AgentStatus, EnvironmentStatus, ForgeStatus, Project } from '../../src/shared/api';
import { wslEnvironmentId } from '../../src/shared/environment-ids';
import { settingsPage } from './settings-page';
import { FakeMain } from './fake-main';

afterEach(cleanup);

/** Projects' own Add a Project…, rather than the welcome's behind it. */
const addProjectButton = () => within(screen.getByRole('dialog', { name: 'Projects' })).getByRole('button', { name: 'Add a Project…' });

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
  bridge: { protocolVersion: 3, version: '0.1.0', os: 'linux', arch: 'amd64', home: '/home/dev' },
  lastSeenAt: 1,
};

describe('the window', () => {
  it('shows the empty three-pane layout', () => {
    renderApp();

    const inbox = screen.getByRole('complementary', { name: 'Inbox' });
    expect(within(inbox).getByRole('button', { name: 'New' }).getAttribute('aria-expanded')).toBe('false');
    expect(within(inbox).getByRole('button', { name: 'Search Sessions and actions' })).toBeTruthy();
    expect(within(inbox).getByText('Nothing needs you right now.')).toBeTruthy();
    for (const section of ['Working', 'Archived']) {
      expect(within(inbox).getByRole('button', { name: section }).getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.getByRole('main', { name: 'Session' })).toBeTruthy();
    // No Project yet: the welcome, in the main pane.
    expect(within(screen.getByRole('main', { name: 'Session' })).getByRole('region', { name: 'Welcome' })).toBeTruthy();
    // No Session selected: no header, so no diff toggle, and no panel or rail taking space.
    expect(screen.queryByRole('button', { name: /changes/i })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();

    const footer = within(inbox).getByRole('navigation');
    expect(within(footer).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Projects', 'Dashboard', 'Send feedback', 'Settings']);
  });
});

describe('Settings', () => {
  it("shows the native Environment's bridge status and version", () => {
    renderApp(new FakeMain({ environments: [connectedNative] }));

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    settingsPage('Environments');

    const row = screen.getByRole('row', { name: /Native/ });
    expect(within(row).getByText('connected')).toBeTruthy();
    expect(within(row).getByText('loom-bridge 0.1.0')).toBeTruthy();
  });

  it('follows the Environment as main reports changes', () => {
    const main = renderApp(new FakeMain({ environments: [{ id: 'native', label: 'Native', state: 'starting' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    settingsPage('Environments');
    const row = () => screen.getByRole('row', { name: /Native/ });
    expect(within(row()).getByText('starting')).toBeTruthy();

    act(() => main.publish('environments', [connectedNative]));
    expect(within(row()).getByText('connected')).toBeTruthy();

    act(() => main.publish('environments', [{ ...connectedNative, state: 'disconnected', error: 'bridge exited (SIGKILL)' }]));
    expect(within(row()).getByText('disconnected')).toBeTruthy();
    expect(within(row()).getByText('bridge exited (SIGKILL)')).toBeTruthy();
  });
});

describe('Settings: worktrees', () => {
  const openSettings = (main: FakeMain) => {
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    settingsPage('Worktrees');
    return screen.getByRole('textbox', { name: 'Worktree root' }) as HTMLInputElement;
  };

  it('shows the worktree root, ~/loom/worktrees by default, and saves a new one', async () => {
    const main = new FakeMain();
    const input = openSettings(main);
    expect(input.value).toBe('~/loom/worktrees');

    fireEvent.change(input, { target: { value: '/srv/worktrees' } });
    fireEvent.submit(input);
    fireEvent.blur(input);

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'settings.setWorktreeRoot')).toEqual([{ command: 'settings.setWorktreeRoot', params: { worktreeRoot: '/srv/worktrees' } }]));
  });

  it('says why a worktree root was refused', async () => {
    const input = openSettings(
      new FakeMain({}, {
        'settings.setWorktreeRoot': () => {
          throw new Error('"code" can\'t be the worktree root: it must be an absolute path or start with ~');
        },
      }),
    );

    fireEvent.change(input, { target: { value: 'code' } });
    fireEvent.submit(input);

    expect((await screen.findByRole('alert')).textContent).toMatch(/can't be the worktree root/);
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
    settingsPage('Environments');
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

describe('Settings: WSL distros', () => {
  const distro = (name: string, env: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({ id: wslEnvironmentId(name), label: name, distro: name, state: 'idle', ...env });

  function openSettings(...environments: EnvironmentStatus[]) {
    const main = renderApp(new FakeMain({ environments: [connectedNative, ...environments] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    settingsPage('Environments');
    return main;
  }
  const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

  it('lists each distro as an Environment of its own, with its bridge and agent', () => {
    openSettings(
      distro('Ubuntu', { state: 'connected', bridge: { ...connectedNative.bridge!, os: 'linux' }, shellEnvironment: 'interactive', agent: { name: 'OpenCode', state: 'ready', version: '2.1.4', checking: false } }),
      distro('Debian'),
    );

    expect(within(row('Ubuntu')).getByText('OpenCode 2.1.4')).toBeTruthy();
    expect(within(row('Ubuntu')).getByText(`loom-bridge ${connectedNative.bridge!.version}`)).toBeTruthy();
    expect(within(row('Ubuntu')).getByText('WSL')).toBeTruthy();
    expect(within(row('Debian')).getByText('not started')).toBeTruthy();
  });

  it('starts a distro not started yet', () => {
    const main = openSettings(distro('Debian'));

    fireEvent.click(within(row('Debian')).getByRole('button', { name: 'Start' }));

    expect(main.invoked).toContainEqual({ command: 'environments.start', params: { id: wslEnvironmentId('Debian') } });
  });

  it('retries a distro that failed to start', () => {
    const main = openSettings(distro('Debian', { state: 'failed', error: 'There is no distribution with the supplied name.' }));

    fireEvent.click(within(row('Debian')).getByRole('button', { name: 'Retry' }));

    expect(main.invoked).toContainEqual({ command: 'environments.start', params: { id: wslEnvironmentId('Debian') } });
  });

  it('says the distro is starting, and when Loom installs its bridge there', () => {
    openSettings(distro('Ubuntu', { state: 'starting' }), distro('Debian', { state: 'starting', installing: true }));

    expect(within(row('Ubuntu')).getByText('Starting Ubuntu…')).toBeTruthy();
    expect(within(row('Debian')).getByText('Starting Debian… (installing loom-bridge)')).toBeTruthy();
  });

  it('reloads one distro on its own', () => {
    const main = openSettings(distro('Ubuntu', { state: 'connected', bridge: { ...connectedNative.bridge!, os: 'linux' } }));

    fireEvent.click(within(row('Ubuntu')).getByRole('button', { name: 'Reload' }));

    expect(main.invoked).toContainEqual({ command: 'environments.reload', params: { id: wslEnvironmentId('Ubuntu') } });
  });
});

describe('Projects', () => {
  const project = (name: string, forge: Partial<ForgeStatus> = {}, id = 1): Project => ({
    id,
    name,
    color: 'blue',
    branchPrefix: 'loom',
    checkout: { environmentId: 'native', path: `/home/dev/code/${name}` },
    forge: { state: 'available', checking: false, kind: 'github', host: 'github.com', repository: `acme/${name}`, ...forge },
  });

  function openProjects(main: FakeMain) {
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    return main;
  }

  const page = () => screen.getByRole('dialog', { name: 'Projects' });
  const list = () => within(page()).getByRole('navigation', { name: 'Projects' });
  /** One of the picked Project's cards of settings. */
  const card = (title: string) => within(page()).getByRole('region', { name: title });
  const field = (name: string) => within(page()).getByRole('textbox', { name }) as HTMLInputElement;

  it('lists each Project beside, and shows the first one\'s settings', () => {
    openProjects(new FakeMain({ environments: [connectedNative], projects: [project('billing-api', {}, 1), project('loom', {}, 2)] }));

    expect(within(list()).getAllByRole('button').map((b) => b.textContent)).toEqual(['BIbilling-api', 'LOloom']);
    expect(within(list()).getByRole('button', { name: /billing-api/ }).getAttribute('aria-current')).toBe('page');
    expect(within(page()).getByRole('heading', { name: 'billing-api', level: 2 })).toBeTruthy();
    expect(within(card('Checkout')).getByText('/home/dev/code/billing-api')).toBeTruthy();
    expect(within(card('Checkout')).getByText('Native')).toBeTruthy();
    expect(field('Branch prefix').value).toBe('loom');
  });

  it('loads the settings of the Project picked from the list', () => {
    openProjects(new FakeMain({ environments: [connectedNative], projects: [project('billing-api', {}, 1), { ...project('loom', {}, 2), branchPrefix: 'feat', defaultBranch: 'develop' }] }));

    fireEvent.click(within(list()).getByRole('button', { name: /loom/ }));

    expect(within(list()).getByRole('button', { name: /loom/ }).getAttribute('aria-current')).toBe('page');
    expect(within(list()).getByRole('button', { name: /billing-api/ }).getAttribute('aria-current')).toBeNull();
    expect(within(page()).getByRole('heading', { name: 'loom', level: 2 })).toBeTruthy();
    expect(field('Name').value).toBe('loom');
    expect(field('Branch prefix').value).toBe('feat');
    expect(field('Default branch').value).toBe('develop');
    expect(within(card('Checkout')).getByText('/home/dev/code/loom')).toBeTruthy();
  });

  it('says how to add a Project while there is none', () => {
    openProjects(new FakeMain({}));

    expect(within(page()).getByText(/No Projects yet/)).toBeTruthy();
    expect(within(page()).queryByRole('navigation', { name: 'Projects' })).toBeNull();
  });

  it('filters a long list of Projects by name or checkout, Enter picking the first found', () => {
    const names = ['api', 'billing', 'docs', 'infra', 'loom', 'mobile', 'web'];
    openProjects(new FakeMain({ projects: names.map((name, i) => project(name, {}, i + 1)) }));

    fireEvent.change(within(page()).getByRole('searchbox', { name: 'Filter Projects' }), { target: { value: 'LO' } });

    expect(within(list()).getAllByRole('button').map((b) => b.textContent)).toEqual(['LOloom']);
    fireEvent.keyDown(within(page()).getByRole('searchbox', { name: 'Filter Projects' }), { key: 'Enter' });
    expect(within(page()).getByRole('heading', { name: 'loom', level: 2 })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Projects' })).toBeTruthy();

    fireEvent.change(within(page()).getByRole('searchbox', { name: 'Filter Projects' }), { target: { value: 'nothing' } });
    expect(within(list()).getByText('No Project matches “nothing”.')).toBeTruthy();
  });

  it('shows Forge features available, with the repository', () => {
    openProjects(new FakeMain({ projects: [project('loom', { repository: 'theholocoder/loom' })] }));

    expect(within(card('Checkout')).getByText('GitHub')).toBeTruthy();
    expect(within(card('Checkout')).getByText('theholocoder/loom')).toBeTruthy();
    expect(within(page()).queryByRole('alert')).toBeNull();
  });

  it.each([
    [{ state: 'cli-missing', kind: 'gitlab', host: 'gitlab.com' }, /glab isn't installed in Native/],
    [{ state: 'signed-out', kind: 'github', host: 'github.com' }, /gh isn't signed in to github\.com.*gh auth login --hostname github\.com/],
    [{ state: 'error', error: 'bridge did not answer' }, /couldn't check.*bridge did not answer/],
  ] as const)('shows Forge features off and why when the Forge is %o, and marks the Project in the list', (forge, reason) => {
    openProjects(new FakeMain({ environments: [connectedNative], projects: [project('loom', forge)] }));

    expect(within(card('Checkout')).getByText('off')).toBeTruthy();
    expect(within(card('Checkout')).getByRole('note').textContent).toMatch(reason);
    expect(within(list()).getByRole('button', { name: /^loom, Forge features off$/ })).toBeTruthy();
  });

  it('shows a checkout with no origin remote as local only, muted, with why on hover', () => {
    openProjects(new FakeMain({ environments: [connectedNative], projects: [project('notes', { state: 'no-remote', kind: undefined, host: undefined })] }));

    const local = within(card('Checkout')).getByText('Local only').parentElement!;
    expect(local.className).toMatch('fg-local');
    expect(local.getAttribute('title')).toMatch(/no origin remote/);
    expect(within(page()).queryByRole('note')).toBeNull();
    expect(within(page()).queryByText('off')).toBeNull();
    expect(within(list()).queryByRole('button', { name: /Forge features off/ })).toBeNull();
  });

  it("shows an origin that isn't on GitHub or GitLab as no Forge, muted, with why on hover", () => {
    openProjects(new FakeMain({ environments: [connectedNative], projects: [project('notes', { state: 'unsupported', kind: undefined, host: 'bitbucket.org', remote: 'https://bitbucket.org/acme/x.git' })] }));

    const none = within(card('Checkout')).getByText('No Forge').parentElement!;
    expect(none.className).toMatch('fg-local');
    expect(none.getAttribute('title')).toMatch(/https:\/\/bitbucket\.org\/acme\/x\.git.*isn't on GitHub or GitLab/);
    expect(within(page()).queryByRole('alert')).toBeNull();
    expect(within(page()).queryByText('off')).toBeNull();
  });

  it('cuts a long Project name to one line, with the full name on hover', () => {
    const name = 'customer-billing-and-invoicing-platform-api-gateway';
    openProjects(new FakeMain({ environments: [connectedNative], projects: [project(name)] }));

    expect(within(list()).getByText(name).className).toMatch('ellipsis');
    const heading = within(page()).getByRole('heading', { name, level: 2 });
    expect(heading.className).toMatch('ellipsis');
    expect(heading.getAttribute('title')).toBe(name);
  });

  it('checks the Forges again when Projects opens', () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));

    expect(main.invoked.map((i) => i.command)).toContain('projects.check');
  });

  it('checks the Sessions again when the window gets focus', () => {
    const main = openProjects(new FakeMain({}));

    fireEvent.focus(window);

    expect(main.invoked.map((i) => i.command)).toContain('sessions.check');
  });

  it('links the folder chosen with "Add a Project…"', async () => {
    const main = openProjects(new FakeMain({}, { 'dialogs.chooseFolder': () => '/home/dev/code/loom', 'projects.link': () => project('loom') }));

    fireEvent.click(addProjectButton());

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: '/home/dev/code/loom', environmentId: 'native' } }));
  });

  it('links nothing when the folder picker is cancelled', async () => {
    const main = openProjects(new FakeMain({}, { 'dialogs.chooseFolder': () => null }));

    fireEvent.click(addProjectButton());

    await waitFor(() => expect(main.invoked.map((i) => i.command)).toContain('dialogs.chooseFolder'));
    expect(main.invoked.map((i) => i.command)).not.toContain('projects.link');
  });

  describe('with WSL distros', () => {
    const windowsNative: EnvironmentStatus = { ...connectedNative, bridge: { ...connectedNative.bridge!, os: 'windows', home: 'C:\\Users\\dev' } };
    const distro = (name: string): EnvironmentStatus => ({ id: wslEnvironmentId(name), label: name, distro: name, state: 'idle' });
    const inUbuntu = (path: string): Project => ({ ...project('loom'), checkout: { environmentId: wslEnvironmentId('Ubuntu'), path } });
    const choice = () => screen.getByRole('dialog', { name: "Where does the checkout's work run?" });

    it('asks where the checkout works, a WSL distro picked, then picks the folder there', async () => {
      const main = openProjects(
        new FakeMain({ environments: [windowsNative, distro('Ubuntu'), distro('Debian')] }, { 'dialogs.chooseFolder': () => '\\\\wsl.localhost\\Ubuntu\\home\\dev\\loom', 'projects.link': () => inUbuntu('/home/dev/loom') }),
      );

      fireEvent.click(addProjectButton());

      const options = within(choice()).getAllByRole('radio') as HTMLInputElement[];
      expect(options.map((o) => [o.labels?.[0]?.textContent, o.checked])).toEqual([
        ['Windows', false],
        ['Ubuntu (WSL)', true],
        ['Debian (WSL)', false],
      ]);
      expect(main.invoked.map((i) => i.command)).not.toContain('dialogs.chooseFolder');
      fireEvent.click(within(choice()).getByRole('button', { name: 'Choose the folder…' }));

      await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\loom', environmentId: wslEnvironmentId('Ubuntu') } }));
      expect(main.invoked).toContainEqual({ command: 'dialogs.chooseFolder', params: { environmentId: wslEnvironmentId('Ubuntu') } });
      expect(screen.queryByRole('dialog', { name: "Where does the checkout's work run?" })).toBeNull();
      expect(screen.queryByRole('note', { name: 'Slow checkout' })).toBeNull();
    });

    it('links a native Windows checkout when Windows is picked', async () => {
      const main = openProjects(new FakeMain({ environments: [windowsNative, distro('Ubuntu')] }, { 'dialogs.chooseFolder': () => 'C:\\code\\loom', 'projects.link': () => project('loom') }));

      fireEvent.click(addProjectButton());
      fireEvent.click(within(choice()).getByRole('radio', { name: 'Windows' }));
      fireEvent.click(within(choice()).getByRole('button', { name: 'Choose the folder…' }));

      await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: 'C:\\code\\loom', environmentId: 'native' } }));
    });

    it('warns that a WSL checkout on a Windows drive is slow', async () => {
      openProjects(new FakeMain({ environments: [windowsNative, distro('Ubuntu')] }, { 'dialogs.chooseFolder': () => 'C:\\code\\loom', 'projects.link': () => inUbuntu('/mnt/c/code/loom') }));

      fireEvent.click(addProjectButton());
      fireEvent.click(within(choice()).getByRole('button', { name: 'Choose the folder…' }));

      expect((await screen.findByRole('note', { name: 'Slow checkout' })).textContent).toMatch('/mnt/c/code/loom is on a Windows drive');
    });
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

    fireEvent.click(addProjectButton());

    expect((await screen.findByRole('alert')).textContent).toMatch('/home/dev/notes is not a git repository');
  });

  const rejecting = () =>
    new FakeMain(
      {},
      {
        'dialogs.chooseFolder': () => '/home/dev/notes',
        'projects.link': () => {
          throw new Error('/home/dev/notes is not a git repository');
        },
      },
    );

  it('dismisses why a folder was rejected', async () => {
    openProjects(rejecting());
    fireEvent.click(addProjectButton());
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forgets why a folder was rejected when leaving Projects', async () => {
    openProjects(rejecting());
    fireEvent.click(addProjectButton());
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("doesn't show why a folder was rejected after leaving Projects while it was being linked", async () => {
    let fail!: (e: Error) => void;
    const main = openProjects(
      new FakeMain(
        {},
        {
          'dialogs.chooseFolder': () => '/home/dev/notes',
          'projects.link': () => new Promise<never>((_, reject) => (fail = reject)),
        },
      ),
    );
    fireEvent.click(addProjectButton());
    await waitFor(() => expect(main.invoked.map((i) => i.command)).toContain('projects.link'));

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fail(new Error('/home/dev/notes is not a git repository'));
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));

    await waitFor(() => expect(addProjectButton().hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('labels Remove, with the Project in its tooltip', () => {
    openProjects(new FakeMain({ projects: [project('loom')] }));

    const remove = within(card('Remove')).getByRole('button', { name: 'Remove loom' });
    expect(remove.textContent).toBe('Remove');
    expect(remove.getAttribute('title')).toBe('Remove loom');
  });

  it('saves a new branch prefix', async () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));

    fireEvent.change(field('Branch prefix'), { target: { value: 'feat' } });
    fireEvent.submit(field('Branch prefix'));

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.setBranchPrefix', params: { id: 1, branchPrefix: 'feat' } }));
  });

  it('saves a branch prefix once when Enter is followed by leaving the field', async () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));

    fireEvent.change(field('Branch prefix'), { target: { value: 'feat' } });
    fireEvent.submit(field('Branch prefix'));
    fireEvent.blur(field('Branch prefix'));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'projects.setBranchPrefix')).toHaveLength(1));
  });

  it('previews the branches a prefix makes, without the trailing / Loom adds itself', () => {
    openProjects(new FakeMain({ projects: [project('loom')] }));
    expect(within(card('New Sessions')).getByText('loom/<session>')).toBeTruthy();

    fireEvent.change(field('Branch prefix'), { target: { value: 'feat/' } });

    expect(within(card('New Sessions')).getByText('feat/<session>')).toBeTruthy();
  });

  it('saves a branch prefix typed with a trailing /', async () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));

    fireEvent.change(field('Branch prefix'), { target: { value: 'feat/' } });
    fireEvent.submit(field('Branch prefix'));

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.setBranchPrefix', params: { id: 1, branchPrefix: 'feat/' } }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an invalid branch prefix in the field, saying why, until it is fixed', () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));
    const input = field('Branch prefix');

    fireEvent.change(input, { target: { value: 'a b' } });
    fireEvent.blur(input);

    expect(input.value).toBe('a b');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/"a b" can't be a branch prefix: it contains a space/);
    expect(main.invoked.map((i) => i.command)).not.toContain('projects.setBranchPrefix');

    fireEvent.change(input, { target: { value: 'ab' } });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('ab/<session>')).toBeTruthy();
  });

  it('says why main refused a branch prefix', async () => {
    openProjects(
      new FakeMain(
        { projects: [project('loom')] },
        {
          'projects.setBranchPrefix': () => {
            throw new Error('database is locked');
          },
        },
      ),
    );

    fireEvent.change(field('Branch prefix'), { target: { value: 'feat' } });
    fireEvent.submit(field('Branch prefix'));

    expect((await screen.findByRole('alert')).textContent).toMatch('database is locked');
  });

  it('picks the Project just added, to set it up', async () => {
    const docs = project('docs', {}, 1);
    const loom = project('loom', {}, 2);
    const main: FakeMain = new FakeMain(
      { projects: [docs] },
      {
        'dialogs.chooseFolder': () => '/home/dev/code/loom',
        'projects.link': () => {
          main.publish('projects', [docs, loom]);
          return loom;
        },
      },
    );
    openProjects(main);

    fireEvent.click(addProjectButton());

    expect(await within(page()).findByText('Added loom.')).toBeTruthy();
    expect(within(list()).getByRole('button', { name: /loom/ }).getAttribute('aria-current')).toBe('page');
    expect(within(page()).getByRole('button', { name: 'Start a Session' }).className).toMatch('primary');
  });

  describe('its settings, each saved as it changes', () => {
    const edits = (main: FakeMain) => main.invoked.filter((i) => i.command === 'projects.edit').map((i) => i.params);

    it('saves a new name, and shows it in the list', async () => {
      const main = openProjects(new FakeMain({ projects: [project('loom')] }));

      fireEvent.change(field('Name'), { target: { value: 'Loom app' } });
      fireEvent.submit(field('Name'));

      await waitFor(() => expect(edits(main)).toEqual([{ id: 1, name: 'Loom app' }]));
      expect(within(list()).getByText('Loom app')).toBeTruthy();
      expect(await within(card('General')).findByText('Saved')).toBeTruthy();
    });

    it('says why a name or avatar is refused, without sending it', () => {
      const main = openProjects(new FakeMain({ projects: [project('loom')] }));

      fireEvent.change(field('Name'), { target: { value: '  ' } });
      fireEvent.blur(field('Name'));
      expect(within(card('General')).getByRole('alert').textContent).toMatch('needs a name');
      fireEvent.change(field('Name'), { target: { value: 'loom' } });
      expect(within(card('General')).queryByRole('alert')).toBeNull();

      fireEvent.change(field('Avatar'), { target: { value: 'ABC' } });
      fireEvent.blur(field('Avatar'));
      expect(within(card('General')).getByRole('alert').textContent).toMatch('at most 2 characters');
      expect(edits(main)).toEqual([]);
    });

    it('saves a colour as soon as it is picked', async () => {
      const main = openProjects(new FakeMain({ projects: [project('loom')] }));

      fireEvent.click(within(card('General')).getByRole('radio', { name: 'Violet' }));

      await waitFor(() => expect(edits(main)).toEqual([{ id: 1, color: 'violet' }]));
      expect((within(card('General')).getByRole('radio', { name: 'Violet' }) as HTMLInputElement).checked).toBe(true);
    });

    it('saves an avatar, and goes back to the initials when it is emptied', async () => {
      const main = openProjects(new FakeMain({ projects: [project('loom')] }));
      expect(field('Avatar').placeholder).toBe('LO');

      fireEvent.change(field('Avatar'), { target: { value: '🦊' } });
      fireEvent.submit(field('Avatar'));
      await waitFor(() => expect(edits(main)).toEqual([{ id: 1, avatar: '🦊' }]));

      fireEvent.change(field('Avatar'), { target: { value: '' } });
      fireEvent.submit(field('Avatar'));
      await waitFor(() => expect(edits(main)).toEqual([{ id: 1, avatar: '🦊' }, { id: 1, avatar: null }]));
    });

    it("saves a default model and its Effort level, and goes back to OpenCode's own", async () => {
      const main = new FakeMain({ projects: [project('loom')] }, { 'projects.models': () => [{ id: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'high', 'default'] }] });
      openProjects(main);
      const sessions = card('New Sessions');

      fireEvent.click(within(sessions).getByRole('button', { name: 'Model' }));
      fireEvent.click(await screen.findByRole('option', { name: /claude-haiku-5-5/ }));
      await waitFor(() => expect(edits(main)).toEqual([{ id: 1, defaultModel: { model: 'anthropic/claude-haiku-5-5' } }]));
      fireEvent.click(within(sessions).getByRole('button', { name: 'Effort' }));
      fireEvent.click(screen.getByRole('option', { name: 'Effort: high' }));
      await waitFor(() => expect(edits(main)).toContainEqual({ id: 1, defaultModel: { model: 'anthropic/claude-haiku-5-5', effort: 'high' } }));

      fireEvent.click(within(sessions).getByRole('button', { name: "Use OpenCode's own" }));
      await waitFor(() => expect(edits(main)).toContainEqual({ id: 1, defaultModel: null }));
      expect(within(sessions).queryByRole('button', { name: "Use OpenCode's own" })).toBeNull();
    });

    it("sets a default branch over git's, says why one is refused, and goes back to git's when emptied", async () => {
      const main = openProjects(new FakeMain({ projects: [project('loom')] }));
      expect(field('Default branch').placeholder).toBe("git's own");

      fireEvent.change(field('Default branch'), { target: { value: 'feat..x' } });
      fireEvent.blur(field('Default branch'));
      expect(within(card('New Sessions')).getByRole('alert').textContent).toMatch("can't be a default branch");
      expect(edits(main)).toEqual([]);

      fireEvent.change(field('Default branch'), { target: { value: ' origin/develop ' } });
      fireEvent.submit(field('Default branch'));
      await waitFor(() => expect(edits(main)).toEqual([{ id: 1, defaultBranch: 'develop' }]));
      await waitFor(() => expect(field('Default branch').value).toBe('develop'));

      fireEvent.change(field('Default branch'), { target: { value: '' } });
      fireEvent.submit(field('Default branch'));
      await waitFor(() => expect(edits(main)).toContainEqual({ id: 1, defaultBranch: null }));
    });

    it("shows main's error, keeping what was typed", async () => {
      openProjects(
        new FakeMain(
          { projects: [project('loom')] },
          {
            'projects.edit': () => {
              throw new Error('database is locked');
            },
          },
        ),
      );

      fireEvent.change(field('Name'), { target: { value: 'Loom app' } });
      fireEvent.submit(field('Name'));

      expect((await within(card('General')).findByRole('alert')).textContent).toMatch('database is locked');
      expect(field('Name').value).toBe('Loom app');
    });

    it('puts the saved value back on Escape, without saving', () => {
      const main = openProjects(new FakeMain({ projects: [project('loom')] }));

      fireEvent.change(field('Name'), { target: { value: 'Loom app' } });
      fireEvent.keyDown(field('Name'), { key: 'Escape' });

      expect(field('Name').value).toBe('loom');
      expect(screen.getByRole('dialog', { name: 'Projects' })).toBeTruthy();
      fireEvent.blur(field('Name'));
      expect(edits(main)).toEqual([]);
    });
  });

  it("doesn't list Projects in the Inbox when they have no Sessions", () => {
    renderApp(new FakeMain({ projects: [project('billing-api', {}, 1), project('loom', {}, 2)] }));

    const inbox = screen.getByRole('complementary', { name: 'Inbox' });
    expect(within(inbox).queryByText('billing-api')).toBeNull();
    expect(within(inbox).getByText('Nothing needs you right now.')).toBeTruthy();
  });
});

describe('the + menu', () => {
  const linked: Project = {
    id: 1,
    name: 'loom',
    color: 'blue',
    branchPrefix: 'loom',
    checkout: { environmentId: 'native', path: '/home/dev/code/loom' },
    forge: { state: 'no-remote', checking: false },
  };

  function openMenu(main: FakeMain) {
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    return main;
  }

  it('adds a Project, then shows Projects', async () => {
    const main = openMenu(new FakeMain({}, { 'dialogs.chooseFolder': () => '/home/dev/code/loom', 'projects.link': () => linked }));

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a Project…' }));

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: '/home/dev/code/loom', environmentId: 'native' } }));
    expect(screen.getByRole('dialog', { name: 'Projects' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('says on Projects why the folder was rejected', async () => {
    openMenu(
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

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a Project…' }));

    const page = screen.getByRole('dialog', { name: 'Projects' });
    expect((await within(page).findByRole('alert')).textContent).toMatch('/home/dev/notes is not a git repository');
  });

  it('closes on Escape', () => {
    openMenu(new FakeMain());
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'New' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when clicking elsewhere', () => {
    openMenu(new FakeMain());

    fireEvent.mouseDown(screen.getByRole('region', { name: 'Welcome' }));

    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Settings: editor and terminal', () => {
  const field = (main: FakeMain, name: string) => {
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    settingsPage('Editor and terminal');
    return screen.getByRole('textbox', { name }) as HTMLInputElement;
  };

  it('shows the editor command, code by default, and saves a new one', async () => {
    const main = new FakeMain();
    const input = field(main, 'Editor command');
    expect(input.value).toBe('code');

    fireEvent.change(input, { target: { value: 'zed' } });
    fireEvent.blur(input);

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'settings.setEditorCommand')).toEqual([{ command: 'settings.setEditorCommand', params: { editorCommand: 'zed' } }]));
  });

  it('saves the terminal command, empty by default, and shows a rejection', async () => {
    const main = new FakeMain(
      {},
      {
        'settings.setTerminalCommand': () => {
          throw new Error('"wt -d "{path}" has an unclosed quote');
        },
      },
    );
    const input = field(main, 'Terminal command');
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: 'wt -d "{path}' } });
    fireEvent.submit(input);

    expect((await screen.findByRole('alert')).textContent).toContain('unclosed quote');
  });
});

describe('Settings: stuck Sessions', () => {
  const field = (main: FakeMain) => {
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    settingsPage('Sessions');
    return screen.getByRole('textbox', { name: 'Stuck after (minutes)' }) as HTMLInputElement;
  };

  it('shows how many minutes without a word make a Session stuck, 15 by default, and saves a new number', async () => {
    const main = new FakeMain();
    const input = field(main);
    expect(input.value).toBe('15');

    fireEvent.change(input, { target: { value: ' 30 ' } });
    fireEvent.submit(input);
    fireEvent.blur(input);

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'settings.setStuckAfterMinutes')).toEqual([{ command: 'settings.setStuckAfterMinutes', params: { minutes: 30 } }]));
    expect(input.value).toBe('30');
  });

  it('says why a number was refused', async () => {
    const input = field(
      new FakeMain({}, {
        'settings.setStuckAfterMinutes': () => {
          throw new Error('A Session is stuck after a whole number of minutes, at least 1.');
        },
      }),
    );

    fireEvent.change(input, { target: { value: 'soon' } });
    fireEvent.submit(input);

    expect((await screen.findByRole('alert')).textContent).toContain('a whole number of minutes');
  });
});

describe('Settings: sections, search and feedback', () => {
  const openSettings = (main = new FakeMain()) => {
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    return main;
  };
  const sections = () => within(screen.getByRole('navigation', { name: 'Settings sections' })).queryAllByRole('link');
  const sectionNames = () => sections().map((link) => link.textContent);
  const search = (query: string) => fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: query } });
  /** The setting row holding the named control. */
  const rowOf = (control: HTMLElement) => control.closest('.setting') as HTMLElement;

  const currentPage = () => sections().filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent);
  const pageHeadings = () => within(screen.getByRole('dialog', { name: 'Settings' })).getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

  it('gives each section a page of its own, listed beside it, the first one shown', () => {
    openSettings();

    expect(sectionNames()).toEqual(['Appearance', 'Dates and times', 'Sessions', 'Notifications', 'Approvals', 'Worktrees', 'Editor and terminal', 'Changes', 'Keybindings', 'Environments']);
    expect(pageHeadings()).toEqual(['Appearance']);
    expect(currentPage()).toEqual(['Appearance']);
    expect(screen.queryByRole('textbox', { name: 'Worktree root' })).toBeNull();
  });

  it('goes to the page picked in the list', () => {
    openSettings();

    fireEvent.click(sections().find((link) => link.textContent === 'Editor and terminal')!);

    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Editor and terminal' }));
    expect(pageHeadings()).toEqual(['Editor and terminal']);
    expect(currentPage()).toEqual(['Editor and terminal']);
  });

  it('shows what the search finds in every section on one page, and a section picked then shows all of it', () => {
    openSettings();

    search('terminal');
    expect(pageHeadings()).toEqual(['Appearance', 'Editor and terminal', 'Keybindings']);
    expect(currentPage()).toEqual([]);

    fireEvent.click(sections().find((link) => link.textContent === 'Appearance')!);
    expect((screen.getByRole('searchbox', { name: 'Search settings' }) as HTMLInputElement).value).toBe('');
    expect(pageHeadings()).toEqual(['Appearance']);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
  });

  it('finds a setting by its name or what it does, keeping only its section, and clears on Escape', () => {
    openSettings();

    search('terminal');
    expect(sectionNames()).toEqual(['Appearance', 'Editor and terminal', 'Keybindings']);
    expect(screen.getByRole('button', { name: 'Monospace font' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Worktree root' })).toBeNull();

    search('stuck');
    expect(sectionNames()).toEqual(['Sessions', 'Notifications']);
    expect(screen.getByRole('textbox', { name: 'Stuck after (minutes)' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Auto-prompt new Sessions' })).toBeNull();

    search('sudo approvals');
    expect(screen.getByRole('button', { name: 'sudo and global installs' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'MCP and extension tools' })).toBeNull();

    // A section's own name finds all of it.
    search('appearance');
    expect(['UI font', 'Monospace font', 'Font size', 'Density'].map((name) => !!screen.queryByRole('button', { name }))).toEqual([true, true, true, true]);
    expect(['Theme', 'Accent colour'].map((name) => !!screen.queryByRole('radiogroup', { name }))).toEqual([true, true]);

    search('nothing like this');
    expect(sections()).toEqual([]);
    expect(screen.getByText(/No setting matches “nothing like this”/)).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search settings' }), { key: 'Escape' });
    expect(sections()).toHaveLength(10);
  });

  it('says Saved once main kept a change', async () => {
    openSettings();
    settingsPage('Editor and terminal');
    const input = screen.getByRole('textbox', { name: 'Editor command' }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'zed' } });
    fireEvent.submit(input);

    expect((await within(rowOf(input)).findByRole('status')).textContent).toBe('Saved');
  });

  it('says Saved for a picked option or a ticked box', async () => {
    openSettings();

    fireEvent.click(screen.getByRole('button', { name: 'UI font' }));
    fireEvent.click(within(screen.getByRole('listbox', { name: 'UI font' })).getByRole('option', { name: 'Figtree' }));
    await waitFor(() => expect(within(rowOf(screen.getByRole('button', { name: 'UI font' }))).getByRole('status').textContent).toBe('Saved'));

    settingsPage('Sessions');
    const box = screen.getByRole('checkbox', { name: 'Auto-prompt new Sessions' });
    fireEvent.click(box);
    await waitFor(() => expect(within(rowOf(box)).getByRole('status').textContent).toBe('Saved'));
  });

  it('forgets a refusal once the field holds the saved value again, and Escape puts it back', async () => {
    const main = openSettings(
      new FakeMain({}, {
        'settings.setStuckAfterMinutes': ({ minutes }) => {
          if (minutes < 1) throw new Error('A Session is stuck after a whole number of minutes, at least 1.');
          return main.value('settings');
        },
      }),
    );
    settingsPage('Sessions');
    const input = screen.getByRole('textbox', { name: 'Stuck after (minutes)' }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.submit(input);
    await screen.findByRole('alert');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(input, { target: { value: '15' } });
    fireEvent.blur(input);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();

    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.submit(input);
    await screen.findByRole('alert');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('15');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the patterns collapsed in the diff one a line, all of them, and saves them', async () => {
    const main = openSettings();
    settingsPage('Changes');
    const field = screen.getByRole('textbox', { name: 'Collapsed in the diff' }) as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.value.split('\n')).toEqual(main.value('settings').diffCollapsedPatterns);

    fireEvent.change(field, { target: { value: '*.lock\ndist/**' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'settings.setDiffCollapsedPatterns').map((i) => i.params)).toEqual([{ patterns: ['*.lock', 'dist/**'] }]));
  });

  it("gives the terminal command an example for the Environment's system", () => {
    openSettings(new FakeMain({ environments: [{ ...connectedNative, bridge: { ...connectedNative.bridge!, os: 'windows' } }] }));
    settingsPage('Editor and terminal');

    expect(screen.getByRole('textbox', { name: 'Terminal command' }).getAttribute('placeholder')).toBe('For example: wt -d {path}');
  });
});
