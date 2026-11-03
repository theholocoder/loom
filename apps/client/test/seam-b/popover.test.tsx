import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Issue, Project } from '../../src/shared/api';
import { FakeMain } from './fake-main';

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const issues: Issue[] = [1, 2, 3].map((n) => ({ number: n, title: `Issue ${n}`, body: '', url: `https://github.com/acme/billing-api/issues/${n}` }));

const VIEWPORT = { width: 800, height: 300 };
/** Where the composer's trigger buttons sit, set per test. */
let triggerTop = 0;

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.classList.contains('pick') ? triggerTop : 0;
    const height = this.classList.contains('pick') ? 24 : 0;
    return { top, bottom: top + height, left: 20, right: 120, width: this.classList.contains('pick') ? 100 : 0, height, x: 20, y: top, toJSON: () => ({}) };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function startNewSession() {
  render(
    <ApiProvider api={new FakeMain({ projects: [project] }, { 'projects.issues': () => issues })}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
  return screen.getByRole('main', { name: 'New Session' });
}

const px = (value: string) => Number(value.replace('px', ''));

describe.each([
  ['the working-copy choice', 'Working copy', 'listbox', 'Working copy'],
  ['the issue picker', 'Issue', 'dialog', 'Pick an issue'],
])('%s', (_, trigger, role, name) => {
  it('opens upward with its height capped when the trigger is near the bottom of the window', () => {
    triggerTop = 260;
    const pane = startNewSession();
    fireEvent.click(within(pane).getByRole('button', { name: trigger }));
    const popover = screen.getByRole(role, { name });
    expect(popover.classList).toContain('popover');
    expect(popover.dataset.side).toBe('up');
    expect(px(popover.style.bottom)).toBe(VIEWPORT.height - triggerTop + 4);
    expect(px(popover.style.maxHeight)).toBeLessThanOrEqual(triggerTop - 4);
    expect(popover.style.top).toBe('');
  });

  it('opens downward when the trigger is near the top', () => {
    triggerTop = 20;
    const pane = startNewSession();
    fireEvent.click(within(pane).getByRole('button', { name: trigger }));
    const popover = screen.getByRole(role, { name });
    expect(popover.dataset.side).toBe('down');
    expect(px(popover.style.top)).toBe(triggerTop + 24 + 4);
    expect(px(popover.style.maxHeight)).toBeLessThanOrEqual(VIEWPORT.height - triggerTop - 24);
  });

  it('closes on Escape, returning focus to its trigger', () => {
    const pane = startNewSession();
    const button = within(pane).getByRole('button', { name: trigger });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole(role, { name })).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a click outside', () => {
    const pane = startNewSession();
    fireEvent.click(within(pane).getByRole('button', { name: trigger }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole(role, { name })).toBeNull();
  });
});

describe('keyboard', () => {
  it('moves through the working-copy choices with the arrows and picks with Enter', () => {
    const pane = startNewSession();
    const button = within(pane).getByRole('button', { name: 'Working copy' });
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    fireEvent.click(button);
    const [worktree, checkout] = screen.getAllByRole('option');
    expect(document.activeElement).toBe(worktree);
    fireEvent.keyDown(worktree!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(checkout);
    fireEvent.keyDown(checkout!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(worktree);
    fireEvent.keyDown(worktree!, { key: 'End' });
    fireEvent.keyDown(checkout!, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(button.textContent).toBe('Stay on current branch');
    expect(within(pane).queryByRole('textbox', { name: 'Branch' })).toBeNull();
  });

  it('goes from the issue search into the list with ArrowDown and picks with Enter', async () => {
    const pane = startNewSession();
    fireEvent.click(within(pane).getByRole('button', { name: 'Issue' }));
    const search = screen.getByRole('textbox', { name: 'Search issues' });
    expect(document.activeElement).toBe(search);
    await screen.findByRole('option', { name: '#1 Issue 1' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: '#1 Issue 1' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(within(pane).getByTitle(issues[1]!.url).textContent).toContain('#2 Issue 2');
  });
});
