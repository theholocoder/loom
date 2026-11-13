import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, TerminalInfo } from '../../src/shared/api';
import type { SessionPanels } from '../../src/shared/panels';
import { FakeMain } from './fake-main';

// jsdom has no layout for xterm: each screen is a stand-in that keeps what it
// was given to show, and can be typed into.
const screens = vi.hoisted(() => [] as FakeScreen[]);
interface FakeScreen {
  element: HTMLElement;
  shown: string;
  type(data: string): void;
  disposed: boolean;
}
vi.mock('../../src/renderer/terminal-screen', () => ({
  createTerminalScreen: () => {
    const element = document.createElement('div');
    element.className = 'terminal-screen';
    const input = document.createElement('textarea');
    input.setAttribute('aria-label', 'Terminal input');
    element.append(input);
    const listeners: Array<(data: string) => void> = [];
    const fake: FakeScreen & Record<string, unknown> = {
      element,
      shown: '',
      disposed: false,
      type: (data: string) => listeners.forEach((l) => l(data)),
      write: (data: Uint8Array, shown: () => void) => {
        fake.shown += new TextDecoder().decode(data);
        shown();
      },
      onInput: (listener: (data: string) => void) => listeners.push(listener),
      fit: () => ({ cols: 100, rows: 20 }),
      focus: () => input.focus(),
      restyle: () => {},
      dispose: () => {
        fake.disposed = true;
        element.remove();
      },
    };
    screens.push(fake);
    return fake;
  },
}));

afterEach(() => {
  cleanup();
  screens.length = 0;
});

const project: Project = {
  id: 1,
  name: 'billing-api',
  color: 'blue',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const session = (id: number, title: string): Session => ({
  id,
  projectId: 1,
  title,
  workingCopy: { kind: 'worktree', path: `/home/dev/loom/worktrees/billing-api/${id}` },
  branch: `loom/${id}`,
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: id,
  updatedAt: id,
});
const login = session(7, 'Fix login');
const billing = session(8, 'Fix billing');

/** A main whose terminals open, list and close as the real one's do. */
function fakeMain(sessions: Session[] = [login, billing], handlers: NonNullable<ConstructorParameters<typeof FakeMain>[1]> = {}) {
  let next = 1;
  const opened = new Map<number, number>();
  const lists = new Map<number, TerminalInfo[]>();
  const main: FakeMain = new FakeMain(
    { projects: [project], sessions },
    {
      'terminals.open': ({ sessionId }) => {
        const number = (opened.get(sessionId) ?? 0) + 1;
        opened.set(sessionId, number);
        const terminal = { id: next++, sessionId, title: `Terminal ${number}` };
        lists.set(sessionId, [...(lists.get(sessionId) ?? []), terminal]);
        main.publish('terminals', lists.get(sessionId)!, { sessionId });
        return terminal;
      },
      'terminals.close': ({ id }) => {
        for (const [sessionId, list] of lists) {
          if (!list.some((t) => t.id === id)) continue;
          lists.set(sessionId, list.filter((t) => t.id !== id));
          main.publish('terminals', lists.get(sessionId)!, { sessionId });
        }
      },
      ...handlers,
    },
  );
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

const openSession = (title: string) => fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: title }));
const sideArea = () => screen.queryByRole('complementary', { name: 'Side area' });
const dock = () => screen.queryByRole('region', { name: 'Dock' });
const tabNames = (area: HTMLElement | null) => within(area!).queryAllByRole('tab').map((t) => t.getAttribute('aria-label'));
const tab = (area: HTMLElement | null, name: string) => within(area!).getByRole('tab', { name });
/** The name of the Panel `area` shows, as its tab gives it. */
const shownIn = (area: HTMLElement | null) => within(area!).getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label');
const toggleTerminal = (target: Element = document.body) => fireEvent.keyDown(target, { key: '`', code: 'Backquote', ctrlKey: true });
const calls = (main: FakeMain, command: string) => main.invoked.filter((c) => c.command === command).map((c) => c.params);
/** What the renderer last asked main to keep of Session `id`'s Panels. */
const kept = (main: FakeMain, id: number) =>
  main.invoked
    .filter((c) => c.command === 'sessions.setPanels' && (c.params as { id: number }).id === id)
    .map((c) => (c.params as { panels: SessionPanels }).panels)
    .at(-1);
