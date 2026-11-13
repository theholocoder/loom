// Keybindings, from the window's side: Settings remaps a shortcut by
// pressing its new keys, takes off one, or turns the single-key ones off, and
// the window, the palette and the Ctrl+? list follow the user's shortcuts.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session } from '../../src/shared/api';
import type { KeybindingSettings } from '../../src/shared/shortcuts';
import { settingsPage } from './settings-page';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'billing-api',
  color: 'blue',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};

function session(id: number): Session {
  return {
    id,
    projectId: 1,
    title: `Session ${id}`,
    workingCopy: { kind: 'worktree', path: `/home/dev/loom/worktrees/s${id}` },
    agent: 'OpenCode',
    status: 'waiting',
    waitingReason: 'finished',
    unread: false,
    createdAt: 1,
    updatedAt: 10 - id,
  };
}

function renderApp(keybindings?: KeybindingSettings) {
  const main = new FakeMain({ projects: [project], sessions: [session(1), session(2)], ...(keybindings ? { settings: { ...DEFAULT_SETTINGS, keybindings } } : {}) });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const press = (key: string, more: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; code?: string } = {}, target: Element = document.activeElement ?? document.body) =>
  fireEvent.keyDown(target, { key, ...more });
const calls = (main: FakeMain, command: string) => main.invoked.filter((i) => i.command === command).map((i) => i.params);
const openSessionTitle = () => within(screen.getByRole('region', { name: 'Session header' })).getByRole('heading').textContent;
const openSettings = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  settingsPage('Keybindings');
};
const closeSettings = () => fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }));
const keybindings = () => screen.getByRole('region', { name: 'Keybindings' });
/** The keys a setting's row shows for its action, or None. */
const shownKeys = (label: string) => {
  const row = within(keybindings()).getByRole('button', { name: `Change the shortcut for ${label}` }).closest('.keybinding') as HTMLElement;
  return (row.querySelector('kbd') ?? row.querySelector('.muted'))?.textContent;
};
const change = (label: string) => fireEvent.click(within(keybindings()).getByRole('button', { name: `Change the shortcut for ${label}` }));
const recorder = (label: string) => within(keybindings()).getByRole('button', { name: `New shortcut for ${label}: press it` });
const helpRows = () => {
  fireEvent.keyDown(document.body, { key: '?', ctrlKey: true, shiftKey: true });
  const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
  const rows = within(help)
    .queryAllByRole('row')
    .filter((r) => within(r).queryAllByRole('cell').length)
    .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
  fireEvent.keyDown(within(help).getByRole('searchbox'), { key: 'Escape' });
  return rows;
};

