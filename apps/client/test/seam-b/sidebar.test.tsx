import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session, type SidebarSettings } from '../../src/shared/api';
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
};

function fakeMain(sidebar: Partial<SidebarSettings> = {}, sessions: Session[] = [session]) {
  return new FakeMain({ projects: [project], sessions, settings: { ...DEFAULT_SETTINGS, sidebar: { ...DEFAULT_SETTINGS.sidebar, ...sidebar } } });
}

function renderApp(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const openSession = (title = session.title) => fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: title }));
const header = () => screen.getByRole('region', { name: 'Session header' });
const sidebar = () => screen.queryByRole('complementary', { name: 'Session sidebar' });
const sidebarCalls = (main: FakeMain) => main.invoked.filter((c) => c.command === 'settings.setSidebar').map((c) => c.params);

describe('the right sidebar', () => {
  it('is opened and closed by one plain icon at the end of the Session header, and kept in settings', () => {
    const main = renderApp(fakeMain());
    openSession();
    const toggle = within(header()).getByRole('button', { name: 'Show sidebar' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('');
    expect(sidebar()).toBeNull();

    fireEvent.click(toggle);
    expect(sidebar()).toBeTruthy();
    expect(within(header()).getByRole('button', { name: 'Hide sidebar' }).getAttribute('aria-expanded')).toBe('true');
    expect(sidebarCalls(main)).toEqual([{ open: true }]);

    fireEvent.click(within(header()).getByRole('button', { name: 'Hide sidebar' }));
    expect(sidebar()).toBeNull();
    expect(sidebarCalls(main)).toEqual([{ open: true }, { open: false }]);
  });

  it('goes back to what settings hold when they refuse a change', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session], settings: DEFAULT_SETTINGS }, {
      'settings.setSidebar': () => {
        throw new Error('database is locked');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderApp(main);
    openSession();
    fireEvent.click(within(header()).getByRole('button', { name: 'Show sidebar' }));
    await waitFor(() => expect(sidebar()).toBeNull());
    vi.restoreAllMocks();
  });

  it('is hidden altogether while no Session is selected, even when left open', () => {
    renderApp(fakeMain({ open: true }));
    expect(sidebar()).toBeNull();
    openSession();
    expect(sidebar()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(sidebar()).toBeNull();
  });
});

const tab = (name: string) => within(sidebar()!).getByRole('tab', { name });
const view = () => within(sidebar()!).getByRole('tabpanel');
/** The shown view's name, as its tab gives it. */
const viewName = () => document.getElementById(view().getAttribute('aria-labelledby')!)!.getAttribute('aria-label');
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...init });