const menuItems = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((m) => m.getAttribute('aria-label'));
/** Right-clicks `element`, and gives the menu that opens. */
const rightClick = (element: HTMLElement) => {
  fireEvent.contextMenu(element);
  return screen.getByRole('menu', { name: 'Context menu' });
};

describe('moving a Panel', () => {
  it("takes Changes to the Dock from its tab's right-click menu, kept in the Layout, the Side area it leaves empty hidden", () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    const menu = rightClick(tab(sideArea(), 'Changes'));
    expect(menuItems(menu)).toEqual(['Move to the Dock', 'Review mode', 'Close']);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to the Dock' }));
    expect(sideArea()).toBeNull();
    expect(tabNames(dock())).toEqual(['Changes']);
    expect(shownIn(dock())).toBe('Changes');
    expect(document.activeElement).toBe(tab(dock(), 'Changes'));
    expect(calls(main, 'settings.setPanelPlace')).toEqual([{ kind: 'changes', area: 'dock', stack: 'first' }]);
    expect(kept(main, 7)).toEqual({ side: { panels: [], shown: null, open: false }, dock: { panels: ['changes'], shown: 'changes', open: true } });
  });

  it("brings it back from the Dock's ⋯ menu, which offers no Review mode there", () => {
    const main = fakeMain();
    main.publish('settings', { ...main.value('settings'), layout: { ...main.value('settings').layout, area: { changes: 'dock' } } });
    renderApp(main);
    openSession('Fix login');
    // Where the Layout has it, though the Session left it in the Side area: main serves it there, with nothing to keep.
    expect(sideArea()).toBeNull();
    expect(tabNames(dock())).toEqual(['Changes']);
    expect(calls(main, 'sessions.setPanels')).toEqual([]);

    fireEvent.click(within(dock()!).getByRole('button', { name: 'More for Changes' }));
    const menu = screen.getByRole('menu', { name: 'More for Changes' });
    expect(menuItems(menu)).toEqual(['Move to the Side area', 'Close']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to the Side area' }));
    expect(dock()).toBeNull();
    expect(tabNames(sideArea())).toEqual(['Changes']);
    expect(sideArea()!.style.width).toBe('640px');
    expect(calls(main, 'settings.setPanelPlace')).toEqual([{ kind: 'changes', area: 'side', stack: 'first' }]);
    expect(kept(main, 7)).toEqual({ side: { panels: ['changes'], shown: 'changes', open: true }, dock: { panels: [], shown: null, open: false } });
  });

  it('takes it there in the other Sessions too, a new one opening with it there', () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    fireEvent.click(within(rightClick(tab(sideArea(), 'Changes'))).getByRole('menuitem', { name: 'Move to the Dock' }));

    openSession('Fix billing');
    expect(sideArea()).toBeNull();
    expect(tabNames(dock())).toEqual(['Changes']);
    // Main serves it there: the renderer has nothing to keep.
    expect(kept(main, 8)).toBeUndefined();
  });

  it('goes back where it was when settings refuse to keep the move', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const main = renderApp(
      fakeMain([login, billing], {
        'settings.setPanelPlace': () => {
          throw new Error('database is locked');
        },
      }),
    );
    openSession('Fix login');
    fireEvent.click(within(rightClick(tab(sideArea(), 'Changes'))).getByRole('menuitem', { name: 'Move to the Dock' }));
    await waitFor(() => expect(tabNames(sideArea())).toEqual(['Changes']));
    expect(dock()).toBeNull();
    expect(main.value('panels', { sessionId: 7 })).toEqual({ side: { panels: ['changes'], shown: 'changes', open: true }, dock: { panels: [], shown: null, open: false } });
    vi.restoreAllMocks();
  });

  it('takes every Terminal with the one moved, and Ctrl+` and the + menu then work in the Side area', async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1']));
    fireEvent.click(within(dock()!).getByRole('button', { name: 'Add a Panel to the Dock' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Terminal' }));
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1', 'Terminal 2']));

    fireEvent.click(within(rightClick(tab(dock(), 'Terminal 1'))).getByRole('menuitem', { name: 'Move to the Side area' }));
    expect(dock()).toBeNull();
    expect(tabNames(sideArea())).toEqual(['Changes', 'Terminal 1', 'Terminal 2']);
    expect(shownIn(sideArea())).toBe('Terminal 1');
    expect(calls(main, 'settings.setPanelPlace')).toEqual([{ kind: 'terminal', area: 'side', stack: 'first' }]);
    // The Dock has nothing left: the header's toggle shows it empty, rather than start a Terminal there.
    fireEvent.click(within(screen.getByRole('region', { name: 'Session header' })).getByRole('button', { name: 'Show the Dock' }));
    expect(within(dock()!).getByRole('tabpanel', { name: 'Dock' }).textContent).toBe('No Panels here. Add one with +, or drag a tab here.');
    // Its + menu still offers every Panel.
    fireEvent.click(within(dock()!).getByRole('button', { name: 'Add a Panel to the Dock' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Changes', 'Highlights', 'Terminal']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(calls(main, 'terminals.open')).toHaveLength(2);

    // Ctrl+` goes to the Terminal shown in the Side area, then hides the area from it.
    toggleTerminal();
    await waitFor(() => expect(document.activeElement).toBe(within(sideArea()!).getByRole('textbox', { name: 'Terminal input' })));
    toggleTerminal(document.activeElement!);
    expect(sideArea()).toBeNull();

    // A new one opens beside them.
    toggleTerminal();
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Add a Panel to the Side area' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Changes', 'Highlights', 'Terminal']);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Terminal' }));
    await waitFor(() => expect(tabNames(sideArea())).toEqual(['Changes', 'Terminal 1', 'Terminal 2', 'Terminal 3']));
    expect(shownIn(sideArea())).toBe('Terminal 3');
  });

  it('leaves Review mode for a Panel brought into the Side area', async () => {
    renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1']));
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Review Changes' }));
    expect(screen.getByRole('region', { name: 'Review mode' })).toBeTruthy();

    fireEvent.click(within(rightClick(tab(dock(), 'Terminal 1'))).getByRole('menuitem', { name: 'Move to the Side area' }));
    expect(screen.queryByRole('region', { name: 'Review mode' })).toBeNull();
    expect(shownIn(sideArea())).toBe('Terminal 1');
  });
});

/** Fires a drag event `type` at `element`, at `at` in the window. */
const dragEvent = (type: 'dragOver' | 'drop', element: Element, at: { clientX?: number; clientY?: number } = {}) => {
  const event = createEvent[type](element);
  for (const [key, value] of Object.entries(at)) Object.defineProperty(event, key, { value });
  fireEvent(element, event);
};
/** Drags the tab `from` onto `to`, dropping it at `at`. */
const drag = (from: HTMLElement, to: Element, at: { clientX?: number; clientY?: number } = {}) => {
  fireEvent.dragStart(from);
  dragEvent('dragOver', to, at);
  dragEvent('drop', to, at);
  fireEvent.dragEnd(from);
};
/** Gives `element` the box `rect` in the window. */
const placeAt = (element: Element, rect: { left?: number; top?: number; width?: number; height?: number }) => {
  const { left = 0, top = 0, width = 0, height = 0 } = rect;
  element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
};
/** The tab bars of `area`'s stacks, by name. */
const tabLists = (area: HTMLElement | null) => within(area!).getAllByRole('tablist').map((list) => list.getAttribute('aria-label'));
const tabsOf = (area: HTMLElement | null, list: string) => within(within(area!).getByRole('tablist', { name: list })).getAllByRole('tab').map((t) => t.getAttribute('aria-label'));

/** Opens Fix login with a Terminal moved into the Side area beside Changes. */
async function withTerminalInSide(main: FakeMain) {
  renderApp(main);
  openSession('Fix login');
  toggleTerminal();
  await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1']));
  fireEvent.click(within(rightClick(tab(dock(), 'Terminal 1'))).getByRole('menuitem', { name: 'Move to the Side area' }));
  expect(tabNames(sideArea())).toEqual(['Changes', 'Terminal 1']);
}

describe('splitting an area', () => {
  it("splits the Side area from a tab's menu, the kind kept in its second stack, and joins them again", async () => {
    const main = fakeMain();
    await withTerminalInSide(main);
    const menu = rightClick(tab(sideArea(), 'Terminal 1'));
    expect(menuItems(menu)).toEqual(['Move to the Dock', 'Split down', 'Close']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Split down' }));

    expect(tabLists(sideArea())).toEqual(['Side area Panels, top', 'Side area Panels, bottom']);
    expect(tabsOf(sideArea(), 'Side area Panels, top')).toEqual(['Changes']);
    expect(tabsOf(sideArea(), 'Side area Panels, bottom')).toEqual(['Terminal 1']);
    expect(calls(main, 'settings.setPanelPlace').at(-1)).toEqual({ kind: 'terminal', area: 'side', stack: 'second' });
    expect(kept(main, 7)!.side).toEqual({ panels: ['changes'], shown: 'changes', open: true, second: { panels: ['terminal:1'], shown: 'terminal:1' } });
    // Each stack shows its own: Changes still, beside the Terminal.
    expect(within(sideArea()!).getAllByRole('tab', { selected: true }).map((t) => t.getAttribute('aria-label'))).toEqual(['Changes', 'Terminal 1']);

    // A new Terminal opens in the stack Terminals sit in; each stack's + menu offers every Panel.
    fireEvent.click(within(sideArea()!).getAllByRole('button', { name: 'Add a Panel to the Side area' }).at(-1)!);
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Changes', 'Highlights', 'Terminal']);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Terminal' }));
    await waitFor(() => expect(tabsOf(sideArea(), 'Side area Panels, bottom')).toEqual(['Terminal 1', 'Terminal 2']));

    // Back with Changes: the stack left empty goes, and the area is one again.
    const back = rightClick(tab(sideArea(), 'Changes'));
    expect(menuItems(back)).toEqual(['Move to the Dock', 'Move to the bottom stack', 'Review mode', 'Close']);
    fireEvent.click(within(back).getByRole('menuitem', { name: 'Move to the bottom stack' }));
    expect(tabLists(sideArea())).toEqual(['Side area Panels']);
    expect(tabNames(sideArea())).toEqual(['Terminal 1', 'Terminal 2', 'Changes']);
    expect(shownIn(sideArea())).toBe('Changes');
    expect(calls(main, 'settings.setPanelPlace').at(-1)).toEqual({ kind: 'changes', area: 'side', stack: 'second' });
  });

  it('keeps the split for the other Sessions, a Panel of the kind opening in its stack', async () => {
    const main = fakeMain();
    await withTerminalInSide(main);
    fireEvent.click(within(rightClick(tab(sideArea(), 'Terminal 1'))).getByRole('menuitem', { name: 'Split down' }));

    openSession('Fix billing');
    expect(tabLists(sideArea())).toEqual(['Side area Panels']);
    toggleTerminal();
    await waitFor(() => expect(tabLists(sideArea())).toEqual(['Side area Panels, top', 'Side area Panels, bottom']));
    expect(tabsOf(sideArea(), 'Side area Panels, bottom')).toEqual(['Terminal 1']);
    expect(dock()).toBeNull();
  });

  it("sizes the second stack by its Panel's size along the area, the area by the larger of the two", async () => {
    const main = fakeMain();
    await withTerminalInSide(main);
    fireEvent.click(within(rightClick(tab(sideArea(), 'Terminal 1'))).getByRole('menuitem', { name: 'Split down' }));
    // Changes' 640px wide, the Terminal's 520px.
    expect(sideArea()!.style.width).toBe('640px');
    const edge = screen.getByRole('separator', { name: "Resize the Side area's bottom stack" });
    expect(edge.parentElement!.style.height).toBe('280px');

    fireEvent.keyDown(edge, { key: 'ArrowUp' });
    expect(edge.parentElement!.style.height).toBe('304px');
    expect(calls(main, 'settings.setPanelSize').at(-1)).toEqual({ kind: 'terminal', dimension: 'height', size: 304 });

    // The area's edge sizes both Panels it shows.
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the Side area' }), { key: 'ArrowRight' });
    expect(sideArea()!.style.width).toBe('616px');
    expect(calls(main, 'settings.setPanelSize').slice(-2)).toEqual([
      { kind: 'changes', dimension: 'width', size: 616 },
      { kind: 'terminal', dimension: 'width', size: 616 },
    ]);
  });

  it('offers no split for a stack of one kind', async () => {
    renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1']));
    fireEvent.click(within(dock()!).getByRole('button', { name: 'Add a Panel to the Dock' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Terminal' }));
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1', 'Terminal 2']));
    expect(menuItems(rightClick(tab(dock(), 'Terminal 1')))).toEqual(['Move to the Side area', 'Close']);
  });
});

describe('dragging a tab', () => {
  it('takes it to the Dock, not shown, through the strip shown for it while dragging', () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    expect(screen.queryByText('Move to the Dock')).toBeNull();
    fireEvent.dragStart(tab(sideArea(), 'Changes'));
    const strip = screen.getByText('Move to the Dock').parentElement!;
    dragEvent('dragOver', strip);
    dragEvent('drop', strip);
    fireEvent.dragEnd(document.body);

    expect(sideArea()).toBeNull();
    expect(tabNames(dock())).toEqual(['Changes']);
    expect(document.activeElement).toBe(tab(dock(), 'Changes'));
    expect(calls(main, 'settings.setPanelPlace')).toEqual([{ kind: 'changes', area: 'dock', stack: 'first' }]);
    expect(screen.queryByText('Move to the Side area')).toBeNull();
  });

  it("puts it among the other area's tabs where it is dropped", async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1']));
    fireEvent.click(within(dock()!).getByRole('button', { name: 'Add a Panel to the Dock' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Terminal' }));
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1', 'Terminal 2']));
    placeAt(tab(dock(), 'Terminal 1').parentElement!, { left: 0, width: 100 });
    placeAt(tab(dock(), 'Terminal 2').parentElement!, { left: 100, width: 100 });

    drag(tab(sideArea(), 'Changes'), tab(dock(), 'Terminal 2'), { clientX: 120 });
    expect(sideArea()).toBeNull();
    expect(tabNames(dock())).toEqual(['Terminal 1', 'Changes', 'Terminal 2']);
    expect(shownIn(dock())).toBe('Changes');
    expect(calls(main, 'settings.setPanelPlace')).toEqual([{ kind: 'changes', area: 'dock', stack: 'first' }]);

    // Within its own tabs it only changes places, the Layout as it was.
    placeAt(tab(dock(), 'Terminal 1').parentElement!, { left: 0, width: 100 });
    drag(tab(dock(), 'Terminal 2'), tab(dock(), 'Terminal 1'), { clientX: 10 });
    expect(tabNames(dock())).toEqual(['Terminal 2', 'Terminal 1', 'Changes']);
    expect(calls(main, 'settings.setPanelPlace')).toHaveLength(1);
  });

  it("splits an area dropped on the far half of its Panel, and joins a stack dropped on the near half", async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1']));
    const view = within(sideArea()!).getByRole('tabpanel');
    placeAt(view, { top: 0, height: 600 });

    drag(tab(dock(), 'Terminal 1'), view, { clientY: 450 });
    expect(dock()).toBeNull();
    expect(tabLists(sideArea())).toEqual(['Side area Panels, top', 'Side area Panels, bottom']);
    expect(tabsOf(sideArea(), 'Side area Panels, bottom')).toEqual(['Terminal 1']);
    expect(calls(main, 'settings.setPanelPlace')).toEqual([{ kind: 'terminal', area: 'side', stack: 'second' }]);

    // Into Changes' stack, split: it joins it, and the area is one again.
    const top = within(sideArea()!).getAllByRole('tabpanel')[0]!;
    placeAt(top, { top: 0, height: 300 });
    drag(tab(sideArea(), 'Terminal 1'), top, { clientY: 280 });
    expect(tabLists(sideArea())).toEqual(['Side area Panels']);
    expect(tabNames(sideArea())).toEqual(['Changes', 'Terminal 1']);
    expect(calls(main, 'settings.setPanelPlace').at(-1)).toEqual({ kind: 'terminal', area: 'side', stack: 'first' });
  });

  it('splits the Dock side by side', async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1']));
    const view = within(dock()!).getByRole('tabpanel');
    placeAt(view, { left: 0, width: 1000 });
    drag(tab(sideArea(), 'Changes'), view, { clientX: 900 });

    expect(tabLists(dock())).toEqual(['Dock Panels, left', 'Dock Panels, right']);
    expect(tabsOf(dock(), 'Dock Panels, right')).toEqual(['Changes']);
    expect(calls(main, 'settings.setPanelPlace')).toEqual([{ kind: 'changes', area: 'dock', stack: 'second' }]);
    // The right stack takes Changes' width.
    expect(screen.getByRole('separator', { name: "Resize the Dock's right stack" }).parentElement!.style.width).toBe('640px');
  });
});

describe('dragging a tab in Review mode', () => {
  it('offers no strip over the Panel in review', async () => {
    renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(tabNames(dock())).toEqual(['Terminal 1']));
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Review Changes' }));
    fireEvent.dragStart(tab(dock(), 'Terminal 1'));
    expect(screen.queryByText('Move to the Side area')).toBeNull();
    fireEvent.dragEnd(tab(dock(), 'Terminal 1'));
  });
});
