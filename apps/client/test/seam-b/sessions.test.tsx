import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session } from '../../src/shared/api';
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
    defaultBranch: 'trunk',
    remote: ['feature/login', 'release/1.2', 'trunk'],
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

  it("branches the new worktree from origin's default unless another origin branch is picked", async () => {
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
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'origin/release/1.2' }));
    expect(base.textContent).toBe('origin/release/1.2');
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Backport the fix' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([
        { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', base: 'release/1.2', prompt: 'Backport the fix' } },
      ]),
    );
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
        'feat/49-cards/home/dev/loom-worktrees/49',
        'detached HEAD/home/dev/loom-worktrees/scratch',
        'loom/spikenew worktree',
        'origin/feature/loginnew worktree',
        'origin/release/1.2new worktree',
      ]),
    );
    const search = screen.getByRole('textbox', { name: 'Search worktrees' });
    fireEvent.change(search, { target: { value: 'LOGIN' } });
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['origin/feature/loginnew worktree']);
    fireEvent.change(search, { target: { value: 'worktrees/49' } });
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
        { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', existing: { worktree: '/home/dev/loom-worktrees/49' }, prompt: 'Carry on' } },
        { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', existing: { branch: { name: 'feature/login', remote: true } }, prompt: 'Carry on' } },
      ]),
    );
  });

  it("shows why the branches couldn't be listed", async () => {
    renderApp(
      new FakeMain({ projects: [project] }, {
        'projects.branches': () => {
          throw new Error("Couldn't fetch origin: no network");
        },
      }),
    );
    const pane = startNewSession();

    fireEvent.click(within(pane).getByRole('button', { name: 'Branch from' }));

    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't fetch origin: no network");
  });

  it('defaults to a new worktree, also offering an existing worktree or the current branch, with OpenCode as the agent', () => {
    renderApp(new FakeMain({ projects: [project] }));

    const pane = startNewSession();

    const workingCopy = within(pane).getByRole('button', { name: 'Working copy' });
    expect(workingCopy.textContent).toBe('New worktree');
    fireEvent.click(workingCopy);
    const choices = within(screen.getByRole('listbox', { name: 'Working copy' })).getAllByRole('option');
    expect(choices.map((o) => [o.textContent, o.getAttribute('aria-selected')])).toEqual([
      ['New worktree', 'true'],
      ['Existing worktree', 'false'],
      ['Stay on current branch', 'false'],
    ]);
    expect(within(pane).getByTitle('Agent').textContent).toBe('OpenCode');
    expect(within(pane).getByRole('button', { name: 'Project' }).textContent).toBe(project.name);
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
      { command: 'sessions.create', params: { projectId: 1, workingCopy: 'checkout', prompt: 'Say hello' } },
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
      { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', branch: 'loom/login', prompt: 'Fix the login bug, please' } },
    ]);
  });

  it('leaves the branch to main when the user did not edit it', async () => {
    const main = renderApp(new FakeMain({ projects: [project] }, { 'sessions.create': () => inWorktree }));
    const pane = startNewSession();

    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Fix the login bug' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([
        { command: 'sessions.create', params: { projectId: 1, workingCopy: 'worktree', prompt: 'Fix the login bug' } },
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

    expect((await within(pane).findByRole('alert')).textContent).toBe('Native is not connected');
  });

  it('asks for a Project first when there is none', () => {
    renderApp(new FakeMain());

    const pane = startNewSession();

    expect(within(pane).getByText('Add a Project before starting a Session.')).toBeTruthy();
    expect(within(pane).queryByRole('textbox', { name: 'Prompt' })).toBeNull();
  });
});

describe('a Session', () => {
  it('shows its Project, repository, branch and working copy in its header', () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [inWorktree] })), inWorktree);
    const header = () => screen.getByRole('region', { name: 'Session header' });

    expect(within(header()).getByText('billing-api')).toBeTruthy();
    expect(within(header()).getByText('acme/billing-api')).toBeTruthy();
    expect(within(header()).getByTitle('Branch').textContent).toBe('loom/login');
    const chip = within(header()).getByText('worktree');
    expect(chip.closest('[title]')?.getAttribute('title')).toBe('/home/dev/loom/worktrees/billing-api/login');

    act(() => main.publish('sessions', [{ ...inWorktree, branch: 'loom/login-v2' }]));
    expect(within(header()).getByTitle('Branch').textContent).toBe('loom/login-v2');
  });


  it('archives from its header, which an archived Session no longer offers', async () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [inWorktree] })), inWorktree);

    fireEvent.click(within(screen.getByRole('region', { name: 'Session header' })).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.archive')).toEqual([{ command: 'sessions.archive', params: { id: inWorktree.id } }]));

    act(() => main.publish('sessions', [{ ...inWorktree, status: 'archived', waitingReason: undefined }]));
    expect(within(screen.getByRole('region', { name: 'Session header' })).queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('This Session is archived.');
  });

  it('can only be archived when its worktree is missing', () => {
    const missing = { ...inWorktree, worktreeMissing: true };
    open(renderApp(new FakeMain({ projects: [project], sessions: [missing] })), missing);

    expect(within(screen.getByRole('region', { name: 'Session header' })).getByRole('status', { name: 'Worktree missing' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'More' } });
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe("This Session's worktree is missing; it can only be archived.");
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByRole('region', { name: 'Session header' })).getByRole('button', { name: 'Archive' })).toBeTruthy();
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

  it("can't be sent a message while Working", () => {
    open(renderApp(new FakeMain({ projects: [project], sessions: [working] })), working);

    expect(screen.getByRole('status', { name: 'Session status' }).textContent).toBe('Working');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
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
  const header = () => screen.getByRole('region', { name: 'Session header' });

  it("opens the Session's working copy in the editor and in a terminal from its header", async () => {
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

    expect((await screen.findByRole('alert')).textContent).toContain("code isn't installed in Native");
  });

  it('drops the open actions once the Session is archived', () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [finished] })), finished);
    expect(within(header()).getByRole('button', { name: 'Open in editor' })).toBeTruthy();

    act(() => main.publish('sessions', [{ ...finished, status: 'archived' }]));

    expect(within(header()).queryByRole('button', { name: 'Open in editor' })).toBeNull();
    expect(within(header()).queryByRole('button', { name: 'Open in terminal' })).toBeNull();
  });
});