describe("the sidebar's views", () => {
  it('shows one view at a time, picked by the tab icons in its header, remembered app-wide', () => {
    const main = renderApp(fakeMain({ open: true }));
    openSession();
    expect(tab('Session info').getAttribute('aria-selected')).toBe('true');
    expect(viewName()).toBe('Session info');

    fireEvent.click(tab('Changes'));
    expect(tab('Changes').getAttribute('aria-selected')).toBe('true');
    expect(tab('Session info').getAttribute('aria-selected')).toBe('false');
    expect(viewName()).toBe('Changes');
    expect(within(view()).queryByRole('region', { name: 'Where' })).toBeNull();
    expect(sidebarCalls(main)).toEqual([{ open: true, view: 'changes' }]);
  });

  it('has its tabs as one Tab stop, the arrow keys moving between them', () => {
    renderApp(fakeMain({ open: true }));
    openSession();
    expect(tab('Session info').tabIndex).toBe(0);
    expect(tab('Changes').tabIndex).toBe(-1);
    fireEvent.keyDown(tab('Session info'), { key: 'ArrowRight' });
    expect(viewName()).toBe('Changes');
    expect(document.activeElement).toBe(tab('Changes'));
    expect(tab('Changes').tabIndex).toBe(0);
    fireEvent.keyDown(tab('Changes'), { key: 'ArrowRight' });
    expect(viewName()).toBe('Session info');
    expect(screen.getByRole('tabpanel', { name: 'Session info' })).toBeTruthy();
  });

  it('opens on the view, open state and width settings had, at startup', () => {
    renderApp(fakeMain({ open: true, view: 'changes', width: 555 }));
    openSession();
    expect(viewName()).toBe('Changes');
    expect(sidebar()!.style.width).toBe('555px');
  });

  it('is resized by dragging its left edge, within its minimum and maximum, the width kept once let go', () => {
    const main = renderApp(fakeMain({ open: true, width: 420 }));
    openSession();
    const edge = within(sidebar()!).getByRole('separator', { name: 'Resize sidebar' });
    fireEvent.mouseDown(edge, { clientX: 1000 });
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(sidebar()!.style.width).toBe('520px');
    expect(sidebarCalls(main)).toEqual([]);
    fireEvent.mouseUp(window, { clientX: 880 });
    expect(sidebar()!.style.width).toBe('540px');
    expect(sidebarCalls(main)).toEqual([{ width: 540 }]);

    fireEvent.mouseDown(edge, { clientX: 1000 });
    fireEvent.mouseUp(window, { clientX: 1900 });
    expect(sidebarCalls(main).at(-1)).toEqual({ width: 280 });
    // The same width for every view.
    fireEvent.click(tab('Changes'));
    expect(sidebar()!.style.width).toBe('280px');
  });

  it('takes at most 70% of the window, however wide settings say, dragging from what shows', () => {
    // jsdom's window is 1024px wide.
    const main = renderApp(fakeMain({ open: true, width: 1000 }));
    openSession();
    expect(sidebar()!.style.width).toBe('716px');
    const edge = within(sidebar()!).getByRole('separator', { name: 'Resize sidebar' });
    expect(edge.getAttribute('aria-valuemax')).toBe('716');
    fireEvent.mouseDown(edge, { clientX: 500 });
    fireEvent.mouseUp(window, { clientX: 600 });
    expect(sidebarCalls(main)).toEqual([{ width: 616 }]);
  });

  it('keeps a drag going through an unrelated settings change', () => {
    const main = renderApp(fakeMain({ open: true, width: 420 }));
    openSession();
    const edge = within(sidebar()!).getByRole('separator', { name: 'Resize sidebar' });
    fireEvent.mouseDown(edge, { clientX: 1000 });
    fireEvent.mouseMove(window, { clientX: 900 });
    act(() => main.publish('settings', { ...main.value('settings'), theme: 'nord' }));
    expect(sidebar()!.style.width).toBe('520px');
    fireEvent.mouseUp(window, { clientX: 900 });
  });

  it('is resized with the arrow keys on its edge too', () => {
    const main = renderApp(fakeMain({ open: true, width: 420 }));
    openSession();
    const edge = within(sidebar()!).getByRole('separator', { name: 'Resize sidebar' });
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(edge.getAttribute('aria-valuenow')).toBe('444');
    expect(sidebarCalls(main)).toEqual([{ width: 444 }]);
  });
});

describe("the sidebar's shortcuts", () => {
  it('toggles on its last view with Ctrl+B, and d and Ctrl+I open a view, closing it when already on it', () => {
    const main = renderApp(fakeMain({ view: 'changes' }));
    openSession();
    press('b', { ctrlKey: true });
    expect(viewName()).toBe('Changes');
    press('b', { ctrlKey: true });
    expect(sidebar()).toBeNull();

    press('i', { ctrlKey: true });
    expect(viewName()).toBe('Session info');
    press('d');
    expect(viewName()).toBe('Changes');
    press('d');
    expect(sidebar()).toBeNull();
    press('i', { ctrlKey: true });
    press('i', { ctrlKey: true });
    expect(sidebar()).toBeNull();
    expect(sidebarCalls(main)).toEqual([{ open: true }, { open: false }, { open: true, view: 'info' }, { open: true, view: 'changes' }, { open: false }, { open: true, view: 'info' }, { open: false }]);
  });

  it('does nothing while no Session is selected', () => {
    const main = renderApp(fakeMain());
    press('b', { ctrlKey: true });
    press('d');
    press('i', { ctrlKey: true });
    expect(sidebarCalls(main)).toEqual([]);
    openSession();
    expect(sidebar()).toBeNull();
  });

  it('are in the palette while a Session is open, and in the shortcut list', () => {
    renderApp(fakeMain());
    press('k', { ctrlKey: true });
    const names = () => within(screen.getByRole('dialog', { name: 'Command palette' })).queryAllByRole('option').map((o) => o.getAttribute('aria-label'));
    expect(names()).not.toContain('Toggle sidebar');
    press('k', { ctrlKey: true });
    openSession();
    press('k', { ctrlKey: true });
    expect(names()).toEqual(expect.arrayContaining(['Toggle sidebar', 'Toggle diff', 'Toggle Session info']));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole('option', { name: 'Toggle Session info' }));
    expect(viewName()).toBe('Session info');

    press('?', { ctrlKey: true });
    const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const [label, keys] of [['Toggle sidebar', 'Ctrl B'], ['Toggle diff', 'D'], ['Toggle Session info', 'Ctrl I']]) {
      expect(within(help).getByRole('row', { name: new RegExp(`^${label} ${keys}$`) })).toBeTruthy();
    }
  });
});

