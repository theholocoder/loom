import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, TerminalInfo } from '../../src/shared/api';
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
function fakeMain(sessions: Session[] = [login, billing]) {
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
const dock = () => screen.queryByRole('region', { name: 'Dock' });
const terminalTabs = () => within(dock()!).getAllByRole('tab', { name: /^Terminal \d$/ });
const toggleTerminal = (target: Element = document.body) => fireEvent.keyDown(target, { key: '`', code: 'Backquote', ctrlKey: true });
const calls = (main: FakeMain, command: string) => main.invoked.filter((c) => c.command === command).map((c) => c.params);
const focusedInput = () => screen.getByRole('textbox', { name: 'Terminal input' });

describe('the dock', () => {
  it("is opened by Ctrl+`, on a terminal it starts in the open Session, with the focus in it", async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    expect(dock()).toBeNull();

    toggleTerminal();

    await waitFor(() => expect(terminalTabs().map((t) => t.textContent)).toEqual(['Terminal 1']));
    expect(calls(main, 'terminals.open')).toEqual([{ sessionId: 7, cols: 80, rows: 24 }]);
    await waitFor(() => expect(document.activeElement).toBe(focusedInput()));
    // Fitted to the dock once shown.
    expect(calls(main, 'terminals.resize')).toEqual([{ id: 1, cols: 100, rows: 20 }]);
  });

  it('is shown and hidden by a button in the Session header too', async () => {
    renderApp(fakeMain());
    openSession('Fix login');
    const header = screen.getByRole('region', { name: 'Session header' });

    fireEvent.click(within(header).getByRole('button', { name: 'Show the Dock' }));
    await waitFor(() => expect(terminalTabs()).toHaveLength(1));
    fireEvent.click(within(header).getByRole('button', { name: 'Hide the Dock' }));

    expect(dock()).toBeNull();
  });

  it("shows what the terminal prints, acknowledging it once shown, and sends what is typed to its shell", async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(screens).toHaveLength(1));

    act(() => main.publish('terminalOutput', { data: new TextEncoder().encode('$ '), replay: true }, { id: 1 }));
    act(() => main.publish('terminalOutput', { data: new TextEncoder().encode('héllo') }, { id: 1 }));
    screens[0]!.type('ls\r');

    expect(screens[0]!.shown).toBe('$ héllo');
    // What main replays was never held back; 'é' is two bytes.
    expect(calls(main, 'terminals.ack')).toEqual([{ id: 1, bytes: 6 }]);
    expect(calls(main, 'terminals.write')).toEqual([{ id: 1, data: 'ls\r' }]);
  });

  it('opens more terminals as tabs, closes one with its ×, and hides once the last is gone', async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(terminalTabs()).toHaveLength(1));

    fireEvent.click(within(dock()!).getByRole('button', { name: 'Add a Panel to the Dock' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Add a Panel to the Dock' })).getByRole('menuitem', { name: 'Terminal' }));
    await waitFor(() => expect(terminalTabs().map((t) => t.textContent)).toEqual(['Terminal 1', 'Terminal 2']));
    expect(terminalTabs()[1]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(terminalTabs()[0]!);
    expect(terminalTabs()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(within(dock()!).getByRole('tabpanel').contains(screens[0]!.element)).toBe(true);

    fireEvent.click(within(dock()!).getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(terminalTabs().map((t) => t.textContent)).toEqual(['Terminal 2']));
    expect(screens[0]!.disposed).toBe(true);
    fireEvent.click(within(dock()!).getByRole('button', { name: 'Close Terminal 2' }));

    await waitFor(() => expect(dock()).toBeNull());
    expect(calls(main, 'terminals.close')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('has its tabs as one Tab stop, the arrow keys moving between them', async () => {
    renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(terminalTabs()).toHaveLength(1));
    fireEvent.click(within(dock()!).getByRole('button', { name: 'Add a Panel to the Dock' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Add a Panel to the Dock' })).getByRole('menuitem', { name: 'Terminal' }));
    await waitFor(() => expect(terminalTabs()).toHaveLength(2));

    expect(terminalTabs().map((t) => t.tabIndex)).toEqual([-1, 0]);
    fireEvent.keyDown(terminalTabs()[1]!, { key: 'ArrowRight' });
    expect(terminalTabs()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(terminalTabs()[0]);
    expect(terminalTabs().map((t) => t.tabIndex)).toEqual([0, -1]);
    fireEvent.keyDown(terminalTabs()[0]!, { key: 'End' });
    expect(terminalTabs()[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('is open or not for each Session, and keeps its terminals going while another Session is shown', async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(screens).toHaveLength(1));

    openSession('Fix billing');
    expect(dock()).toBeNull();
    act(() => main.publish('terminalOutput', { data: new TextEncoder().encode('built') }, { id: 1 }));

    openSession('Fix login');
    expect(dock()).toBeTruthy();
    // The same screen, still showing all it was given.
    expect(screens).toHaveLength(1);
    expect(screens[0]!.shown).toBe('built');
    expect(within(dock()!).getByRole('tabpanel').contains(screens[0]!.element)).toBe(true);
  });

  it('keeps Loom shortcuts away from a focused terminal, all but Ctrl+K, Ctrl+? and Ctrl+`, which hides the dock', async () => {
    renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(document.activeElement).toBe(focusedInput()));

    fireEvent.keyDown(focusedInput(), { key: 'b', ctrlKey: true });
    fireEvent.keyDown(focusedInput(), { key: 'e' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Ctrl+B left the Side area as it was.
    expect(screen.getByRole('complementary', { name: 'Side area' })).toBeTruthy();

    fireEvent.keyDown(focusedInput(), { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(focusedInput());
    fireEvent.keyDown(focusedInput(), { key: '?', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(focusedInput());

    toggleTerminal(focusedInput());
    expect(dock()).toBeNull();
  });

  it('focuses the terminal on Ctrl+` when the dock is open but the focus is elsewhere', async () => {
    renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(document.activeElement).toBe(focusedInput()));
    (document.activeElement as HTMLElement).blur();

    toggleTerminal();

    expect(dock()).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(focusedInput()));
  });

  it('is resized by its top edge, with the arrow keys', async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(terminalTabs()).toHaveLength(1));
    const edge = within(dock()!).getByRole('separator', { name: 'Resize the Dock' });
    const height = Number(edge.getAttribute('aria-valuenow'));

    fireEvent.keyDown(edge, { key: 'ArrowUp' });

    expect(Number(edge.getAttribute('aria-valuenow'))).toBe(height + 24);
    expect(dock()!.style.height).toBe(`${height + 24}px`);
    // One height for every Terminal, kept in the Layout.
    expect(calls(main, 'settings.setPanelSize')).toEqual([{ kind: 'terminal', dimension: 'height', size: height + 24 }]);
  });

  it('opens at the height the Layout has for Terminals', async () => {
    const main = fakeMain();
    main.publish('settings', { ...main.value('settings'), layout: { area: {}, width: {}, height: { terminal: 333 } } });
    renderApp(main);
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(terminalTabs()).toHaveLength(1));
    expect(dock()!.style.height).toBe('333px');
  });

  it("keeps each Session's Terminal tabs while Loom runs, and offers only a Terminal in its + menu", async () => {
    const main = renderApp(fakeMain());
    openSession('Fix login');
    toggleTerminal();
    await waitFor(() => expect(terminalTabs()).toHaveLength(1));
    expect(main.value('panels', { sessionId: 7 }).dock).toEqual({ panels: ['terminal:1'], shown: 'terminal:1', open: true });
    fireEvent.click(within(dock()!).getByRole('button', { name: 'Add a Panel to the Dock' }));
    expect(within(screen.getByRole('menu', { name: 'Add a Panel to the Dock' })).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Terminal']);
  });

  it('says why when a terminal fails to open', async () => {
    const main = new FakeMain(
      { projects: [project], sessions: [login] },
      {
        'terminals.open': () => {
          throw new Error('Terminals need a Unix or WSL Environment; Native is native Windows.');
        },
      },
    );
    renderApp(main);
    openSession('Fix login');
    toggleTerminal();

    expect(await within(dock()!).findByRole('alert')).toHaveProperty('textContent', 'Terminals need a Unix or WSL Environment; Native is native Windows.');
  });

  it('leaves Open in terminal, for the terminal app, in the palette without a shortcut', () => {
    renderApp(fakeMain());
    openSession('Fix login');
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const palette = screen.getByRole('dialog');

    expect(within(palette).getByRole('option', { name: 'Open in terminal' }).querySelector('kbd')).toBeNull();
    expect(within(palette).getByRole('option', { name: 'Toggle terminal' }).querySelector('kbd')?.textContent).toBe('Ctrl `');
  });
});
