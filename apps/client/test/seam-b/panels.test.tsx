import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session } from '../../src/shared/api';
import { DEFAULT_SESSION_PANELS, type LayoutSettings, type PanelAreaState, type SessionPanels } from '../../src/shared/panels';
import { FakeMain, HIDDEN_PANELS } from './fake-main';

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
const other: Session = { ...session, id: 8, title: 'Fix billing', workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/billing-api/fix-billing' } };

/** Both Panels in the Side area, Session info shown. */
const BOTH: PanelAreaState = { panels: ['info', 'changes'], shown: 'info', open: true };

/** A main where Session 7's Side area is `side` (a new Session's until given), and the Layout `layout`. */
function fakeMain({ side, layout, sessions = [session] }: { side?: Partial<PanelAreaState>; layout?: Partial<LayoutSettings>; sessions?: Session[] } = {}) {
  const main = new FakeMain({ projects: [project], sessions, settings: { ...DEFAULT_SETTINGS, layout: { ...DEFAULT_SETTINGS.layout, ...layout } } });
  if (side) main.publish('panels', { ...DEFAULT_SESSION_PANELS, side: { ...DEFAULT_SESSION_PANELS.side, ...side } }, { sessionId: session.id });
  return main;
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
const sideArea = () => screen.queryByRole('complementary', { name: 'Side area' });
/** What the renderer asked main to keep of Session `id`'s Side area. */
const kept = (main: FakeMain, id = session.id) =>
  main.invoked.filter((c) => c.command === 'sessions.setPanels' && (c.params as { id: number }).id === id).map((c) => (c.params as { panels: SessionPanels }).panels.side);
const sizes = (main: FakeMain) => main.invoked.filter((c) => c.command === 'settings.setPanelSize').map((c) => c.params);
const tab = (name: string) => within(sideArea()!).getByRole('tab', { name });
const tabNames = () => within(sideArea()!).queryAllByRole('tab').map((t) => t.getAttribute('aria-label'));
const view = () => within(sideArea()!).getByRole('tabpanel');
/** The shown Panel's name, as its tab gives it. */
const viewName = () => document.getElementById(view().getAttribute('aria-labelledby')!)!.getAttribute('aria-label');
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...init });