describe('the Keybindings section of Settings', () => {
  it("shows each action's shortcut, and remaps one to the keys pressed, which then run it in its place", async () => {
    const main = renderApp();
    press('j', {}, document.body);
    expect(openSessionTitle()).toBe('Session 1');
    openSettings();
    expect(shownKeys('Archive this Session')).toBe('E');
    expect(shownKeys('Open the command palette')).toBe('Ctrl K');

    change('Archive this Session');
    expect(document.activeElement).toBe(recorder('Archive this Session'));
    // Shift and Ctrl alone wait for the key.
    press('Shift', { shiftKey: true });
    press('Control', { ctrlKey: true, shiftKey: true });
    press('X', { ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(calls(main, 'settings.setKeybinding')).toEqual([{ name: 'archive', shortcut: { key: 'x', ctrl: true, shift: true } }]));
    await waitFor(() => expect(shownKeys('Archive this Session')).toBe('Ctrl Shift X'));
    expect(document.activeElement).toBe(within(keybindings()).getByRole('button', { name: 'Change the shortcut for Archive this Session' }));
    expect(within(keybindings()).getByRole('button', { name: 'Reset the shortcut for Archive this Session to E' })).toBeTruthy();
    closeSettings();

    press('e', {}, document.body);
    expect(calls(main, 'sessions.archive')).toEqual([]);
    press('X', { ctrlKey: true, shiftKey: true }, document.body);
    expect(calls(main, 'sessions.archive')).toEqual([{ id: 1 }]);
  });

  it('says which action a shortcut was taken from, which is left with none', async () => {
    const main = renderApp();
    press('j', {}, document.body);
    openSettings();

    change('Archive this Session');
    press('n', { ctrlKey: true });

    await waitFor(() => expect(within(keybindings()).getByText('Taken from “New Session”, now with none.')).toBeTruthy());
    expect(shownKeys('New Session')).toBe('None');
    expect(shownKeys('Archive this Session')).toBe('Ctrl N');
    closeSettings();
    press('n', { ctrlKey: true }, document.body);
    expect(calls(main, 'sessions.archive')).toEqual([{ id: 1 }]);
  });

  it('leaves the shortcut as it was on Escape, keeping Settings open, and says why it refuses keys', async () => {
    const main = renderApp();
    openSettings();

    change('Reply to this Session');
    const refusal = () => within(keybindings()).queryByRole('alert')?.textContent;
    press('Enter');
    await waitFor(() => expect(refusal()).toMatch(/Without Ctrl/));
    press('1', { ctrlKey: true, code: 'Digit1' });
    await waitFor(() => expect(refusal()).toBe('Ctrl 1…9 open the Waiting Sessions in the Inbox.'));
    press('r', { altKey: true });
    await waitFor(() => expect(refusal()).toMatch(/Alt/));
    press('c', { ctrlKey: true });
    await waitFor(() => expect(refusal()).toBe('Text fields keep Ctrl C for themselves.'));
    // Still pressing: Escape stops, and the Settings window stays.
    press('Escape');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(within(keybindings()).queryByRole('button', { name: 'New shortcut for Reply to this Session: press it' })).toBeNull();
    expect(shownKeys('Reply to this Session')).toBe('R');
    expect(calls(main, 'settings.setKeybinding')).toEqual([]);
  });

  it('takes a shortcut off, and resets it to Loom’s own', async () => {
    const main = renderApp();
    openSettings();

    fireEvent.click(within(keybindings()).getByRole('button', { name: 'Remove the shortcut for Toggle diff' }));
    await waitFor(() => expect(shownKeys('Toggle diff')).toBe('None'));
    expect(calls(main, 'settings.setKeybinding')).toEqual([{ name: 'toggleDiff', shortcut: null }]);

    fireEvent.click(within(keybindings()).getByRole('button', { name: 'Reset the shortcut for Toggle diff to D' }));
    await waitFor(() => expect(shownKeys('Toggle diff')).toBe('D'));
  });

  it('turns the single-key shortcuts off, and resets them all', async () => {
    const main = renderApp();
    openSettings();
    const singleKeys = within(keybindings()).getByRole('checkbox', { name: 'Single-key shortcuts' }) as HTMLInputElement;
    expect(singleKeys.checked).toBe(true);
    expect(within(keybindings()).getByText(/^Loom’s own J, K, R, D, U, E, and any shortcut/)).toBeTruthy();

    fireEvent.click(singleKeys);
    await waitFor(() => expect(singleKeys.checked).toBe(false));
    expect(calls(main, 'settings.setSingleKeyShortcuts')).toEqual([{ on: false }]);
    expect(within(keybindings()).getByLabelText('J, off')).toBeTruthy();
    closeSettings();

    press('j', {}, document.body);
    press('e', {}, document.body);
    expect(screen.queryByRole('region', { name: 'Session header' })).toBeNull();
    expect(calls(main, 'sessions.archive')).toEqual([]);

    openSettings();
    fireEvent.click(within(keybindings()).getByRole('button', { name: 'Reset all shortcuts' }));
    await waitFor(() => expect((within(keybindings()).getByRole('checkbox', { name: 'Single-key shortcuts' }) as HTMLInputElement).checked).toBe(true));
    closeSettings();
    press('j', {}, document.body);
    expect(openSessionTitle()).toBe('Session 1');
  });

  it('are found by searching Settings for an action or its keys', () => {
    renderApp();
    openSettings();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'archive' } });
    expect(within(keybindings()).getByRole('button', { name: 'Change the shortcut for Archive this Session' })).toBeTruthy();
    expect(within(keybindings()).queryByRole('button', { name: 'Change the shortcut for New Session' })).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'ctrl shift n' } });
    expect(within(keybindings()).getByRole('button', { name: 'Change the shortcut for New Session from an issue…' })).toBeTruthy();
  });
});

describe('the shortcuts as the user has them', () => {
  const remapped: KeybindingSettings = { remapped: { palette: { key: 'p', ctrl: true, shift: true }, toggleDiff: null }, singleKeys: false };

  it('are what the Ctrl+? list shows, without those taken off or turned off', () => {
    renderApp(remapped);
    const rows = helpRows();
    expect(rows).toContainEqual(['Open the command palette', 'Ctrl Shift P']);
    expect(rows.map(([label]) => label)).not.toContain('Toggle diff');
    expect(rows.map(([label]) => label)).not.toContain('Go to next Waiting Session');
    // The composer's own keys don't turn off.
    expect(rows).toContainEqual(['Send the message', 'Enter']);
    expect(rows).toContainEqual(['Open the nth Waiting Session in the Inbox', 'Ctrl 1…9']);
  });

  it('are what the palette and the Inbox search show, and what opens the palette', () => {
    renderApp(remapped);
    const searchButton = screen.getByRole('button', { name: 'Search Sessions and actions' });
    expect(within(searchButton).getByText('Ctrl Shift P')).toBeTruthy();

    press('k', { ctrlKey: true }, document.body);
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    press('P', { ctrlKey: true, shiftKey: true }, document.body);
    const palette = screen.getByRole('dialog', { name: 'Command palette' });
    const keys = (name: string) => within(within(palette).getByRole('option', { name })).queryByText((_, el) => el?.tagName === 'KBD')?.textContent;
    expect(keys('Open Settings')).toBe('Ctrl ,');
    expect(keys('Go to next Waiting Session')).toBeUndefined();
  });

  it('hold back a palette key without Ctrl while the user types, and just after', () => {
    renderApp({ remapped: { palette: { key: 'p' } }, singleKeys: true });
    press('j', {}, document.body);
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    prompt.focus();
    press('p', {}, prompt);
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    // The focus drops out of the prompt box mid-word: what is typed next is still typing.
    prompt.blur();
    press('p', {}, document.body);
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });

  it('follow a change made while the window is open', async () => {
    const main = renderApp();
    act(() => main.publish('settings', { ...DEFAULT_SETTINGS, keybindings: { remapped: { nextWaiting: { key: 'n' } }, singleKeys: true } }));
    press('j', {}, document.body);
    expect(screen.queryByRole('region', { name: 'Session header' })).toBeNull();
    press('n', {}, document.body);
    expect(openSessionTitle()).toBe('Session 1');
  });
});
