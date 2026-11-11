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
    renderApp(fakeMain({ side: { panels: ['changes'], shown: 'changes' }, layout: { width: { changes: 555 } } }));
    openSession();
    expect(tabNames()).toEqual(['Changes']);
    expect(viewName()).toBe('Changes');
    expect(sideArea()!.style.width).toBe('555px');
  });

  it('sits under the Glance strip, beside the conversation, the Dock under both', () => {
    renderApp(fakeMain());
    openSession();
    const body = sideArea()!.parentElement!;
    expect(body.contains(screen.getByRole('log', { name: 'Conversation' }))).toBe(true);
    expect(body.previousElementSibling).toBe(screen.getByRole('group', { name: 'Session at a glance' }));
  });
});

describe("the Side area's Panels", () => {
  it('adds Changes from the + menu, shown; once open, the + menu only shows it', () => {
    const main = renderApp(fakeMain({ side: { panels: [], shown: null, open: true } }));
    openSession();
    const add = () => {
      fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Add a Panel to the Side area' }));
      return screen.getByRole('menu', { name: 'Add a Panel to the Side area' });
    };
    expect(within(add()).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Changes']);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Changes' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(tabNames()).toEqual(['Changes']);
    expect(viewName()).toBe('Changes');

    fireEvent.click(within(add()).getByRole('menuitem', { name: 'Changes' }));
    expect(tabNames()).toEqual(['Changes']);
    expect(kept(main).at(-1)).toEqual({ panels: ['changes'], shown: 'changes', open: true });
  });

  it('closes one with its ✕; closing the last hides the area, and d brings Changes back', () => {
    const main = renderApp(fakeMain());
    openSession();
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Close Changes' }));
    expect(sideArea()).toBeNull();
    expect(kept(main)).toEqual([{ panels: [], shown: null, open: false }]);

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
    const main = renderApp(fakeMain());
    openSession();
    expect(sideArea()!.style.width).toBe('640px');
    const edge = within(sideArea()!).getByRole('separator', { name: 'Resize the Side area' });
    fireEvent.mouseDown(edge, { clientX: 1000 });
    fireEvent.mouseMove(window, { clientX: 950 });
    expect(sideArea()!.style.width).toBe('690px');
    expect(sizes(main)).toEqual([]);
    fireEvent.mouseUp(window, { clientX: 940 });
    expect(sideArea()!.style.width).toBe('700px');
    expect(sizes(main)).toEqual([{ kind: 'changes', dimension: 'width', size: 700 }]);

    fireEvent.mouseDown(edge, { clientX: 1000 });
    fireEvent.mouseUp(window, { clientX: 1900 });
    expect(sizes(main).at(-1)).toEqual({ kind: 'changes', dimension: 'width', size: 280 });
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
    const main = renderApp(fakeMain({ layout: { width: { changes: 600 } } }));
    openSession();
    expect(sideArea()!.style.width).toBe('600px');
    fireEvent.doubleClick(within(sideArea()!).getByRole('separator', { name: 'Resize the Side area' }));
    expect(sideArea()!.style.width).toBe('640px');
    expect(sizes(main)).toEqual([{ kind: 'changes', dimension: 'width', size: 640 }]);
  });

  it('keep a drag going through an unrelated settings change', () => {
    const main = renderApp(fakeMain());
    openSession();
    const edge = within(sideArea()!).getByRole('separator', { name: 'Resize the Side area' });
    fireEvent.mouseDown(edge, { clientX: 1000 });
    fireEvent.mouseMove(window, { clientX: 950 });
    act(() => main.publish('settings', { ...main.value('settings'), theme: 'nord' }));
    expect(sideArea()!.style.width).toBe('690px');
    fireEvent.mouseUp(window, { clientX: 950 });
  });

  it('change with the arrow keys on the edge too', () => {
    const main = renderApp(fakeMain());
    openSession();
    const edge = within(sideArea()!).getByRole('separator', { name: 'Resize the Side area' });
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(edge.getAttribute('aria-valuenow')).toBe('664');
    expect(sizes(main)).toEqual([{ kind: 'changes', dimension: 'width', size: 664 }]);
  });
});

describe("the Side area's shortcuts", () => {
  it('toggles it with Ctrl+B, and d shows Changes, hiding the area when already on it', () => {
    const main = renderApp(fakeMain({ side: HIDDEN_PANELS.side }));
    openSession();
    press('b', { ctrlKey: true });
    expect(viewName()).toBe('Changes');
    press('b', { ctrlKey: true });
    expect(sideArea()).toBeNull();

    press('d');
    expect(viewName()).toBe('Changes');
    press('d');
    expect(sideArea()).toBeNull();
    // Ctrl+I is Session details, a popover, which leaves the Side area be.
    press('i', { ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Session details' })).toBeTruthy();
    expect(sideArea()).toBeNull();
    expect(kept(main)).toEqual([
      { panels: ['changes'], shown: 'changes', open: true },
      { panels: ['changes'], shown: 'changes', open: false },
      { panels: ['changes'], shown: 'changes', open: true },
      { panels: ['changes'], shown: 'changes', open: false },
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
    expect(names()).toEqual(expect.arrayContaining(['Toggle the Side area', 'Toggle diff', 'Show Session details']));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole('option', { name: 'Show Session details' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Session details' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Session details' })).toBeNull();

    press('?', { ctrlKey: true });
    const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const [label, keys] of [
      ['Toggle the Side area', 'Ctrl B'],
      ['Toggle diff', 'D'],
      ['Show Session details', 'Ctrl I'],
    ]) {
      expect(within(help).getByRole('row', { name: new RegExp(`^${label} ${keys}$`) })).toBeTruthy();
    }
  });
});

