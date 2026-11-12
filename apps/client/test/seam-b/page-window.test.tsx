import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(() => {
  cleanup();
  window.innerWidth = 1440;
});

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'no-remote', checking: false },
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
  createdAt: 1,
  updatedAt: 10 - id,
});

function renderApp() {
  const main = new FakeMain({ projects: [project], sessions: [session(1, 'Fix login'), session(2, 'Fix billing')] });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const inbox = () => screen.getByRole('complementary', { name: 'Inbox' });
const openSession = (title: string) => fireEvent.click(within(inbox()).getByRole('button', { name: title }));
const pageButton = (name: string) => within(within(inbox()).getByRole('navigation')).getByRole('button', { name });
const page = (name: string) => screen.queryByRole('dialog', { name });
const prompt = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' });
const press = (key: string, target: Element = document.activeElement ?? document.body) => fireEvent.keyDown(target, { key });

describe('Projects, the Dashboard and Settings', () => {
  it('open in a window over the open Session, which stays as it was beneath, and Esc closes it', () => {
    renderApp();
    openSession('Fix login');
    fireEvent.change(prompt(), { target: { value: 'half a thought' } });
    const settings = pageButton('Settings');
    settings.focus();

    fireEvent.click(settings);
    expect(page('Settings')).toBeTruthy();
    expect(settings.getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(page('Settings'));
    // The Session is still there, its draft with it, and still the one picked in the Inbox.
    expect(screen.getByRole('main', { name: 'Session' })).toBeTruthy();
    expect(prompt().value).toBe('half a thought');
    expect(within(inbox()).getByRole('button', { name: 'Fix login' }).getAttribute('aria-current')).toBe('true');

    press('Escape');
    expect(page('Settings')).toBeNull();
    expect(settings.getAttribute('aria-current')).toBeNull();
    expect(document.activeElement).toBe(settings);
    expect(prompt().value).toBe('half a thought');
  });

  it('close with their close button or a click beside the window', () => {
    renderApp();
    fireEvent.click(pageButton('Dashboard'));
    fireEvent.click(within(page('Dashboard')!).getByRole('button', { name: 'Close Dashboard' }));
    expect(page('Dashboard')).toBeNull();

    fireEvent.click(pageButton('Projects'));
    fireEvent.mouseDown(document.querySelector('.page-window-scrim')!);
    expect(page('Projects')).toBeNull();
  });

  it('take each other’s place in the one window, and going to a Session closes it', () => {
    renderApp();
    openSession('Fix login');
    fireEvent.click(pageButton('Projects'));
    fireEvent.click(pageButton('Dashboard'));
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-label'))).toEqual(['Dashboard']);

    openSession('Fix billing');
    expect(page('Dashboard')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Session header' })).getByText('Fix billing')).toBeTruthy();
  });

  it('leave an Esc a field, menu or dialog in them takes to it', async () => {
    renderApp();
    fireEvent.click(pageButton('Settings'));
    const search = within(page('Settings')!).getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'theme' } });
    press('Escape', search);
    expect((search as HTMLInputElement).value).toBe('');
    expect(page('Settings')).toBeTruthy();

    fireEvent.click(pageButton('Projects'));
    fireEvent.click(within(page('Projects')!).getByRole('button', { name: 'Remove billing-api' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove billing-api?' });
    press('Escape', dialog);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(page('Projects')).toBeTruthy();
  });

  it('keep the open Session’s actions from the Session beneath', () => {
    const main = renderApp();
    openSession('Fix login');
    fireEvent.click(pageButton('Settings'));
    press('e', document.body);
    press('d', document.body);
    expect(main.invoked.map((i) => i.command)).not.toContain('sessions.archive');
    expect(screen.getByRole('tabpanel', { name: 'Changes' })).toBeTruthy();
  });

  it('leave the Session beneath out of reach of the keyboard and pointer', () => {
    renderApp();
    openSession('Fix login');
    fireEvent.click(pageButton('Settings'));
    expect(screen.getByRole('main', { name: 'Session' }).closest('[inert]')).toBeTruthy();
    press('Escape');
    expect(screen.getByRole('main', { name: 'Session' }).closest('[inert]')).toBeNull();
  });

  it('stay open when Esc closes a picker opened over them', () => {
    renderApp();
    fireEvent.click(pageButton('Projects'));
    fireEvent.keyDown(document.activeElement!, { key: 'n', ctrlKey: true });
    const picker = screen.getByRole('dialog', { name: 'Pick a Project' });
    press('Escape', within(picker).getByRole('combobox'));
    expect(screen.queryByRole('dialog', { name: 'Pick a Project' })).toBeNull();
    expect(page('Projects')).toBeTruthy();
  });

  it('come back when a New Session started from one is cancelled, focus going back where it was before', () => {
    renderApp();
    const projects = pageButton('Projects');
    projects.focus();
    fireEvent.click(projects);
    fireEvent.keyDown(document.activeElement!, { key: 'n', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter Projects' }), { key: 'Enter' });
    const newSession = screen.getByRole('main', { name: 'New Session' });
    expect(page('Projects')).toBeNull();

    fireEvent.click(within(newSession).getByRole('button', { name: 'Cancel' }));
    expect(page('Projects')).toBeTruthy();
    press('Escape');
    expect(document.activeElement).toBe(projects);
  });

  it('take all the room beside the Inbox in a narrow window', () => {
    act(() => {
      window.innerWidth = 900;
      window.dispatchEvent(new Event('resize'));
    });
    renderApp();
    fireEvent.click(pageButton('Settings'));
    expect(document.querySelector('.page-window-scrim')!.classList.contains('narrow')).toBe(true);
  });
});