describe('the Side area', () => {
  it('shows Changes on a new Session, its tab labelled, with the count of files changed as its badge', () => {
    renderApp(fakeMain({ sessions: [{ ...session, diffStat: { files: 4, added: 12, removed: 3 } }] }));
    openSession();
    expect(tabNames()).toEqual(['Changes']);
    expect(viewName()).toBe('Changes');
    expect(tab('Changes').textContent).toBe('Changes4');
    expect(tab('Changes').getAttribute('aria-description')).toBe('4 files changed');
  });

  it("is shown and hidden by one plain icon at the end of the Session header, kept as the Session's own", () => {
    const main = renderApp(fakeMain({ sessions: [session, other] }));
    openSession();
    const toggle = within(header()).getByRole('button', { name: 'Hide the Side area' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('');

    fireEvent.click(toggle);
    expect(sideArea()).toBeNull();
    expect(within(header()).getByRole('button', { name: 'Show the Side area' }).getAttribute('aria-expanded')).toBe('false');
    expect(kept(main)).toEqual([{ panels: ['changes'], shown: 'changes', open: false }]);

    // Another Session has its own.
    openSession('Fix billing');
    expect(sideArea()).toBeTruthy();
    openSession();
    expect(sideArea()).toBeNull();
    fireEvent.click(within(header()).getByRole('button', { name: 'Show the Side area' }));
    expect(sideArea()).toBeTruthy();
    expect(kept(main).at(-1)).toEqual({ panels: ['changes'], shown: 'changes', open: true });
  });

  it('goes back to what main holds when it refuses a change', async () => {
    const main = new FakeMain(
      { projects: [project], sessions: [session] },
      {
        'sessions.setPanels': () => {
          throw new Error('database is locked');
        },
      },
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderApp(main);
    openSession();
    fireEvent.click(within(header()).getByRole('button', { name: 'Hide the Side area' }));
    await waitFor(() => expect(sideArea()).toBeTruthy());
    vi.restoreAllMocks();
  });

  it('is hidden altogether while no Session is selected', () => {
    renderApp(fakeMain());
    expect(sideArea()).toBeNull();
    openSession();
    expect(sideArea()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(sideArea()).toBeNull();
  });

  it('opens on the Panels, the one shown and the width main had, at startup', () => {
    renderApp(fakeMain({ side: { panels: ['changes', 'info'], shown: 'info' }, layout: { width: { info: 555 } } }));
    openSession();
    expect(tabNames()).toEqual(['Changes', 'Session info']);
    expect(viewName()).toBe('Session info');
    expect(sideArea()!.style.width).toBe('555px');
  });
});

describe("the Side area's Panels", () => {
  it('shows one at a time, picked by their tabs, kept for the Session', () => {
    const main = renderApp(fakeMain({ side: BOTH }));
    openSession();
    expect(tab('Session info').getAttribute('aria-selected')).toBe('true');
    expect(viewName()).toBe('Session info');

    fireEvent.click(tab('Changes'));
    expect(tab('Changes').getAttribute('aria-selected')).toBe('true');
    expect(tab('Session info').getAttribute('aria-selected')).toBe('false');
    expect(viewName()).toBe('Changes');
    expect(within(view()).queryByRole('region', { name: 'Where' })).toBeNull();
    expect(kept(main)).toEqual([{ ...BOTH, shown: 'changes' }]);
  });

  it('has its tabs as one Tab stop, the arrow keys moving between them', () => {
    renderApp(fakeMain({ side: BOTH }));
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

  it('adds one from the + menu, at the end, shown; one already open is only shown', () => {
    const main = renderApp(fakeMain());
    openSession();
    const add = () => {
      fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Add a Panel to the Side area' }));
      return screen.getByRole('menu', { name: 'Add a Panel to the Side area' });
    };
    expect(within(add()).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Session info', 'Changes']);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Session info' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(tabNames()).toEqual(['Changes', 'Session info']);
    expect(viewName()).toBe('Session info');

    fireEvent.click(within(add()).getByRole('menuitem', { name: 'Changes' }));
    expect(tabNames()).toEqual(['Changes', 'Session info']);
    expect(viewName()).toBe('Changes');
    expect(kept(main)).toEqual([
      { panels: ['changes', 'info'], shown: 'info', open: true },
      { panels: ['changes', 'info'], shown: 'changes', open: true },
    ]);
  });

  it('closes one with its ✕, showing its neighbour; closing the last hides the area, and d brings Changes back', () => {
    const main = renderApp(fakeMain({ side: { ...BOTH, shown: 'changes' } }));
    openSession();
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Close Changes' }));
    expect(tabNames()).toEqual(['Session info']);
    expect(viewName()).toBe('Session info');

    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Close Session info' }));
    expect(sideArea()).toBeNull();
    expect(kept(main)).toEqual([
      { panels: ['info'], shown: 'info', open: true },
      { panels: [], shown: null, open: false },
    ]);

    // Shown empty, it says how to add one.
    press('b', { ctrlKey: true });
    expect(within(sideArea()!).getByRole('tabpanel', { name: 'Side area' }).textContent).toBe('No Panels here. Add one with +.');
    press('d');
    expect(tabNames()).toEqual(['Changes']);
    expect(viewName()).toBe('Changes');
  });

  it('is hidden by its own button, as by the header icon', () => {
    renderApp(fakeMain());
    openSession();
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Hide the Side area' }));
    expect(sideArea()).toBeNull();
  });
});

describe('Panel sizes', () => {
  it("are each kind's own: dragging the left edge resizes the Panel shown, kept once let go", () => {
    const main = renderApp(fakeMain({ side: BOTH }));
    openSession();
    expect(sideArea()!.style.width).toBe('420px');
    const edge = within(sideArea()!).getByRole('separator', { name: 'Resize the Side area' });
    fireEvent.mouseDown(edge, { clientX: 1000 });
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(sideArea()!.style.width).toBe('520px');
    expect(sizes(main)).toEqual([]);
    fireEvent.mouseUp(window, { clientX: 880 });
    expect(sideArea()!.style.width).toBe('540px');
    expect(sizes(main)).toEqual([{ kind: 'info', dimension: 'width', size: 540 }]);

    // Changes keeps its own, and Session info its new one.
    fireEvent.click(tab('Changes'));
    expect(sideArea()!.style.width).toBe('640px');
    fireEvent.click(tab('Session info'));
    expect(sideArea()!.style.width).toBe('540px');

    fireEvent.mouseDown(edge, { clientX: 1000 });
    fireEvent.mouseUp(window, { clientX: 1900 });
    expect(sizes(main).at(-1)).toEqual({ kind: 'info', dimension: 'width', size: 280 });
  });

  it('leave the conversation its least width, however large the Layout says, dragging from what shows', () => {
    // A 1440px window, less the Inbox's 360px and the conversation's 360px.
    const main = renderApp(fakeMain({ layout: { width: { changes: 1000 } } }));
    openSession();
    expect(sideArea()!.style.width).toBe('720px');
    const edge = within(sideArea()!).getByRole('separator', { name: 'Resize the Side area' });
    expect(edge.getAttribute('aria-valuemax')).toBe('720');
    fireEvent.mouseDown(edge, { clientX: 500 });
    fireEvent.mouseUp(window, { clientX: 600 });
    expect(sizes(main)).toEqual([{ kind: 'changes', dimension: 'width', size: 620 }]);
    fireEvent.mouseDown(edge, { clientX: 600 });
    fireEvent.mouseUp(window, { clientX: 100 });
    expect(sizes(main).at(-1)).toEqual({ kind: 'changes', dimension: 'width', size: 720 });
  });

  it("go back to the kind's preferred size on a double click on the edge", () => {
    const main = renderApp(fakeMain({ side: BOTH, layout: { width: { info: 600 } } }));
    openSession();
    expect(sideArea()!.style.width).toBe('600px');
    fireEvent.doubleClick(within(sideArea()!).getByRole('separator', { name: 'Resize the Side area' }));
    expect(sideArea()!.style.width).toBe('420px');
    expect(sizes(main)).toEqual([{ kind: 'info', dimension: 'width', size: 420 }]);
  });

  it('keep a drag going through an unrelated settings change', () => {
    const main = renderApp(fakeMain({ side: BOTH }));
    openSession();
    const edge = within(sideArea()!).getByRole('separator', { name: 'Resize the Side area' });
    fireEvent.mouseDown(edge, { clientX: 1000 });
    fireEvent.mouseMove(window, { clientX: 900 });
    act(() => main.publish('settings', { ...main.value('settings'), theme: 'nord' }));
    expect(sideArea()!.style.width).toBe('520px');
    fireEvent.mouseUp(window, { clientX: 900 });
  });

  it('change with the arrow keys on the edge too', () => {
    const main = renderApp(fakeMain({ side: BOTH }));
    openSession();
    const edge = within(sideArea()!).getByRole('separator', { name: 'Resize the Side area' });
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(edge.getAttribute('aria-valuenow')).toBe('444');
    expect(sizes(main)).toEqual([{ kind: 'info', dimension: 'width', size: 444 }]);
  });
});

describe("the Side area's shortcuts", () => {
  it('toggles it with Ctrl+B, and d and Ctrl+I show a Panel, hiding the area when already on it', () => {
    const main = renderApp(fakeMain({ side: HIDDEN_PANELS.side }));
    openSession();
    press('b', { ctrlKey: true });
    expect(viewName()).toBe('Changes');
    press('b', { ctrlKey: true });
    expect(sideArea()).toBeNull();

    press('i', { ctrlKey: true });
    expect(viewName()).toBe('Session info');
    press('d');
    expect(viewName()).toBe('Changes');
    press('d');
    expect(sideArea()).toBeNull();
    press('i', { ctrlKey: true });
    press('i', { ctrlKey: true });
    expect(sideArea()).toBeNull();
    expect(kept(main)).toEqual([
      { panels: ['changes'], shown: 'changes', open: true },
      { panels: ['changes'], shown: 'changes', open: false },
      { panels: ['changes', 'info'], shown: 'info', open: true },
      { panels: ['changes', 'info'], shown: 'changes', open: true },
      { panels: ['changes', 'info'], shown: 'changes', open: false },
      { panels: ['changes', 'info'], shown: 'info', open: true },
      { panels: ['changes', 'info'], shown: 'info', open: false },
    ]);
  });

  it('do nothing while no Session is selected', () => {
    const main = renderApp(fakeMain());
    press('b', { ctrlKey: true });
    press('d');
    press('i', { ctrlKey: true });
    expect(kept(main)).toEqual([]);
    openSession();
    expect(viewName()).toBe('Changes');
  });

  it('are in the palette while a Session is open, and in the shortcut list', () => {
    renderApp(fakeMain());
    press('k', { ctrlKey: true });
    const names = () => within(screen.getByRole('dialog', { name: 'Command palette' })).queryAllByRole('option').map((o) => o.getAttribute('aria-label'));
    expect(names()).not.toContain('Toggle the Side area');
    press('k', { ctrlKey: true });
    openSession();
    press('k', { ctrlKey: true });
    expect(names()).toEqual(expect.arrayContaining(['Toggle the Side area', 'Toggle diff', 'Toggle Session info']));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole('option', { name: 'Toggle Session info' }));
    expect(viewName()).toBe('Session info');

    press('?', { ctrlKey: true });
    const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const [label, keys] of [
      ['Toggle the Side area', 'Ctrl B'],
      ['Toggle diff', 'D'],
      ['Toggle Session info', 'Ctrl I'],
    ]) {
      expect(within(help).getByRole('row', { name: new RegExp(`^${label} ${keys}$`) })).toBeTruthy();
    }
  });
});

describe('the slimmer Session header', () => {
  it('shows only the crumb (Project · branch), title, status and the Side area and Dock icons', () => {
    renderApp(
      fakeMain({ sessions: [
        { ...session, issue: { number: 31, url: 'https://github.com/acme/billing-api/issues/31' }, mergeRequest: { number: 40, url: 'https://github.com/acme/billing-api/pull/40' }, diffStat: { files: 4, added: 12, removed: 3 } },
        ],
      }),
    );
    openSession();
    const h = header();
    expect(h.querySelector('.crumb')!.textContent).toBe('billing-api·loom/fix-login');
    expect(within(h).getByRole('heading').textContent).toBe('Fix login');
    expect(within(h).getByRole('status', { name: 'Session status' }).textContent).toBe('Finished');
    expect(within(h).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Hide the Side area', 'Show the Dock']);
    expect(h.textContent).not.toContain('acme/billing-api');
    expect(h.textContent).not.toContain('#31');
    expect(h.textContent).not.toContain('worktree');
  });

  it('keeps the worktree-missing warning, and Archive keeps its palette entry and e', async () => {
    const main = renderApp(fakeMain({ sessions: [{ ...session, worktreeMissing: true }] }));
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
  const main = new FakeMain({ projects: [project], sessions: [s], environments: [native] }, handlers);
  main.publish('panels', { ...DEFAULT_SESSION_PANELS, side: BOTH }, { sessionId: s.id });
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
    expect(value(git, 'Merge request')).toBe('#40');
    expect(within(git).getByRole('button', { name: 'Merge request open' })).toBeTruthy();
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
    main.publish('panels', HIDDEN_PANELS, { sessionId: full.id });
    renderApp(main);
    openSession();
    expect(sideArea()).toBeNull();
    press('k', { ctrlKey: true });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole('option', { name: 'Link Merge request…' }));
    expect(viewName()).toBe('Session info');
    expect(screen.getByRole('dialog', { name: 'Link Merge request' })).toBeTruthy();
    // Hiding the Side area drops it, and showing it again doesn't bring it back.
    fireEvent.click(within(header()).getByRole('button', { name: 'Hide the Side area' }));
    fireEvent.click(within(header()).getByRole('button', { name: 'Show the Side area' }));
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
    expect(value(agent, 'Approvals')).toBe('Supervised');
    expect(value(agent, 'Agent session')).toBe('ses_abc123');
    fireEvent.click(within(agent).getByRole('button', { name: 'Copy agent session id' }));
    expect(writeText).toHaveBeenCalledWith('ses_abc123');
    expect(value(agent, 'Queued messages')).toBe('2');
  });

  it('shows a Full access Session as such', () => {
    renderInfo({ ...full, fullAccess: true });
    expect(value(group('Agent'), 'Approvals')).toBe('Full access');
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
      expect(value(group('Git'), 'Merge request')).toBe('#41');
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
    expect(value(group('Git'), 'Merge request')).toBe('#40');
    expect(within(group('Git')).getByRole('button', { name: 'Merge request merged' })).toBeTruthy();
    for (const name of ['Open in editor', 'Open in terminal', 'Archive', 'Update Merge request', 'Link Merge request']) expect(within(view()).queryByRole('button', { name })).toBeNull();
    expect(within(view()).getByRole('button', { name: 'Open Merge request #40' })).toBeTruthy();
  });
});
