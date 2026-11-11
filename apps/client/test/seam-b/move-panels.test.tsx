import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    expect(calls(main, 'settings.setPanelArea')).toEqual([{ kind: 'changes', area: 'dock' }]);
    expect(kept(main, 7)).toEqual({ side: { panels: [], shown: null, open: false }, dock: { panels: ['changes'], shown: 'changes', open: true } });
  });

  it("brings it back from the Dock's ⋯ menu, which offers no Review mode there", () => {
    const main = fakeMain();
    main.publish('settings', { ...main.value('settings'), layout: { ...main.value('settings').layout, area: { changes: 'dock' } } });
    renderApp(main);
    openSession('Fix login');
    // Where the Layout has it, though the Session left it in the Side area.
    expect(sideArea()).toBeNull();
    expect(tabNames(dock())).toEqual(['Changes']);

    fireEvent.click(within(dock()!).getByRole('button', { name: 'More for Changes' }));
    const menu = screen.getByRole('menu', { name: 'More for Changes' });
    expect(menuItems(menu)).toEqual(['Move to the Side area', 'Close']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to the Side area' }));
    expect(dock()).toBeNull();
    expect(tabNames(sideArea())).toEqual(['Changes']);
    expect(sideArea()!.style.width).toBe('640px');
    expect(calls(main, 'settings.setPanelArea')).toEqual([{ kind: 'changes', area: 'side' }]);
    expect(kept(main, 7)).toEqual({ side: { panels: ['changes'], shown: 'changes', open: true }, dock: { panels: [], shown: null, open: false } });
  });

  it('takes it there in the other Sessions too, a new one opening with it there', () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    fireEvent.click(within(rightClick(tab(sideArea(), 'Changes'))).getByRole('menuitem', { name: 'Move to the Dock' }));

    openSession('Fix billing');
    expect(sideArea()).toBeNull();
    expect(tabNames(dock())).toEqual(['Changes']);
    expect(kept(main, 8)).toEqual({ side: { panels: [], shown: null, open: false }, dock: { panels: ['changes'], shown: 'changes', open: true } });
  });

  it('goes back where it was when settings refuse to keep the move', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const main = renderApp(
      fakeMain([login, billing], {
        'settings.setPanelArea': () => {
          throw new Error('database is locked');
        },
      }),
    );
    openSession('Fix login');
    fireEvent.click(within(rightClick(tab(sideArea(), 'Changes'))).getByRole('menuitem', { name: 'Move to the Dock' }));
    await waitFor(() => expect(tabNames(sideArea())).toEqual(['Changes']));
    expect(dock()).toBeNull();
    await waitFor(() => expect(kept(main, 7)).toEqual({ side: { panels: ['changes'], shown: 'changes', open: true }, dock: { panels: [], shown: null, open: false } }));
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
    expect(calls(main, 'settings.setPanelArea')).toEqual([{ kind: 'terminal', area: 'side' }]);
    // The Dock has nothing left: the header's toggle shows it empty, rather than start a Terminal there.
    fireEvent.click(within(screen.getByRole('region', { name: 'Session header' })).getByRole('button', { name: 'Show the Dock' }));
    expect(within(dock()!).getByRole('tabpanel', { name: 'Dock' }).textContent).toBe('No Panels here. Add one with +, or move a tab here from its menu.');
    expect(within(dock()!).queryByRole('button', { name: 'Add a Panel to the Dock' })).toBeNull();
    expect(calls(main, 'terminals.open')).toHaveLength(2);

    // Ctrl+` goes to the Terminal shown in the Side area, then hides the area from it.
    toggleTerminal();
    await waitFor(() => expect(document.activeElement).toBe(within(sideArea()!).getByRole('textbox', { name: 'Terminal input' })));
    toggleTerminal(document.activeElement!);
    expect(sideArea()).toBeNull();

    // A new one opens beside them.
    toggleTerminal();
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Add a Panel to the Side area' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Changes', 'Terminal']);
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