describe('the slimmer Session header', () => {
  it('shows only the crumb (Project · branch), title, status and the sidebar icon', () => {
    renderApp(
      fakeMain({}, [
        { ...session, issue: { number: 31, url: 'https://github.com/acme/billing-api/issues/31' }, mergeRequest: { number: 40, url: 'https://github.com/acme/billing-api/pull/40' }, diffStat: { files: 4, added: 12, removed: 3 } },
      ]),
    );
    openSession();
    const h = header();
    expect(h.querySelector('.crumb')!.textContent).toBe('billing-api·loom/fix-login');
    expect(within(h).getByRole('heading').textContent).toBe('Fix login');
    expect(within(h).getByRole('status', { name: 'Session status' }).textContent).toBe('Finished');
    expect(within(h).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Show sidebar']);
    expect(h.textContent).not.toContain('acme/billing-api');
    expect(h.textContent).not.toContain('#31');
    expect(h.textContent).not.toContain('worktree');
  });

  it('keeps the worktree-missing warning, and Archive keeps its palette entry and e', async () => {
    const main = renderApp(fakeMain({}, [{ ...session, worktreeMissing: true }]));
    openSession();
    expect(within(header()).getByRole('status', { name: 'Worktree missing' })).toBeTruthy();
    press('e');
    await waitFor(() => expect(main.invoked.map((c) => c.command)).toContain('sessions.archive'));
  });
});

const group = (name: string) => within(view()).getByRole('region', { name });
/** The value a fact in `g` shows, by its name. */
const fact = (g: HTMLElement, name: string) => {
  const term = within(g).getAllByRole('term').find((t) => t.textContent === name);
  if (!term) throw new Error(`no fact ${name}`);
  return term.nextElementSibling as HTMLElement;
};
const value = (g: HTMLElement, name: string) => fact(g, name).querySelector('.value')!.textContent;

const native = { id: 'native', label: 'Native', state: 'connected' as const, bridge: { protocolVersion: 1, version: '0.1.0', os: 'linux', arch: 'x64', home: '/home/dev' } };
const full: Session = {
  ...session,
  agentSessionId: 'ses_abc123',
  issue: { number: 31, url: 'https://github.com/acme/billing-api/issues/31' },
  mergeRequest: { number: 40, url: 'https://github.com/acme/billing-api/pull/40' },
  mergeRequestState: 'open',
  diffStat: { files: 4, added: 1210, removed: 3 },
  model: 'anthropic/claude-sonnet-5-5',
  effort: 'high',
  queue: [
    { id: 1, text: 'And the tests' },
    { id: 2, text: 'And the docs' },
  ],
  context: { used: 50_000, size: 200_000 },
  usage: { tokens: 125_000, reportedCost: 1.234, workingMs: 6 * 60_000 + 40_000 },
};

function renderInfo(s: Session = full, handlers: ConstructorParameters<typeof FakeMain>[1] = {}) {
  const main = new FakeMain({ projects: [project], sessions: [s], environments: [native], settings: { ...DEFAULT_SETTINGS, sidebar: { open: true, view: 'info', width: 420 } } }, handlers);
  renderApp(main);
  if (s.status === 'archived') fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: 'Archived' }));
  openSession(s.title);
  return main;
}

