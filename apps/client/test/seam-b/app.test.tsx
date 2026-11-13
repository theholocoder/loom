import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { AgentStatus, EnvironmentStatus, ForgeStatus, Project } from '../../src/shared/api';
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

describe('Settings: worktrees', () => {
  const openSettings = (main: FakeMain) => {
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
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

  it('shows a checkout with no origin remote as local only, muted, with why on hover', () => {
    openProjects(new FakeMain({ environments: [connectedNative], projects: [project('notes', { state: 'no-remote', kind: undefined, host: undefined })] }));

    const row = screen.getByRole('row', { name: /notes/ });
    const local = within(row).getByText('Local only').parentElement!;
    expect(local.className).toMatch('fg-local');
    expect(local.getAttribute('title')).toMatch(/no origin remote/);
    expect(within(row).queryByRole('alert')).toBeNull();
    expect(within(row).queryByText('off')).toBeNull();
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

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: '/home/dev/code/loom' } }));
  });

  it('links nothing when the folder picker is cancelled', async () => {
    const main = openProjects(new FakeMain({}, { 'dialogs.chooseFolder': () => null }));

    fireEvent.click(addProjectButton());

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

    const remove = within(screen.getByRole('row', { name: /loom/ })).getByRole('button', { name: 'Remove loom' });
    expect(remove.textContent).toBe('Remove');
    expect(remove.getAttribute('title')).toBe('Remove loom');
  });

  it('saves a new branch prefix', async () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));
    const input = screen.getByRole('textbox', { name: 'Branch prefix for loom' });

    fireEvent.change(input, { target: { value: 'feat' } });
    fireEvent.submit(input);

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.setBranchPrefix', params: { id: 1, branchPrefix: 'feat' } }));
  });

  it('saves a branch prefix once when Enter is followed by leaving the field', async () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));
    const input = screen.getByRole('textbox', { name: 'Branch prefix for loom' });

    fireEvent.change(input, { target: { value: 'feat' } });
    fireEvent.submit(input);
    fireEvent.blur(input);

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'projects.setBranchPrefix')).toHaveLength(1));
  });

  it('previews the branches a prefix makes, without the trailing / Loom adds itself', () => {
    openProjects(new FakeMain({ projects: [project('loom')] }));
    const row = screen.getByRole('row', { name: /loom/ });
    expect(within(row).getByText('loom/<session>')).toBeTruthy();

    fireEvent.change(within(row).getByRole('textbox', { name: 'Branch prefix for loom' }), { target: { value: 'feat/' } });

    expect(within(row).getByText('feat/<session>')).toBeTruthy();
  });

  it('saves a branch prefix typed with a trailing /', async () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));
    const input = screen.getByRole('textbox', { name: 'Branch prefix for loom' });

    fireEvent.change(input, { target: { value: 'feat/' } });
    fireEvent.submit(input);

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.setBranchPrefix', params: { id: 1, branchPrefix: 'feat/' } }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an invalid branch prefix in the field, saying why, until it is fixed', () => {
    const main = openProjects(new FakeMain({ projects: [project('loom')] }));
    const input = screen.getByRole('textbox', { name: 'Branch prefix for loom' }) as HTMLInputElement;

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
    const input = screen.getByRole('textbox', { name: 'Branch prefix for loom' });

    fireEvent.change(input, { target: { value: 'feat' } });
    fireEvent.submit(input);

    expect((await screen.findByRole('alert')).textContent).toMatch('database is locked');
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

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: '/home/dev/code/loom' } }));
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

  it('groups the settings in sections, listed beside them, the first one current', () => {
    openSettings();

    expect(sectionNames()).toEqual(['Appearance', 'Sessions', 'Notifications', 'Approvals', 'Worktrees', 'Editor and terminal', 'Changes', 'Environments']);
    expect(within(screen.getByRole('dialog', { name: 'Settings' })).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(sectionNames());
    expect(sections().filter((link) => link.getAttribute('aria-current') === 'true').map((link) => link.textContent)).toEqual(['Appearance']);
    const worktrees = screen.getByRole('region', { name: 'Worktrees' });
    expect(within(worktrees).getByRole('textbox', { name: 'Worktree root' })).toBeTruthy();
  });

  it('goes to the section picked in the list', () => {
    openSettings();

    fireEvent.click(sections().find((link) => link.textContent === 'Editor and terminal')!);

    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Editor and terminal' }));
    expect(sections().filter((link) => link.getAttribute('aria-current') === 'true').map((link) => link.textContent)).toEqual(['Editor and terminal']);
  });

  it('finds a setting by its name or what it does, keeping only its section, and clears on Escape', () => {
    openSettings();

    search('terminal');
    expect(sectionNames()).toEqual(['Appearance', 'Editor and terminal']);
    expect(screen.getByRole('button', { name: 'Monospace font' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Theme' })).toBeNull();
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
    expect(['Theme', 'UI font', 'Monospace font'].map((name) => !!screen.queryByRole('button', { name }))).toEqual([true, true, true]);

    search('nothing like this');
    expect(sections()).toEqual([]);
    expect(screen.getByText(/No setting matches “nothing like this”/)).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search settings' }), { key: 'Escape' });
    expect(sections()).toHaveLength(8);
  });

  it('says Saved once main kept a change', async () => {
    openSettings();
    const input = screen.getByRole('textbox', { name: 'Editor command' }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'zed' } });
    fireEvent.submit(input);

    expect((await within(rowOf(input)).findByRole('status')).textContent).toBe('Saved');
  });

  it('says Saved for a picked option or a ticked box', async () => {
    openSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Theme' })).getByRole('option', { name: 'Nord' }));
    const box = screen.getByRole('checkbox', { name: 'Auto-prompt new Sessions' });
    fireEvent.click(box);

    await waitFor(() => expect(within(rowOf(screen.getByRole('button', { name: 'Theme' }))).getByRole('status').textContent).toBe('Saved'));
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
    const field = screen.getByRole('textbox', { name: 'Collapsed in the diff' }) as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.value.split('\n')).toEqual(main.value('settings').diffCollapsedPatterns);

    fireEvent.change(field, { target: { value: '*.lock\ndist/**' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'settings.setDiffCollapsedPatterns').map((i) => i.params)).toEqual([{ patterns: ['*.lock', 'dist/**'] }]));
  });

  it("gives the terminal command an example for the Environment's system", () => {
    openSettings(new FakeMain({ environments: [{ ...connectedNative, bridge: { ...connectedNative.bridge!, os: 'windows' } }] }));

    expect(screen.getByRole('textbox', { name: 'Terminal command' }).getAttribute('placeholder')).toBe('For example: wt -d {path}');
  });
});
