import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session } from '../../src/shared/api';
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

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};

const working: Session = {
  id: 7,
  projectId: 1,
  title: 'Say hello',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'working',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};
const finished: Session = { ...working, status: 'waiting', waitingReason: 'finished' };
const inWorktree: Session = {
  ...finished,
  id: 8,
  title: 'Fix the login bug',
  workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/billing-api/login' },
  branch: 'loom/login',
};

function startNewSession() {
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
  // With Projects, the Project picker comes first: take the highlighted one.
  const filter = screen.queryByRole('combobox', { name: 'Filter Projects' });
  if (filter) fireEvent.keyDown(filter, { key: 'Enter' });
  return screen.getByRole('main', { name: 'New Session' });
}

/** Opens the Session from the sidebar. */
function open(main: FakeMain, session: Session) {
  if (session.status === 'working') fireEvent.click(screen.getByRole('button', { name: 'Working' }));
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  return main;
}

describe('starting a Session', () => {
  const branches = {
    defaultBase: { name: 'trunk', remote: true },
    bases: [
      ...['feature/login', 'release/1.2', 'trunk'].map((name) => ({ name, remote: true })),
      { name: 'loom/spike', remote: false },
    ],
    // origin/trunk is checked out locally, so only offered as a base.
    existing: [
      { name: 'loom/spike', remote: false },
      { name: 'feature/login', remote: true },
      { name: 'release/1.2', remote: true },
    ],
    worktrees: [
      { path: '/home/dev/loom-worktrees/49', branch: 'feat/49-cards' },
      { path: '/home/dev/loom-worktrees/scratch' },
    ],
  };

  it("branches the new worktree from origin's default unless another branch is picked", async () => {
    const main = renderApp(new FakeMain({ projects: [project] }, { 'projects.branches': () => branches, 'sessions.create': () => inWorktree }));
    const pane = startNewSession();
    const base = within(pane).getByRole('button', { name: 'Branch from' });
    await waitFor(() => expect(base.textContent).toBe('origin/trunk'));
    expect(main.invoked.filter((i) => i.command === 'projects.branches')).toEqual([{ command: 'projects.branches', params: { id: 1 } }]);

    fireEvent.click(base);
    const choices = within(screen.getByRole('listbox', { name: 'Branches' })).getAllByRole('option');
    expect(choices.map((o) => [o.textContent, o.getAttribute('aria-selected')])).toEqual([
      ['origin/feature/login', 'false'],
      ['origin/release/1.2', 'false'],
      ['origin/trunk', 'true'],
      ['loom/spike', 'false'],
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'origin/release/1.2' }));
    expect(base.textContent).toBe('origin/release/1.2');
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Backport the fix' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([
        { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', base: { name: 'release/1.2', remote: true }, approvalMode: 'supervised', prompt: 'Backport the fix' } },
      ]),
    );
  });

  it('picks the first branch the search shows on Enter', async () => {
    renderApp(new FakeMain({ projects: [project] }, { 'projects.branches': () => branches }));
    const pane = startNewSession();
    const base = within(pane).getByRole('button', { name: 'Branch from' });
    await waitFor(() => expect(base.textContent).toBe('origin/trunk'));

    fireEvent.click(base);
    const search = screen.getByRole('textbox', { name: 'Search branches' });
    fireEvent.change(search, { target: { value: 'release' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(base.textContent).toBe('origin/release/1.2');
    expect(screen.queryByRole('listbox', { name: 'Branches' })).toBeNull();
  });

  it('works in an existing worktree, or a branch no worktree has in a new one, searchable, naming no new branch', async () => {
    const main = renderApp(new FakeMain({ projects: [project] }, { 'projects.branches': () => branches, 'sessions.create': () => inWorktree }));
    const pane = startNewSession();
    fireEvent.click(within(pane).getByRole('button', { name: 'Working copy' }));
    fireEvent.click(screen.getByRole('option', { name: 'Existing worktree' }));

    expect(within(pane).queryByRole('textbox', { name: 'Branch' })).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Branch from' })).toBeNull();
    const picker = within(pane).getByRole('button', { name: 'Worktree' });
    expect(picker.textContent).toBe('Pick a worktree');
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Carry on' } });
    expect((within(pane).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'projects.branches')).toHaveLength(1));
    fireEvent.click(picker);
    // Listed again on opening, so worktrees and branches other Sessions took since don't show.
    expect(main.invoked.filter((i) => i.command === 'projects.branches')).toHaveLength(2);
    const listbox = await screen.findByRole('listbox', { name: 'Worktrees' });
    await waitFor(() =>
      expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'feat/49-cards',
        'detached HEAD',
        'loom/spikenew worktree',
        'origin/feature/loginnew worktree',
        'origin/release/1.2new worktree',
      ]),
    );
    const search = screen.getByRole('textbox', { name: 'Search worktrees' });
    fireEvent.change(search, { target: { value: 'LOGIN' } });
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['origin/feature/loginnew worktree']);
    fireEvent.change(search, { target: { value: '49-cards' } });
    fireEvent.click(within(listbox).getByRole('option'));
    expect(picker.textContent).toBe('feat/49-cards');
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.create')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
    const filter = screen.queryByRole('combobox', { name: 'Filter Projects' });
    if (filter) fireEvent.keyDown(filter, { key: 'Enter' });
    const again = screen.getByRole('main', { name: 'New Session' });
    fireEvent.click(within(again).getByRole('button', { name: 'Working copy' }));
    fireEvent.click(screen.getByRole('option', { name: 'Existing worktree' }));
    fireEvent.click(within(again).getByRole('button', { name: 'Worktree' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search worktrees' }), { target: { value: 'login' } });
    fireEvent.click(await screen.findByRole('option'));
    fireEvent.change(within(again).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Carry on' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([
        { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', existing: { worktree: '/home/dev/loom-worktrees/49' }, approvalMode: 'supervised', prompt: 'Carry on' } },
        { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', existing: { branch: { name: 'feature/login', remote: true } }, approvalMode: 'supervised', prompt: 'Carry on' } },
      ]),
    );
  });

  it("shows why the branches couldn't be listed", async () => {
    renderApp(
      new FakeMain({ projects: [project] }, {
        'projects.branches': () => {
          throw new Error("Couldn't list the branches: not a git repository");
        },
      }),
    );
    const pane = startNewSession();

    fireEvent.click(within(pane).getByRole('button', { name: 'Branch from' }));

    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't list the branches: not a git repository");
  });

  it("says quietly when origin couldn't be refreshed, by the branch pickers, and lists again on Retry", async () => {
    let fetchError: string | undefined = "Couldn't fetch origin: Could not resolve host: github.com";
    const main = renderApp(
      new FakeMain({ projects: [project] }, {
        'projects.branches': () => ({ defaultBase: { name: 'main', remote: false }, bases: [{ name: 'main', remote: false }], existing: [], worktrees: [], ...(fetchError && { fetchError }) }),
      }),
    );
    const pane = startNewSession();
    const composer = within(within(pane).getByRole('form', { name: 'Composer' }));

    const note = await composer.findByRole('status');
    expect(note.textContent).toBe("Couldn't refresh origin, using what's here.Retry");
    expect(note.getAttribute('title')).toBe(fetchError);
    expect(within(pane).getByRole('button', { name: 'Branch from' }).textContent).toBe('main');
    expect(within(pane).queryByRole('alert')).toBeNull();

    fetchError = undefined;
    fireEvent.click(within(note).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(composer.queryByRole('status')).toBeNull());
    expect(main.invoked.filter((i) => i.command === 'projects.branches')).toHaveLength(2);
  });

  it("defaults to a new worktree, also offering an existing worktree or the checkout's branch, with OpenCode as the agent", async () => {
    renderApp(new FakeMain({ projects: [project] }, { 'projects.branches': () => ({ ...branches, checkoutBranch: 'trunk' }) }));

    const pane = startNewSession();

    const workingCopy = within(pane).getByRole('button', { name: 'Working copy' });
    expect(workingCopy.textContent).toBe('New worktree');
    await waitFor(() => expect(within(pane).getByRole('button', { name: 'Branch from' }).textContent).toBe('origin/trunk'));
    fireEvent.click(workingCopy);
    const choices = within(screen.getByRole('listbox', { name: 'Working copy' })).getAllByRole('option');
    expect(choices.map((o) => [o.textContent, o.getAttribute('aria-selected')])).toEqual([
      ['New worktree', 'true'],
      ['Existing worktree', 'false'],
      ['Stay on trunk', 'false'],
    ]);
    expect(within(pane).getByTitle('Agent').textContent).toBe('OpenCode');
    expect(within(pane).getByRole('button', { name: 'Project' }).textContent).toBe(project.name);
  });

  it('offers no existing worktree when there is none to work in, nor a branch for one', async () => {
    renderApp(new FakeMain({ projects: [project] }, { 'projects.branches': () => ({ defaultBase: { name: 'main', remote: true }, bases: [{ name: 'main', remote: true }], existing: [], worktrees: [] }) }));
    const pane = startNewSession();
    await waitFor(() => expect(within(pane).getByRole('button', { name: 'Branch from' }).textContent).toBe('origin/main'));

    fireEvent.click(within(pane).getByRole('button', { name: 'Working copy' }));

    // A detached checkout has no branch to name.
    expect(within(screen.getByRole('listbox', { name: 'Working copy' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['New worktree', 'Stay on current branch']);
  });

  it('says to pick a worktree while the prompt waits for one', () => {
    renderApp(new FakeMain({ projects: [project] }, { 'projects.branches': () => branches }));
    const pane = startNewSession();

    fireEvent.click(within(pane).getByRole('button', { name: 'Working copy' }));
    fireEvent.click(screen.getByRole('option', { name: 'Existing worktree' }));

    const prompt = within(pane).getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
    expect(prompt.disabled).toBe(true);
    expect(prompt.placeholder).toBe('Pick the worktree to work in first.');
  });

  it('starts a checkout Session with the prompt, then shows it', async () => {
    const main = renderApp(
      new FakeMain({ projects: [project] }, {
        'sessions.create': () => {
          main.publish('sessions', [working]);
          return working;
        },
      }),
    );
    const pane = startNewSession();

    fireEvent.click(within(pane).getByRole('button', { name: 'Working copy' }));
    fireEvent.click(screen.getByRole('option', { name: 'Stay on current branch' }));
    expect(within(pane).queryByRole('textbox', { name: 'Branch' })).toBeNull();
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Say hello' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('main', { name: 'Session' })).toBeTruthy());
    expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([
      { command: 'sessions.create', params: { projectId: 1, workingCopy: 'checkout', approvalMode: 'supervised', prompt: 'Say hello' } },
    ]);
    expect(screen.getByRole('heading', { name: 'Say hello' })).toBeTruthy();
  });

  it("suggests the new worktree's branch from the prompt, and starts it with the branch as edited", async () => {
    const main = renderApp(
      new FakeMain({ projects: [project] }, {
        'sessions.create': () => {
          main.publish('sessions', [inWorktree]);
          return inWorktree;
        },
      }),
    );
    const pane = startNewSession();
    const branch = () => within(pane).getByRole('textbox', { name: 'Branch' }) as HTMLInputElement;
    const prompt = within(pane).getByRole('textbox', { name: 'Prompt' });

    expect(branch().placeholder).toBe('loom/…');
    fireEvent.change(prompt, { target: { value: 'Fix the login bug!' } });
    expect(branch().value).toBe('loom/fix-the-login-bug');

    fireEvent.change(branch(), { target: { value: 'loom/login' } });
    fireEvent.change(prompt, { target: { value: 'Fix the login bug, please' } });
    expect(branch().value).toBe('loom/login');
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('main', { name: 'Session' })).toBeTruthy());
    expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([
      { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', branch: 'loom/login', approvalMode: 'supervised', prompt: 'Fix the login bug, please' } },
    ]);
  });

  it("says as it is typed that git wouldn't take the branch name, holding Send back until it would", () => {
    const main = renderApp(new FakeMain({ projects: [project] }, { 'sessions.create': () => inWorktree }));
    const pane = startNewSession();
    const prompt = within(pane).getByRole('textbox', { name: 'Prompt' });
    const branch = within(pane).getByRole('textbox', { name: 'Branch' });
    const send = within(pane).getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    fireEvent.change(prompt, { target: { value: 'Fix the login bug' } });

    fireEvent.change(branch, { target: { value: 'loom/login bug' } });

    const alert = within(pane).getByRole('alert');
    expect(alert.textContent).toBe(`"loom/login bug" can't be a branch name: it contains a space, a control character or one of ~ ^ : ? * [ \\`);
    expect(branch.getAttribute('aria-invalid')).toBe('true');
    expect(branch.getAttribute('aria-describedby')).toBe(alert.id);
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(prompt, { key: 'Enter' });
    expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([]);

    fireEvent.change(branch, { target: { value: 'loom/login.' } });
    expect(within(pane).getByRole('alert').textContent).toBe(`"loom/login." can't be a branch name: it ends with '.'`);

    fireEvent.change(branch, { target: { value: 'loom/login' } });
    expect(within(pane).queryByRole('alert')).toBeNull();
    expect(branch.getAttribute('aria-invalid')).toBeNull();
    expect(send.disabled).toBe(false);
  });

  it('starts in the default Approval mode from Settings, and with the mode picked', async () => {
    const main = renderApp(new FakeMain({ projects: [project], settings: { ...DEFAULT_SETTINGS, approvalModeDefault: 'full' } }, { 'sessions.create': () => inWorktree }));
    const pane = startNewSession();
    const picker = () => within(pane).getByRole('button', { name: 'Approvals' });
    expect(picker().textContent).toContain('Full access');

    fireEvent.click(picker());
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Approvals' })).getByRole('option', { name: 'Supervised' }));
    expect(picker().textContent).toContain('Supervised');
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Fix the login bug' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.create').map((i) => (i.params as { approvalMode?: string }).approvalMode)).toEqual(['supervised']));
  });

  it('leaves the branch to main when the user did not edit it', async () => {
    const main = renderApp(new FakeMain({ projects: [project] }, { 'sessions.create': () => inWorktree }));
    const pane = startNewSession();

    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Fix the login bug' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([
        { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', approvalMode: 'supervised', prompt: 'Fix the login bug' } },
      ]),
    );
  });

  it('says why a Session could not start', async () => {
    renderApp(
      new FakeMain({ projects: [project] }, {
        'sessions.create': () => {
          throw new Error('Native is not connected');
        },
      }),
    );
    const pane = startNewSession();

    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Go' } });
    fireEvent.keyDown(within(pane).getByRole('textbox', { name: 'Prompt' }), { key: 'Enter' });

    // By the composer's controls, not at the top of the pane.
    expect((await within(within(pane).getByRole('form', { name: 'Composer' })).findByRole('alert')).textContent).toBe('Native is not connected');
  });

  it('puts the focus in the prompt, once the Project is picked', () => {
    renderApp(new FakeMain({ projects: [project] }));

    const pane = startNewSession();

    expect(document.activeElement).toBe(within(pane).getByRole('textbox', { name: 'Prompt' }));
  });

  it("drops why the last Project's Session couldn't start once another Project is picked, the focus back in the prompt", async () => {
    const other: Project = { ...project, id: 2, name: 'web-shop', checkout: { environmentId: 'native', path: '/home/dev/web-shop' } };
    renderApp(
      new FakeMain({ projects: [project, other] }, {
        'sessions.create': () => {
          throw new Error("Couldn't fetch origin: Could not resolve host: github.com");
        },
      }),
    );
    const pane = startNewSession();
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Go' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await within(pane).findByRole('alert');

    fireEvent.click(within(pane).getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByRole('option', { name: 'web-shop' }));

    expect(within(pane).queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(within(pane).getByRole('textbox', { name: 'Prompt' }));
  });

  it('goes back to where it was started from on Cancel, or on Esc once no picker is open and nothing is typed', () => {
    open(renderApp(new FakeMain({ projects: [project], sessions: [finished] })), finished);

    fireEvent.click(within(startNewSession()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('main', { name: 'New Session' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Say hello' })).toBeTruthy();

    const pane = startNewSession();
    fireEvent.click(within(pane).getByRole('button', { name: 'Working copy' }));
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Working copy' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Working copy' })).toBeNull();
    expect(screen.getByRole('main', { name: 'New Session' })).toBe(pane);

    // Esc doesn't throw away what was typed; Cancel would.
    const prompt = within(pane).getByRole('textbox', { name: 'Prompt' });
    fireEvent.change(prompt, { target: { value: 'Half a thought' } });
    fireEvent.keyDown(prompt, { key: 'Escape' });
    expect(screen.getByRole('main', { name: 'New Session' })).toBe(pane);
    fireEvent.change(prompt, { target: { value: '' } });

    fireEvent.keyDown(prompt, { key: 'Escape' });
    expect(screen.queryByRole('main', { name: 'New Session' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Say hello' })).toBeTruthy();
  });

  it('goes back to the view it was started from, such as Settings', () => {
    renderApp(new FakeMain({ projects: [project] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    startNewSession();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByRole('main', { name: 'New Session' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
  });

  it('asks for a Project first when there is none', () => {
    renderApp(new FakeMain());

    const pane = startNewSession();

    expect(within(pane).getByText('Add a Project before starting a Session.')).toBeTruthy();
    expect(within(pane).queryByRole('textbox', { name: 'Prompt' })).toBeNull();
  });
});

/** The Session details popover, opening it with Ctrl+I if it isn't open. */
function info(): HTMLElement {
  if (!screen.queryByRole('dialog', { name: 'Session details' })) fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
  return screen.getByRole('dialog', { name: 'Session details' });
}

/** The Session header's ⋯ menu, opening it if it isn't open. */
function sessionMenu(): HTMLElement {
  if (!screen.queryByRole('menu', { name: 'Session actions' })) fireEvent.click(within(screen.getByRole('region', { name: 'Session header' })).getByRole('button', { name: 'More actions' }));
  return screen.getByRole('menu', { name: 'Session actions' });
}

describe('a Session', () => {
  it('shows its Project in its header, its branch under it, the rest in Session details', () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [inWorktree] })), inWorktree);
    const header = () => screen.getByRole('region', { name: 'Session header' });
    const glance = () => screen.getByRole('group', { name: 'Session at a glance' });

    expect(within(header()).getByText('billing-api')).toBeTruthy();
    expect(header().textContent).not.toContain('loom/login');
    expect(within(glance()).getByText('loom/login')).toBeTruthy();
    expect(within(header()).queryByText('acme/billing-api')).toBeNull();
    const where = within(info()).getByRole('region', { name: 'Where' });
    expect(within(where).getByText('acme/billing-api')).toBeTruthy();
    expect(within(where).getByText('worktree')).toBeTruthy();
    expect(within(where).getByText('/home/dev/loom/worktrees/billing-api/login')).toBeTruthy();

    act(() => main.publish('sessions', [{ ...inWorktree, branch: 'loom/login-v2' }]));
    expect(within(glance()).getByText('loom/login-v2')).toBeTruthy();
  });

  it('archives from its ⋯ menu, which an archived Session no longer offers', async () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [inWorktree] })), inWorktree);

    fireEvent.click(within(sessionMenu()).getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.archive')).toEqual([{ command: 'sessions.archive', params: { id: inWorktree.id } }]));

    act(() => main.publish('sessions', [{ ...inWorktree, status: 'archived', waitingReason: undefined }]));
    expect((within(sessionMenu()).getByRole('menuitem', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(sessionMenu(), { key: 'Escape' });
    // Its Project is still there, so a new message reopens it.
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('Reply to OpenCode… @ to mention a file');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('can only be archived when its worktree is missing', () => {
    const missing = { ...inWorktree, worktreeMissing: true };
    open(renderApp(new FakeMain({ projects: [project], sessions: [missing] })), missing);

    expect(within(screen.getByRole('region', { name: 'Session header' })).getByRole('status', { name: 'Worktree missing' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'More' } });
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe("This Session's worktree is missing; it can only be archived.");
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(sessionMenu()).getByRole('menuitem', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the user as bubbles and streams the agent reply', () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [working] })), working);
    const chat = () => screen.getByRole('log', { name: 'Conversation' });

    act(() => main.publish('transcript', [{ kind: 'user', id: 1, text: 'Say hello' }], { sessionId: 7 }));
    expect(within(chat()).getByText('Say hello').closest('.msg')?.className).toContain('user');

    act(() =>
      main.publish(
        'transcript',
        [
          { kind: 'user', id: 1, text: 'Say hello' },
          { kind: 'agent', id: 2, text: 'Hello', streaming: true },
        ],
        { sessionId: 7 },
      ),
    );
    act(() =>
      main.publish(
        'transcript',
        [
          { kind: 'user', id: 1, text: 'Say hello' },
          { kind: 'agent', id: 2, text: 'Hello, world', streaming: true },
        ],
        { sessionId: 7 },
      ),
    );
    const reply = within(chat()).getByText('Hello, world').closest('.msg')!;
    expect(reply.className).toContain('agent');
    expect(within(reply as HTMLElement).getByText('OpenCode')).toBeTruthy();
  });

  it('keeps showing the conversation where scrolling returns a promise, as in Electron', () => {
    // Electron's Chromium resolves scrollIntoView with a promise; jsdom has none.
    const scroll = vi.fn(() => Promise.resolve());
    Element.prototype.scrollIntoView = scroll as unknown as Element['scrollIntoView'];
    try {
      const main = open(renderApp(new FakeMain({ projects: [project], sessions: [working] })), working);
      act(() => main.publish('transcript', [{ kind: 'user', id: 1, text: 'Say hello' }], { sessionId: 7 }));
      act(() => main.publish('transcript', [{ kind: 'user', id: 1, text: 'Say hello' }, { kind: 'agent', id: 2, text: 'Hello', streaming: true }], { sessionId: 7 }));

      expect(within(screen.getByRole('log', { name: 'Conversation' })).getByText('Hello')).toBeTruthy();
      expect(scroll).toHaveBeenCalled();
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it('queues a message sent while Working, and offers Stop', async () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [working] })), working);

    expect(screen.getByRole('status', { name: 'Session status' }).textContent).toBe('Working');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Prompt' }).getAttribute('placeholder')).toBe('Queue a message for when OpenCode finishes…');
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Then add tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.send')).toEqual([{ command: 'sessions.send', params: { id: 7, prompt: 'Then add tests' } }]));
    expect((screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.stop')).toEqual([{ command: 'sessions.stop', params: { id: 7 } }]));
  });

  it('empties the prompt on Enter, before main answers, so what is typed next stays apart', async () => {
    let answer!: () => void;
    const main = open(
      renderApp(new FakeMain({ projects: [project], sessions: [working] }, { 'sessions.send': () => new Promise<void>((resolve) => (answer = resolve)) })),
      working,
    );
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;

    fireEvent.change(prompt, { target: { value: 'Also update the README' } });
    fireEvent.keyDown(prompt, { key: 'Enter' });

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.send')).toHaveLength(1));
    expect(prompt.value).toBe('');
    fireEvent.change(prompt, { target: { value: 'And bump the version' } });
    await act(async () => answer());
    expect(prompt.value).toBe('And bump the version');
  });

  it('puts the message back in the prompt when sending it fails, before what was typed since', async () => {
    let fail!: (error: Error) => void;
    open(
      renderApp(new FakeMain({ projects: [project], sessions: [working] }, { 'sessions.send': () => new Promise<void>((_, reject) => (fail = reject)) })),
      working,
    );
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;

    fireEvent.change(prompt, { target: { value: 'Also update the README' } });
    fireEvent.keyDown(prompt, { key: 'Enter' });
    await waitFor(() => expect(prompt.value).toBe(''));
    fireEvent.change(prompt, { target: { value: 'And bump the version' } });
    await act(async () => fail(new Error('Native is not connected')));

    expect(prompt.value).toBe('Also update the README\nAnd bump the version');
    expect(screen.getByRole('alert').textContent).toBe('Native is not connected');
  });

  describe('as the queue grows', () => {
    /**
     * The conversation's scroll, which jsdom doesn't lay out: `scrolledTo` as
     * the user scrolled it, its content 1000px tall in a view `height` tall.
     */
    function scrollable(scrolledTo: number) {
      const chat = screen.getByRole('log', { name: 'Conversation' });
      const view = { height: 300, top: scrolledTo };
      Object.defineProperty(chat, 'scrollHeight', { configurable: true, get: () => 1000 });
      Object.defineProperty(chat, 'clientHeight', { configurable: true, get: () => view.height });
      Object.defineProperty(chat, 'scrollTop', { configurable: true, get: () => view.top, set: (top: number) => (view.top = top) });
      fireEvent.scroll(chat);
      return view;
    }

    it('keeps the conversation at its foot when the user was there, the queue taking room from it', () => {
      const main = open(renderApp(new FakeMain({ projects: [project], sessions: [working] })), working);
      const view = scrollable(700);

      // The queue on the composer leaves the conversation less height.
      view.height = 240;
      act(() => main.publish('sessions', [{ ...working, queue: [{ id: 3, text: 'Then add tests' }] }]));

      expect(view.top).toBe(760);
    });

    it('leaves the conversation where it was when the user had scrolled up', () => {
      const main = open(renderApp(new FakeMain({ projects: [project], sessions: [working] })), working);
      const view = scrollable(200);

      view.height = 240;
      act(() => main.publish('sessions', [{ ...working, queue: [{ id: 3, text: 'Then add tests' }] }]));

      expect(view.top).toBe(200);
    });
  });

  it('lists the queue, each message with Remove and Send now', async () => {
    const queuedUp: Session = { ...working, queue: [{ id: 3, text: 'Then add tests' }, { id: 4, text: 'And update the docs' }] };
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [queuedUp] })), queuedUp);

    const queue = screen.getByRole('list', { name: 'Queued messages' });
    const items = within(queue).getAllByRole('listitem');
    expect(items.map((i) => within(i).getByText(/Then|And/).textContent)).toEqual(['Then add tests', 'And update the docs']);
    expect(within(items[0]!).queryByRole('button', { name: 'Steer' })).toBeNull();

    fireEvent.click(within(items[1]!).getByRole('button', { name: 'Send now' }));
    fireEvent.click(within(items[0]!).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command === 'sessions.sendNow' || i.command === 'sessions.removeQueued')).toEqual([
        { command: 'sessions.sendNow', params: { id: 7, queuedId: 4 } },
        { command: 'sessions.removeQueued', params: { id: 7, queuedId: 3 } },
      ]),
    );
  });

  it('edits a queued message in place: Enter saves, Escape leaves it as it was', async () => {
    const queuedUp: Session = { ...working, queue: [{ id: 3, text: 'Then add tests' }, { id: 4, text: 'And update the docs' }] };
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [queuedUp] })), queuedUp);
    const items = () => within(screen.getByRole('list', { name: 'Queued messages' })).getAllByRole('listitem');

    fireEvent.click(within(items()[1]!).getByRole('button', { name: 'Edit' }));
    const editor = within(items()[1]!).getByRole('textbox', { name: 'Queued message' }) as HTMLTextAreaElement;
    expect(editor.value).toBe('And update the docs');
    expect(document.activeElement).toBe(editor);
    fireEvent.change(editor, { target: { value: 'And update the README' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command === 'sessions.editQueued')).toEqual([{ command: 'sessions.editQueued', params: { id: 7, queuedId: 4, text: 'And update the README' } }]),
    );
    expect(within(items()[1]!).queryByRole('textbox', { name: 'Queued message' })).toBeNull();

    fireEvent.click(within(items()[0]!).getByRole('button', { name: 'Edit' }));
    const other = within(items()[0]!).getByRole('textbox', { name: 'Queued message' });
    fireEvent.change(other, { target: { value: 'Never mind' } });
    fireEvent.keyDown(other, { key: 'Escape' });

    expect(within(items()[0]!).queryByRole('textbox', { name: 'Queued message' })).toBeNull();
    expect(within(items()[0]!).getByText('Then add tests')).toBeTruthy();
    expect(main.invoked.filter((i) => i.command === 'sessions.editQueued')).toHaveLength(1);
  });

  it("keeps the edit open, saying why, when main won't take it", async () => {
    const queuedUp: Session = { ...working, queue: [{ id: 3, text: 'Then add tests' }] };
    open(
      renderApp(
        new FakeMain(
          { projects: [project], sessions: [queuedUp] },
          {
            'sessions.editQueued': () => {
              throw new Error('There is no such queued message.');
            },
          },
        ),
      ),
      queuedUp,
    );
    const item = () => within(screen.getByRole('list', { name: 'Queued messages' })).getByRole('listitem');

    fireEvent.click(within(item()).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(item()).getByRole('textbox', { name: 'Queued message' }), { target: { value: 'Then add more tests' } });
    fireEvent.click(within(item()).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('There is no such queued message.'));
    expect((within(item()).getByRole('textbox', { name: 'Queued message' }) as HTMLTextAreaElement).value).toBe('Then add more tests');
  });

  it('says so when the message being edited is sent before the edit is saved', () => {
    const queuedUp: Session = { ...working, queue: [{ id: 3, text: 'Then add tests' }, { id: 4, text: 'And update the docs' }] };
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [queuedUp] })), queuedUp);
    const queue = () => screen.getByRole('list', { name: 'Queued messages' });

    fireEvent.click(within(within(queue()).getAllByRole('listitem')[0]!).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(queue()).getByRole('textbox', { name: 'Queued message' }), { target: { value: 'Then add more tests' } });
    act(() => main.publish('sessions', [{ ...queuedUp, queue: [{ id: 4, text: 'And update the docs' }] }]));

    expect(within(queue()).queryByRole('textbox', { name: 'Queued message' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('The queued message was sent before your edit was saved.');
  });

  it('offers Steer instead of Send now when the agent can be steered', async () => {
    const steerable: Session = { ...working, canSteer: true, queue: [{ id: 3, text: 'Then add tests' }] };
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [steerable] })), steerable);

    const item = within(screen.getByRole('list', { name: 'Queued messages' })).getByRole('listitem');
    expect(within(item).queryByRole('button', { name: 'Send now' })).toBeNull();
    fireEvent.click(within(item).getByRole('button', { name: 'Steer' }));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.steer')).toEqual([{ command: 'sessions.steer', params: { id: 7, queuedId: 3 } }]));
  });

  it('keeps showing the queue once stopped, with Send now and no Stop', () => {
    const stopped: Session = { ...working, status: 'waiting', waitingReason: 'stopped', canSteer: true, queue: [{ id: 3, text: 'Then add tests' }] };
    open(renderApp(new FakeMain({ projects: [project], sessions: [stopped] })), stopped);

    expect(screen.getByRole('status', { name: 'Session status' }).textContent).toBe('Stopped');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    // Nothing runs to steer: Send now sends it as the reply.
    expect(within(screen.getByRole('list', { name: 'Queued messages' })).getByRole('button', { name: 'Send now' })).toBeTruthy();
  });

  it('shows where the user interrupted the run', () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [working] })), working);

    act(() =>
      main.publish(
        'transcript',
        [
          { kind: 'user', id: 0, text: 'Say hello' },
          { kind: 'interruption', id: 1, by: 'send-now' },
          { kind: 'user', id: 2, text: 'Say goodbye instead' },
          { kind: 'interruption', id: 3, by: 'stop' },
        ],
        { sessionId: 7 },
      ),
    );

    const marks = within(screen.getByRole('log', { name: 'Conversation' })).getAllByRole('note');
    expect(marks.map((m) => m.textContent)).toEqual(['Interrupted to send a queued message', 'Stopped']);
  });

  it('offers Continue on a run Loom quit during, until the Session moves on', async () => {
    const interrupted: Session = { ...working, status: 'waiting', waitingReason: 'interrupted' };
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [interrupted] })), interrupted);
    const transcript = [
      { kind: 'user' as const, id: 0, text: 'Say hello' },
      { kind: 'agent' as const, id: 1, text: 'Hel', streaming: false },
      { kind: 'interruption' as const, id: 2, by: 'quit' as const },
    ];
    act(() => main.publish('transcript', transcript, { sessionId: 7 }));
    const chat = within(screen.getByRole('log', { name: 'Conversation' }));

    expect(chat.getByRole('note').textContent).toContain('Loom quit or crashed during this run');
    fireEvent.click(chat.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.continue')).toEqual([{ command: 'sessions.continue', params: { id: 7 } }]));
    act(() => main.publish('sessions', [{ ...interrupted, status: 'working', waitingReason: undefined }]));
    expect(chat.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('offers Continue on the Stopped note that ends the conversation', async () => {
    const stopped: Session = { ...working, status: 'waiting', waitingReason: 'stopped' };
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [stopped] })), stopped);
    act(() =>
      main.publish(
        'transcript',
        [
          { kind: 'user', id: 0, text: 'Say hello' },
          { kind: 'agent', id: 1, text: 'Hel', streaming: false },
          { kind: 'interruption', id: 2, by: 'stop' },
        ],
        { sessionId: 7 },
      ),
    );
    const note = within(screen.getByRole('log', { name: 'Conversation' })).getByRole('note');

    expect(note.textContent).toContain('Stopped');
    fireEvent.click(within(note).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.continue')).toEqual([{ command: 'sessions.continue', params: { id: 7 } }]));
  });

  it('offers Continue, not Retry, on an error partway through the answer', async () => {
    const failed: Session = { ...working, status: 'waiting', waitingReason: 'error', error: 'Provider overloaded' };
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [failed] })), failed);
    act(() =>
      main.publish(
        'transcript',
        [
          { kind: 'user', id: 0, text: 'Say hello' },
          { kind: 'agent', id: 1, text: 'Hel', streaming: false },
          { kind: 'error', id: 2, message: 'Provider overloaded' },
        ],
        { sessionId: 7 },
      ),
    );
    const chat = within(screen.getByRole('log', { name: 'Conversation' }));

    expect(chat.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(chat.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.continue')).toEqual([{ command: 'sessions.continue', params: { id: 7 } }]));
  });

  it('sends a reply once the agent has finished', async () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [finished] })), finished);
    expect(screen.getByRole('status', { name: 'Session status' }).textContent).toBe('Finished');

    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Now say goodbye' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.send')).toEqual([{ command: 'sessions.send', params: { id: 7, prompt: 'Now say goodbye' } }]));
    expect((screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the error a failed run ended with', () => {
    const failed: Session = { ...working, status: 'waiting', waitingReason: 'error', error: 'Insufficient credits' };
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [failed] })), failed);

    act(() =>
      main.publish(
        'transcript',
        [
          { kind: 'user', id: 1, text: 'Say hello' },
          { kind: 'error', id: 2, message: 'Insufficient credits' },
        ],
        { sessionId: 7 },
      ),
    );

    expect(screen.getByRole('status', { name: 'Session status' }).textContent).toBe('Error');
    expect(within(screen.getByRole('log', { name: 'Conversation' })).getByRole('alert').textContent).toContain('Insufficient credits');
  });

  it('shows why it is Waiting on an error when its conversation is not loaded', () => {
    const failed: Session = { ...working, status: 'waiting', waitingReason: 'error', error: 'Insufficient credits' };
    open(renderApp(new FakeMain({ projects: [project], sessions: [failed] })), failed);

    expect(within(screen.getByRole('log', { name: 'Conversation' })).getByRole('alert').textContent).toContain('Insufficient credits');
  });

  it('is listed in the Inbox while Waiting, and under Working while Working', () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [finished] }));
    const inbox = screen.getByRole('complementary', { name: 'Inbox' });
    expect(within(inbox).getByRole('button', { name: 'Say hello' })).toBeTruthy();

    act(() => main.publish('sessions', [working]));
    expect(within(inbox).queryByRole('button', { name: 'Say hello' })).toBeNull();
    fireEvent.click(within(inbox).getByRole('button', { name: 'Working' }));
    expect(within(inbox).getByRole('button', { name: 'Say hello' })).toBeTruthy();
  });
});

