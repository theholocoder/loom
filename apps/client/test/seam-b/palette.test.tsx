import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

function renderApp(main = new FakeMain()) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const billing: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const web: Project = {
  id: 2,
  name: 'web-app',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/web-app' },
  forge: { state: 'no-remote', checking: false },
};

function session(id: number, fields: Partial<Session>): Session {
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
    updatedAt: 1,
    ...fields,
  };
}

const ctrlK = () => fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
const press = (key: string, target: Element = document.body) => fireEvent.keyDown(target, { key });
const palette = () => screen.getByRole('dialog', { name: 'Command palette' });
const search = () => within(palette()).getByRole('combobox', { name: 'Search Sessions and actions' }) as HTMLInputElement;
const type = (text: string) => fireEvent.change(search(), { target: { value: text } });
const actionNames = () => within(within(palette()).queryByRole('group', { name: 'Actions' }) ?? document.createElement('div')).queryAllByRole('option').map((o) => o.getAttribute('aria-label'));
const sessionNames = () => within(within(palette()).queryByRole('group', { name: 'Sessions' }) ?? document.createElement('div')).queryAllByRole('option').map((o) => o.getAttribute('aria-label'));

describe('the Ctrl+K palette', () => {
  it('opens on Ctrl+K and from the sidebar search box, focused on its search, and Escape closes it', () => {
    renderApp();

    ctrlK();
    expect(document.activeElement).toBe(search());
    press('Escape', search());
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Search Sessions and actions' }));
    expect(palette()).toBeTruthy();
    // Ctrl+K again closes it.
    fireEvent.keyDown(search(), { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });
});

describe('palette actions', () => {
  it('lists only the actions there is something for, with their shortcut keys', () => {
    renderApp(new FakeMain({ projects: [web] }));
    ctrlK();

    // No Session open, none waiting, no Project on a Forge.
    expect(actionNames()).toEqual([
      'New Session',
      'Add Project from existing clone…',
      'Toggle changes panel',
      'Theme: Midnight',
      'Theme: Paper',
      'Theme: Nord',
      'Theme: Mocha',
      'Theme: Daylight',
      'Open Projects',
      'Open Settings',
    ]);
    const keys = (name: string) => within(within(palette()).getByRole('option', { name })).queryByText((_, el) => el?.tagName === 'KBD')?.textContent;
    expect(keys('New Session')).toBe('N');
    expect(keys('Add Project from existing clone…')).toBe('P');
    expect(keys('Toggle changes panel')).toBe('D');
    expect(keys('Open Settings')).toBe(',');
  });

  it('adds the open Session’s actions, next Waiting and starting from an issue when they apply', () => {
    renderApp(new FakeMain({ projects: [billing, web], sessions: [session(1, { title: 'Fix login' }), session(2, { title: 'Other' })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));
    ctrlK();

    expect(actionNames()).toEqual([
      'New Session',
      'New Session from an issue…',
      'Add Project from existing clone…',
      'Go to next Waiting Session',
      'Create Merge request for this Session',
      'Toggle changes panel',
      'Archive this Session',
      'Theme: Midnight',
      'Theme: Paper',
      'Theme: Nord',
      'Theme: Mocha',
      'Theme: Daylight',
      'Open Projects',
      'Open Settings',
    ]);
  });

  it('filters the actions by what is typed, and Enter runs the highlighted one', async () => {
    const main = renderApp();
    ctrlK();

    type('paper');
    expect(actionNames()).toEqual(['Theme: Paper']);
    press('Enter', search());

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    await waitFor(() => expect(main.value('settings').theme).toBe('paper'));
  });

  it('moves the highlight with the arrow keys and runs an action on click', () => {
    renderApp();
    ctrlK();
    type('theme');
    const highlighted = () => within(palette()).getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label');
    expect(highlighted()).toBe('Theme: Midnight');
    press('ArrowDown', search());
    press('ArrowDown', search());
    expect(highlighted()).toBe('Theme: Nord');
    press('ArrowUp', search());
    expect(highlighted()).toBe('Theme: Paper');
    expect(search().getAttribute('aria-activedescendant')).toBe(within(palette()).getByRole('option', { name: 'Theme: Paper' }).id);

    type('settings');
    fireEvent.click(within(palette()).getByRole('option', { name: 'Open Settings' }));
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
  });
});

const runAction = (name: string) => {
  ctrlK();
  fireEvent.click(within(palette()).getByRole('option', { name }));
};
const openSessionTitle = () => within(screen.getByRole('region', { name: 'Session header' })).getByRole('heading').textContent;

describe('running palette actions', () => {
  it('goes to the next Waiting Session in Inbox order, wrapping round', () => {
    renderApp(
      new FakeMain({
        projects: [billing, web],
        sessions: [
          session(1, { title: 'Web older', projectId: 2, updatedAt: 1 }),
          session(2, { title: 'Billing', projectId: 1, updatedAt: 5 }),
          session(3, { title: 'Web newer', projectId: 2, updatedAt: 9 }),
          session(4, { title: 'Busy', status: 'working', waitingReason: undefined }),
        ],
      }),
    );

    runAction('Go to next Waiting Session');
    expect(openSessionTitle()).toBe('Billing');
    runAction('Go to next Waiting Session');
    expect(openSessionTitle()).toBe('Web newer');
    runAction('Go to next Waiting Session');
    expect(openSessionTitle()).toBe('Web older');
    runAction('Go to next Waiting Session');
    expect(openSessionTitle()).toBe('Billing');
  });

  it('archives the open Session, warning first about unsaved work', async () => {
    const main = renderApp(
      new FakeMain({ projects: [billing], sessions: [session(1, { title: 'Fix login' })] }, {
        'sessions.archive': ({ discard }) => (discard ? { archived: true } : { archived: false, unsavedWork: { uncommitted: true, unpushedCommits: 0, detached: false } }),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));

    runAction('Archive this Session');
    const warning = await screen.findByRole('alertdialog', { name: 'Archive with unsaved work?' });
    fireEvent.click(within(warning).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.archive').map((i) => i.params)).toEqual([{ id: 1 }, { id: 1, discard: true }]));
  });

  it('shows in the Session why an action on it failed', async () => {
    renderApp(
      new FakeMain({ projects: [billing], sessions: [session(1, { title: 'Fix login' })] }, {
        'sessions.requestMergeRequest': () => {
          throw new Error('The agent is not running');
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));

    runAction('Create Merge request for this Session');
    expect((await within(screen.getByRole('main', { name: 'Session' })).findByRole('alert')).textContent).toBe('The agent is not running');
  });

  it('opens the linked Merge request instead of asking for one', async () => {
    const url = 'https://github.com/acme/billing-api/pull/12';
    const main = renderApp(new FakeMain({ projects: [billing], sessions: [session(1, { title: 'Fix login', mergeRequest: { number: 12, url } })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));

    runAction('Open Merge request #12 for this Session');
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'links.open', params: { url } }));
  });

  it('starts from an issue: picks among the Projects on a Forge, then opens the issue list', async () => {
    renderApp(new FakeMain({ projects: [billing, web] }, { 'projects.issues': () => [{ number: 31, title: 'Fix the login bug', body: '', url: 'u' }] }));

    runAction('New Session from an issue…');
    const picker = screen.getByRole('dialog', { name: 'Pick a Project' });
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('billing-api')]);
    fireEvent.keyDown(within(picker).getByRole('combobox'), { key: 'Enter' });

    const issues = await screen.findByRole('listbox', { name: 'Open issues' });
    expect((await within(issues).findByRole('option')).textContent).toContain('Fix the login bug');
  });

  it('adds a Project from an existing clone through the folder dialog', async () => {
    const main = renderApp(new FakeMain());
    runAction('Add Project from existing clone…');
    await waitFor(() => expect(main.invoked.map((i) => i.command)).toContain('dialogs.chooseFolder'));
    expect(screen.getByRole('button', { name: 'Projects' }).getAttribute('aria-current')).toBe('page');
  });

  it('puts focus back where it was when closed without running anything', () => {
    renderApp();
    const settings = screen.getByRole('button', { name: 'Settings' });
    settings.focus();
    ctrlK();
    press('Escape', search());
    expect(document.activeElement).toBe(settings);
  });
});

describe('shortcuts', () => {
  const twoWaiting = () => new FakeMain({ projects: [billing], sessions: [session(1, { title: 'First', updatedAt: 9 }), session(2, { title: 'Second', updatedAt: 1 })] });

  it('j goes to the next Waiting Session, d toggles the changes panel, e archives', async () => {
    const main = renderApp(twoWaiting());

    press('j');
    expect(openSessionTitle()).toBe('First');
    press('j');
    expect(openSessionTitle()).toBe('Second');

    press('d');
    expect(screen.getByRole('region', { name: 'Changes' })).toBeTruthy();
    press('d');
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();

    press('e');
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'sessions.archive', params: { id: 2 } }));
  });

  it('n starts a New Session, p adds a Project, comma opens Settings', async () => {
    const main = renderApp(twoWaiting());

    press('n');
    const filter = screen.getByRole('combobox', { name: 'Filter Projects' });
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(screen.getByRole('main', { name: 'New Session' })).toBeTruthy();

    press(',');
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');

    press('p');
    await waitFor(() => expect(main.invoked.map((i) => i.command)).toContain('dialogs.chooseFolder'));
  });

  it('are left alone while typing, with a modifier held, or while a dialog is open', () => {
    renderApp(twoWaiting());
    press('j');
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });

    press('j', prompt);
    fireEvent.keyDown(document.body, { key: 'j', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'J', shiftKey: true });
    expect(openSessionTitle()).toBe('First');

    ctrlK();
    press('j', palette());
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    expect(openSessionTitle()).toBe('First');
    press('Escape', search());

    press('n');
    press('j', screen.getByRole('dialog', { name: 'Pick a Project' }));
    expect(openSessionTitle()).toBe('First');
  });

  it('do nothing when their action does not apply', () => {
    const main = renderApp(new FakeMain({ sessions: [session(1, { title: 'Done', status: 'archived', waitingReason: undefined })] }));
    press('j');
    expect(screen.queryByRole('region', { name: 'Session header' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    press('e');
    expect(main.invoked.map((i) => i.command)).not.toContain('sessions.archive');
  });
});

describe('Session search', () => {
  const sessions = [
    session(1, { title: 'Fix login', branch: 'loom/fix-login', issue: { number: 31, url: 'u' }, updatedAt: 3 }),
    session(2, { title: 'Dark mode', projectId: 2, status: 'working', waitingReason: undefined, updatedAt: 5 }),
    session(3, { title: 'Old invoice export', status: 'archived', waitingReason: undefined, mergeRequest: { number: 12, url: 'u' }, updatedAt: 9 }),
    session(4, { title: 'Login copy', projectId: 2, unread: true, updatedAt: 1 }),
  ];
  const open = () => {
    renderApp(new FakeMain({ projects: [billing, web], sessions }));
    ctrlK();
  };

  it('lists every Session, Waiting first, then Working, then Archived, most recent first in each', () => {
    open();
    expect(sessionNames()).toEqual(['Fix login', 'Login copy', 'Dark mode', 'Old invoice export']);
  });

  it('finds Sessions by title, branch, Project and issue or Merge request number, archived ones too', () => {
    open();
    type('login');
    expect(sessionNames()).toEqual(['Fix login', 'Login copy']);
    type('loom/fix');
    expect(sessionNames()).toEqual(['Fix login']);
    type('web-app');
    expect(sessionNames()).toEqual(['Login copy', 'Dark mode']);
    type('#31');
    expect(sessionNames()).toEqual(['Fix login']);
    type('#12');
    expect(sessionNames()).toEqual(['Old invoice export']);
    type('invoice');
    expect(sessionNames()).toEqual(['Old invoice export']);
  });

  it('narrows with is:, project: and has: filters, which hide the actions', () => {
    open();
    type('is:archived');
    expect(actionNames()).toEqual([]);
    expect(sessionNames()).toEqual(['Old invoice export']);
    type('is:working');
    expect(sessionNames()).toEqual(['Dark mode']);
    type('is:waiting');
    expect(sessionNames()).toEqual(['Fix login', 'Login copy']);
    type('is:unread');
    expect(sessionNames()).toEqual(['Login copy']);
    type('project:web');
    expect(sessionNames()).toEqual(['Login copy', 'Dark mode']);
    type('has:mr');
    expect(sessionNames()).toEqual(['Old invoice export']);
    type('has:issue');
    expect(sessionNames()).toEqual(['Fix login']);
    type('project:web login');
    expect(sessionNames()).toEqual(['Login copy']);
    type('is:waiting project:billing');
    expect(sessionNames()).toEqual(['Fix login']);
    type('IS:Archived');
    expect(sessionNames()).toEqual(['Old invoice export']);
    type('is:nonsense');
    expect(sessionNames()).toEqual([]);
    expect(within(palette()).getByText('No match.')).toBeTruthy();
  });

  it('toggles filters from their chips', () => {
    open();
    const chip = (name: string) => within(palette()).getByRole('button', { name });
    fireEvent.click(chip('is:archived'));
    expect(search().value).toBe('is:archived ');
    expect(chip('is:archived').getAttribute('aria-pressed')).toBe('true');
    expect(sessionNames()).toEqual(['Old invoice export']);
    expect(document.activeElement).toBe(search());
    fireEvent.click(chip('is:archived'));
    expect(search().value).toBe('');
    expect(chip('project:web-app')).toBeTruthy();
  });

  it('opens the Session picked, with Enter after the actions', () => {
    open();
    type('invoice');
    press('Enter', search());
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    expect(openSessionTitle()).toBe('Old invoice export');

    ctrlK();
    type('is:waiting');
    fireEvent.click(within(palette()).getByRole('option', { name: 'Login copy' }));
    expect(openSessionTitle()).toBe('Login copy');
  });
});

describe('focus after running an action', () => {
  it('goes back where it was when the action opens nothing', () => {
    renderApp();
    const settings = screen.getByRole('button', { name: 'Settings' });
    settings.focus();
    runAction('Theme: Nord');
    expect(document.activeElement).toBe(settings);
  });
});
