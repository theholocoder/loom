import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session } from '../../src/shared/api';
import { DEFAULT_SESSION_PANELS, type PanelAreaState, type SessionPanels } from '../../src/shared/panels';
import type { InboxSettings } from '../../src/shared/window';
import { FakeMain } from './fake-main';

/** Makes the window `width` wide, as a user resizing it would. */
function resizeWindow(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });
}

afterEach(() => {
  cleanup();
  window.innerWidth = 1440;
});

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

function renderApp({ side, inbox }: { side?: Partial<PanelAreaState>; inbox?: InboxSettings } = {}) {
  const main = new FakeMain({ projects: [project], sessions: [session, other], settings: { ...DEFAULT_SETTINGS, ...(inbox && { inbox }) } });
  if (side) main.publish('panels', { ...DEFAULT_SESSION_PANELS, side: { ...DEFAULT_SESSION_PANELS.side, ...side } }, { sessionId: session.id });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const inbox = () => screen.getByRole('complementary', { name: 'Inbox' });
const openSession = (title = session.title) => fireEvent.click(within(inbox()).getByRole('button', { name: title }));
const header = () => screen.getByRole('region', { name: 'Session header' });
const sideArea = () => screen.queryByRole('complementary', { name: 'Side area' });
const scrim = () => document.querySelector<HTMLElement>('.drawer-scrim');
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
/** What the renderer asked main to keep of Session 7's Side area. */
const kept = (main: FakeMain) =>
  main.invoked.filter((c) => c.command === 'sessions.setPanels' && (c.params as { id: number }).id === session.id).map((c) => (c.params as { panels: SessionPanels }).panels.side);
const inboxCalls = (main: FakeMain) => main.invoked.filter((c) => c.command === 'settings.setInbox').map((c) => c.params);
const inboxWidth = () => (document.querySelector('.app') as HTMLElement).style.getPropertyValue('--inbox-width');

describe('in a narrow window, the Side area', () => {
  it('is a drawer over the conversation, closed when a Session opens, opened by the header icon and closed by the scrim', () => {
    window.innerWidth = 1000;
    const main = renderApp();
    openSession();
    expect(sideArea()).toBeNull();
    const toggle = within(header()).getByRole('button', { name: 'Show the Side area' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(sideArea()!.classList.contains('drawer')).toBe(true);
    expect(within(header()).getByRole('button', { name: 'Hide the Side area' }).getAttribute('aria-expanded')).toBe('true');
    // The focus goes into it.
    expect(document.activeElement).toBe(within(sideArea()!).getByRole('tab', { name: 'Changes' }));

    fireEvent.pointerDown(scrim()!);
    expect(sideArea()).toBeNull();
    expect(scrim()).toBeNull();
    // Only the drawer closed: the Session's Panels are as they were.
    expect(kept(main)).toEqual([]);

    // A click on the Inbox, outside the scrim, closes it too; one in it doesn't.
    fireEvent.click(within(header()).getByRole('button', { name: 'Show the Side area' }));
    fireEvent.pointerDown(within(sideArea()!).getByRole('tab', { name: 'Changes' }));
    expect(sideArea()).toBeTruthy();
    fireEvent.pointerDown(within(inbox()).getByRole('button', { name: 'Search Sessions and actions' }));
    expect(sideArea()).toBeNull();
  });

  it('closes when its last Panel is closed, and opens again on the next one shown', () => {
    window.innerWidth = 1000;
    renderApp();
    openSession();
    fireEvent.click(within(header()).getByRole('button', { name: 'Show the Side area' }));
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Close Changes' }));
    expect(sideArea()).toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    press('i', { ctrlKey: true });
    expect(within(sideArea()!).getByRole('tab', { name: 'Session info' }).getAttribute('aria-selected')).toBe('true');
  });

  it('closes on Esc, the focus going back where it was', () => {
    window.innerWidth = 1000;
    renderApp();
    openSession();
    const toggle = within(header()).getByRole('button', { name: 'Show the Side area' });
    toggle.focus();
    fireEvent.click(toggle);
    expect(sideArea()).toBeTruthy();
    press('Escape');
    expect(sideArea()).toBeNull();
    expect(document.activeElement).toBe(within(header()).getByRole('button', { name: 'Show the Side area' }));
  });

  it("leaves Esc to a menu open in it", () => {
    window.innerWidth = 1000;
    renderApp();
    openSession();
    fireEvent.click(within(header()).getByRole('button', { name: 'Show the Side area' }));
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Add a Panel to the Side area' }));
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Add a Panel to the Side area' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sideArea()).toBeTruthy();
  });

  it('opens when a Panel is shown in it, and Ctrl+B, d and Ctrl+I open and close it', () => {
    window.innerWidth = 1000;
    const main = renderApp({ side: { open: false } });
    openSession();
    press('i', { ctrlKey: true });
    expect(sideArea()!.classList.contains('drawer')).toBe(true);
    expect(within(sideArea()!).getByRole('tab', { name: 'Session info' }).getAttribute('aria-selected')).toBe('true');
    press('i', { ctrlKey: true });
    expect(sideArea()).toBeNull();

    (document.activeElement as HTMLElement | null)?.blur();
    press('d');
    expect(within(sideArea()!).getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true');
    press('b', { ctrlKey: true });
    expect(sideArea()).toBeNull();
    press('b', { ctrlKey: true });
    expect(sideArea()).toBeTruthy();
    // Showing a Panel shows the area for the Session in a wide window too.
    expect(kept(main).at(0)).toEqual({ panels: ['changes', 'info'], shown: 'info', open: true });
  });

  it('is closed by opening another Session, and when the window crosses the breakpoint', () => {
    window.innerWidth = 1000;
    renderApp({ side: { panels: ['changes'], shown: 'changes', open: true } });
    openSession();
    fireEvent.click(within(header()).getByRole('button', { name: 'Show the Side area' }));
    expect(sideArea()).toBeTruthy();
    openSession('Fix billing');
    expect(sideArea()).toBeNull();

    openSession();
    expect(sideArea()).toBeNull();
    fireEvent.click(within(header()).getByRole('button', { name: 'Show the Side area' }));
    // Wider: beside the conversation again, as the Session has it.
    resizeWindow(1200);
    expect(sideArea()!.classList.contains('drawer')).toBe(false);
    // Narrower again: the drawer starts closed.
    resizeWindow(1000);
    expect(sideArea()).toBeNull();
  });

  it('covers at most 94% of the conversation', () => {
    window.innerWidth = 1000;
    renderApp({ side: { panels: ['changes'], shown: 'changes', open: true } });
    openSession();
    fireEvent.click(within(header()).getByRole('button', { name: 'Show the Side area' }));
    // Changes prefers 640px; the conversation is 1000 - 360 = 640px wide.
    expect(sideArea()!.style.width).toBe('601px');
  });
});

describe('the Inbox', () => {
  it('collapses to a rail and comes back, by its buttons and Ctrl+Shift+B, kept in settings', () => {
    const main = renderApp();
    fireEvent.click(within(inbox()).getByRole('button', { name: 'Collapse the Inbox' }));
    expect(inbox().classList.contains('rail')).toBe(true);
    expect(within(inbox()).queryByRole('button', { name: 'Fix login' })).toBeNull();
    expect(inboxWidth()).toBe('48px');
    // Its actions stay at hand.
    expect(within(inbox()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Show the Inbox', 'New', 'Search Sessions and actions', 'Projects', 'Dashboard', 'Settings']);
    expect(within(inbox()).getByRole('button', { name: 'Show the Inbox' }).getAttribute('aria-description')).toBe('2 Waiting');

    fireEvent.click(within(inbox()).getByRole('button', { name: 'Show the Inbox' }));
    expect(within(inbox()).getByRole('button', { name: 'Fix login' })).toBeTruthy();
    press('b', { ctrlKey: true, shiftKey: true, key: 'B' });
    expect(inbox().classList.contains('rail')).toBe(true);
    press('b', { ctrlKey: true, shiftKey: true, key: 'B' });
    expect(inbox().classList.contains('rail')).toBe(false);
    expect(inboxCalls(main)).toEqual([{ open: false }, { open: true }, { open: false }, { open: true }]);
  });

  it('opens collapsed when settings say so', () => {
    renderApp({ inbox: { width: 300, open: false } });
    expect(inbox().classList.contains('rail')).toBe(true);
  });

  it('is resized by its right edge, kept once let go, and back to 360px on a double click', () => {
    const main = renderApp({ inbox: { width: 300, open: true } });
    expect(inboxWidth()).toBe('300px');
    const edge = within(inbox()).getByRole('separator', { name: 'Resize the Inbox' });
    fireEvent.mouseDown(edge, { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 340 });
    expect(inboxWidth()).toBe('340px');
    expect(inboxCalls(main)).toEqual([]);
    fireEvent.mouseUp(window, { clientX: 350 });
    expect(inboxCalls(main)).toEqual([{ width: 350 }]);

    fireEvent.mouseDown(edge, { clientX: 350 });
    fireEvent.mouseUp(window, { clientX: 0 });
    expect(inboxCalls(main).at(-1)).toEqual({ width: 240 });

    fireEvent.doubleClick(edge);
    expect(inboxWidth()).toBe('360px');
    expect(inboxCalls(main).at(-1)).toEqual({ width: 360 });

    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(inboxCalls(main).at(-1)).toEqual({ width: 384 });
  });

  it('gives way to the conversation, and in a wide window to the Side area, in a smaller window', () => {
    renderApp({ inbox: { width: 560, open: true } });
    // 1440px: room for all of it.
    expect(inboxWidth()).toBe('560px');
    // 1100px: the conversation's 360px and a Panel's least, 320px, come first.
    resizeWindow(1100);
    expect(inboxWidth()).toBe('420px');
    expect(within(inbox()).getByRole('separator', { name: 'Resize the Inbox' }).getAttribute('aria-valuemax')).toBe('420');
    // 720px, the smallest window: the conversation's 360px only, the Side area being a drawer.
    resizeWindow(720);
    expect(inboxWidth()).toBe('360px');
  });

  it('leaves the Side area what the conversation does not need', () => {
    renderApp({ inbox: { width: 240, open: true }, side: { panels: ['changes'], shown: 'changes', open: true } });
    resizeWindow(1100);
    openSession();
    // 1100 - 240 - 360.
    expect(sideArea()!.style.width).toBe('500px');
    fireEvent.click(within(inbox()).getByRole('button', { name: 'Collapse the Inbox' }));
    // Changes at its preferred 640px fits beside the rail.
    expect(sideArea()!.style.width).toBe('640px');
  });
});