describe('open in editor and terminal', () => {
  const header = info;

  it("opens the Session's working copy in the editor and in a terminal from Session details", async () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [finished] })), finished);

    fireEvent.click(within(header()).getByRole('button', { name: 'Open in editor' }));
    fireEvent.click(within(header()).getByRole('button', { name: 'Open in terminal' }));

    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command.startsWith('sessions.openIn'))).toEqual([
        { command: 'sessions.openInEditor', params: { id: 7 } },
        { command: 'sessions.openInTerminal', params: { id: 7 } },
      ]),
    );
  });

  it("shows why the editor didn't open", async () => {
    const main = new FakeMain(
      { projects: [project], sessions: [finished] },
      {
        'sessions.openInEditor': () => {
          throw new Error("code isn't installed in Native, or isn't on your shell's PATH. Check the editor command in Settings.");
        },
      },
    );
    open(renderApp(main), finished);

    fireEvent.click(within(header()).getByRole('button', { name: 'Open in editor' }));

    // A toast, in view however far up the conversation is scrolled: not at its foot.
    const toast = await screen.findByRole('group', { name: 'What went wrong' });
    expect(within(toast).getByRole('alert').textContent).toContain("code isn't installed in Native");
    expect(within(screen.getByRole('log', { name: 'Conversation' })).queryByRole('alert')).toBeNull();
  });

  it('drops the open actions once the Session is archived', () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [finished] })), finished);
    expect(within(header()).getByRole('button', { name: 'Open in editor' })).toBeTruthy();

    act(() => main.publish('sessions', [{ ...finished, status: 'archived' }]));

    expect(within(header()).queryByRole('button', { name: 'Open in editor' })).toBeNull();
    expect(within(header()).queryByRole('button', { name: 'Open in terminal' })).toBeNull();
  });
});