describe('the Session info view', () => {
  it('shows four fixed groups, Where, Git, Agent and Usage', () => {
    renderInfo();
    expect(within(view()).getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Where', 'Git', 'Agent', 'Usage']);
    expect(within(view()).queryAllByRole('button', { expanded: false }).filter((b) => b.closest('h3'))).toEqual([]);
  });

  it('shows where the Session works, copying the path, opening the editor and the terminal', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const main = renderInfo();
    const where = group('Where');
    expect(value(where, 'Project')).toBe('billing-apiacme/billing-api');
    expect(value(where, 'Environment')).toBe('Native (Linux)');
    expect(value(where, 'Working copy')).toBe('worktree');
    expect(value(where, 'Path')).toBe('/home/dev/loom/worktrees/billing-api/fix-login');
    fireEvent.click(within(fact(where, 'Path')).getByRole('button', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith('/home/dev/loom/worktrees/billing-api/fix-login');
    expect(await within(fact(where, 'Path')).findByRole('button', { name: 'Copied' })).toBeTruthy();

    fireEvent.click(within(where).getByRole('button', { name: 'Open in editor' }));
    fireEvent.click(within(where).getByRole('button', { name: 'Open in terminal' }));
    expect(main.invoked.filter((c) => c.command.startsWith('sessions.openIn'))).toEqual([
      { command: 'sessions.openInEditor', params: { id: 7 } },
      { command: 'sessions.openInTerminal', params: { id: 7 } },
    ]);
  });

  it("shows its git state: branch, issue, Merge request with its actions, and the diff stat opening Changes", async () => {
    const main = renderInfo();
    const git = group('Git');
    expect(value(git, 'Branch')).toBe('loom/fix-login');
    fireEvent.click(within(fact(git, 'Issue')).getByRole('button', { name: '#31' }));
    expect(value(git, 'Merge request')).toBe('#40open');
    fireEvent.click(within(git).getByRole('button', { name: 'Open Merge request #40' }));
    expect(main.invoked.filter((c) => c.command === 'links.open').map((c) => c.params)).toEqual([
      { url: 'https://github.com/acme/billing-api/issues/31' },
      { url: 'https://github.com/acme/billing-api/pull/40' },
    ]);
    fireEvent.click(within(git).getByRole('button', { name: 'Update Merge request' }));
    expect(main.invoked).toContainEqual({ command: 'sessions.requestMergeRequest', params: { id: 7 } });

    fireEvent.click(within(git).getByRole('button', { name: 'Link Merge request' }));
    fireEvent.change(within(screen.getByRole('dialog', { name: 'Link Merge request' })).getByRole('textbox'), { target: { value: '41' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Link Merge request' })).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Link Merge request' })).toBeNull());
    expect(main.invoked).toContainEqual({ command: 'sessions.linkMergeRequest', params: { id: 7, mergeRequest: '41' } });

    fireEvent.click(within(git).getByRole('button', { name: 'Show changes: 4 files, 1210 added, 3 removed' }));
    expect(viewName()).toBe('Changes');
  });

  it('offers to create a Merge request when none is linked', () => {
    const main = renderInfo({ ...full, mergeRequest: undefined, mergeRequestState: undefined });
    const git = group('Git');
    expect(value(git, 'Merge request')).toBe('None');
    fireEvent.click(within(git).getByRole('button', { name: 'Create Merge request' }));
    expect(main.invoked).toContainEqual({ command: 'sessions.requestMergeRequest', params: { id: 7 } });
  });

  it('opens Link Merge request from the palette, opening Session info first', () => {
    const main = new FakeMain({ projects: [project], sessions: [full], settings: DEFAULT_SETTINGS });
    renderApp(main);
    openSession();
    expect(sidebar()).toBeNull();
    press('k', { ctrlKey: true });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole('option', { name: 'Link Merge request…' }));
    expect(viewName()).toBe('Session info');
    expect(screen.getByRole('dialog', { name: 'Link Merge request' })).toBeTruthy();
    // Closing the sidebar drops it, and opening it again doesn't bring it back.
    fireEvent.click(within(header()).getByRole('button', { name: 'Hide sidebar' }));
    fireEvent.click(within(header()).getByRole('button', { name: 'Show sidebar' }));
    expect(screen.queryByRole('dialog', { name: 'Link Merge request' })).toBeNull();
  });

  it('shows the agent, model and Effort, its session id to copy, and the queued messages', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    renderInfo();
    const agent = group('Agent');
    expect(value(agent, 'Agent')).toBe('OpenCode');
    expect(value(agent, 'Model')).toBe('anthropic/claude-sonnet-5-5');
    expect(value(agent, 'Effort')).toBe('high');
    expect(value(agent, 'Agent session')).toBe('ses_abc123');
    fireEvent.click(within(agent).getByRole('button', { name: 'Copy agent session id' }));
    expect(writeText).toHaveBeenCalledWith('ses_abc123');
    expect(value(agent, 'Queued messages')).toBe('2');
  });

  it("shows the context used with a bar, the Session's tokens, Reported cost and Working time", () => {
    renderInfo();
    const usage = group('Usage');
    expect(value(usage, 'Context')).toBe('50k / 200k (25%)');
    expect(within(usage).getByRole('meter', { name: 'Context used' }).getAttribute('aria-valuenow')).toBe('25');
    expect(value(usage, 'Tokens')).toBe('125k');
    expect(value(usage, 'Reported cost')).toBe('$1.23');
    expect(value(usage, 'Working time')).toBe('6m 40s');
    expect(view().textContent).not.toMatch(/rate limit|previous agent/i);
  });

  it('updates live: usage, context, branch, Merge request and turn ends, the Working time counting while Working', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(100_000);
      const main = renderInfo();
      act(() => main.publish('sessions', [{ ...full, status: 'working', usage: { ...full.usage!, workingSince: 100_000 - 20_000 } }]));
      expect(value(group('Usage'), 'Working time')).toBe('7m');
      act(() => vi.advanceTimersByTime(5000));
      expect(value(group('Usage'), 'Working time')).toBe('7m 5s');

      act(() =>
        main.publish('sessions', [
          { ...full, branch: 'loom/other', mergeRequest: { number: 41, url: 'https://github.com/acme/billing-api/pull/41' }, context: { used: 100_000, size: 200_000 }, usage: { tokens: 130_000, reportedCost: 1.5, workingMs: 8 * 60_000 }, queue: undefined },
        ]),
      );
      expect(value(group('Git'), 'Branch')).toBe('loom/other');
      expect(value(group('Git'), 'Merge request')).toBe('#41open');
      expect(value(group('Usage'), 'Context')).toBe('100k / 200k (50%)');
      expect(value(group('Usage'), 'Tokens')).toBe('130k');
      expect(value(group('Usage'), 'Reported cost')).toBe('$1.50');
      expect(value(group('Usage'), 'Working time')).toBe('8m');
      expect(value(group('Agent'), 'Queued messages')).toBe('0');
    } finally {
      vi.useRealTimers();
    }
  });

  it('archives the Session', async () => {
    const main = renderInfo();
    fireEvent.click(within(view()).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'sessions.archive', params: { id: 7 } }));
  });

  it('offers no editor nor terminal when the worktree is missing, only Archive', () => {
    renderInfo({ ...full, worktreeMissing: true });
    expect(within(view()).queryByRole('button', { name: 'Open in editor' })).toBeNull();
    expect(within(view()).queryByRole('button', { name: 'Open in terminal' })).toBeNull();
    expect(within(view()).getByRole('button', { name: 'Archive' })).toBeTruthy();
  });

  it("shows an archived Session's facts read-only: no editor, terminal, Archive, nor Merge request actions", () => {
    renderInfo({ ...full, status: 'archived', mergeRequestState: 'merged' });
    expect(value(group('Git'), 'Merge request')).toBe('#40merged');
    for (const name of ['Open in editor', 'Open in terminal', 'Archive', 'Update Merge request', 'Link Merge request']) expect(within(view()).queryByRole('button', { name })).toBeNull();
    expect(within(view()).getByRole('button', { name: 'Open Merge request #40' })).toBeTruthy();
  });
});
