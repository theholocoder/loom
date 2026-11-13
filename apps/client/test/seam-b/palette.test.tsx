import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { ConversationMatch, Project, Session } from '../../src/shared/api';
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
      'Add a Project…',
      'Toggle the Inbox',
      'Theme: Midnight',
      'Theme: Paper',
      'Theme: Nord',
      'Theme: Mocha',
      'Theme: Daylight',
      'Open Projects',
      'Open Dashboard',
      'Open Settings',
      'Show keyboard shortcuts',
    ]);
    const keys = (name: string) => within(within(palette()).getByRole('option', { name })).queryByText((_, el) => el?.tagName === 'KBD')?.textContent;
    expect(keys('New Session')).toBe('Ctrl N');
    expect(keys('Add a Project…')).toBe('Ctrl O');
    expect(keys('Open Settings')).toBe('Ctrl ,');
    expect(keys('Toggle the Inbox')).toBe('Ctrl Shift B');
  });

  it('adds the open Session’s actions, next Waiting and starting from an issue when they apply', () => {
    renderApp(new FakeMain({ projects: [billing, web], sessions: [session(1, { title: 'Fix login' }), session(2, { title: 'Other' })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));
    ctrlK();

    expect(actionNames()).toEqual([
      'New Session',
      'New Session from an issue…',
      'Add a Project…',
      'Go to next Waiting Session',
      'Go to previous Waiting Session',
      'Reply to this Session',
      'Create Merge request for this Session',
      'Link Merge request…',
      'Open in editor',
      'Open in terminal',
      'Toggle terminal',
      'Toggle the Inbox',
      'Toggle the Side area',
      'Toggle diff',
      'Toggle Review mode for Changes',
      'Show Session details',
      'Mark this Session unread',
      'Snooze this Session…',
      'Rename this Session…',
      'Archive this Session',
      'Delete this Session…',
      'Theme: Midnight',
      'Theme: Paper',
      'Theme: Nord',
      'Theme: Mocha',
      'Theme: Daylight',
      'Open Projects',
      'Open Dashboard',
      'Open Settings',
      'Show keyboard shortcuts',
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
    fireEvent.click(within(warning).getByRole('button', { name: 'Discard and archive' }));
    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.archive').map((i) => i.params)).toEqual([{ id: 1 }, { id: 1, discard: true }]));
  });

  it('reopens the open archived Session, unless its Project was removed', async () => {
    const main = renderApp(new FakeMain({ projects: [billing], sessions: [session(1, { title: 'Done', status: 'archived', waitingReason: undefined })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    runAction('Reopen this Session');
    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.unarchive').map((i) => i.params)).toEqual([{ id: 1 }]));
    ctrlK();
    expect(within(palette()).queryByRole('option', { name: 'Archive this Session' })).toBeNull();
  });

  it('shows in a toast why an action on the Session failed', async () => {
    renderApp(
      new FakeMain({ projects: [billing], sessions: [session(1, { title: 'Fix login' })] }, {
        'sessions.requestMergeRequest': () => {
          throw new Error('The agent is not running');
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));

    runAction('Create Merge request for this Session');
    expect(within(await screen.findByRole('group', { name: 'What went wrong' })).getByRole('alert').textContent).toBe('The agent is not running');
  });

  it('shows the linked Merge request instead of asking for one, Ctrl+Shift+M hiding it again, and opens it on the Forge', async () => {
    const url = 'https://github.com/acme/billing-api/pull/12';
    const main = renderApp(new FakeMain({ projects: [billing], sessions: [session(1, { title: 'Fix login', mergeRequest: { number: 12, url } })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));

    ctrlK();
    const keys = within(within(palette()).getByRole('option', { name: 'Show Merge request #12 for this Session' })).getByText((_, el) => el?.tagName === 'KBD');
    expect(keys.textContent).toBe('Ctrl Shift M');
    press('Escape', search());
    runAction('Show Merge request #12 for this Session');
    expect(screen.getByRole('tabpanel', { name: 'Merge request' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'M', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByRole('tabpanel', { name: 'Merge request' })).toBeNull());
    expect(main.invoked.map((i) => i.command)).not.toContain('sessions.requestMergeRequest');

    runAction('Open Merge request #12 on GitHub');
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

  it('adds a Project through the folder dialog', async () => {
    const main = renderApp(new FakeMain());
    runAction('Add a Project…');
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

  it('j goes to the next Waiting Session, d toggles the diff, e archives', async () => {
    const main = renderApp(twoWaiting());

    press('j');
    expect(openSessionTitle()).toBe('First');
    press('j');
    expect(openSessionTitle()).toBe('Second');

    // A new Session shows Changes in the Side area.
    expect(screen.getByRole('tabpanel', { name: 'Changes' })).toBeTruthy();
    press('d');
    expect(screen.queryByRole('tabpanel', { name: 'Changes' })).toBeNull();
    press('d');
    expect(screen.getByRole('tabpanel', { name: 'Changes' })).toBeTruthy();

    press('e');
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'sessions.archive', params: { id: 2 } }));
  });

  const ctrl = (key: string, target: Element = document.body) => fireEvent.keyDown(target, { key, ctrlKey: true });

  it('Ctrl+N starts a New Session, Ctrl+O adds a Project, Ctrl+, opens Settings, even while typing', async () => {
    const main = renderApp(twoWaiting());
    press('j');
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });

    ctrl('n', prompt);
    const filter = screen.getByRole('combobox', { name: 'Filter Projects' });
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(screen.getByRole('main', { name: 'New Session' })).toBeTruthy();

    ctrl(',', screen.getByRole('textbox', { name: 'Prompt' }));
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');

    ctrl('o');
    await waitFor(() => expect(main.invoked.map((i) => i.command)).toContain('dialogs.chooseFolder'));
  });

  it('take the Ctrl ones only with Ctrl held, and not while a dialog is open', () => {
    const main = renderApp(twoWaiting());
    press('n');
    press('o');
    press(',');
    expect(screen.queryByRole('dialog', { name: 'Pick a Project' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();

    ctrlK();
    ctrl('o', search());
    expect(main.invoked.map((i) => i.command)).not.toContain('dialogs.chooseFolder');
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

    fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true });
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

  it('shows the Sessions before the actions until something is typed, the first Session highlighted', () => {
    open();
    const groups = () => within(within(palette()).getByRole('listbox', { name: 'Results' })).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    const highlighted = () => within(palette()).getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label');
    expect(groups()).toEqual(['Sessions', 'Actions']);
    expect(highlighted()).toBe('Fix login');
    for (let i = 0; i < 4; i++) press('ArrowDown', search());
    expect(highlighted()).toBe('New Session');
    press('ArrowUp', search());
    press('Enter', search());
    expect(openSessionTitle()).toBe('Old invoice export');

    ctrlK();
    type('o');
    expect(groups()).toEqual(['Actions', 'Sessions']);
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
    // An unknown has: narrows nothing, as if it were still being typed.
    type('');
    const all = sessionNames();
    type('has:nonsense');
    expect(sessionNames()).toEqual(all);
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

describe('searching conversations', () => {
  const sessions = [
    session(1, { title: 'Fix login', updatedAt: 3 }),
    session(2, { title: 'Dark mode', updatedAt: 5 }),
    session(3, { title: 'Old export', status: 'archived', waitingReason: undefined, updatedAt: 9 }),
  ];
  const open = (search: (words: string[]) => ConversationMatch[]) => {
    const main = renderApp(new FakeMain({ projects: [billing], sessions }, { 'sessions.searchConversations': ({ words }) => search(words) }));
    ctrlK();
    return main;
  };
  const excerptOf = (name: string) => within(palette()).getByRole('option', { name }).getAttribute('aria-description') ?? undefined;

  it('finds Sessions by what was said in them, showing where', async () => {
    const main = open((words) => (words.includes('renderer') ? [{ id: 3, words: ['renderer'], excerpt: 'The PDF renderer blocks on fonts.' }] : []));

    type('renderer');
    await waitFor(() => expect(sessionNames()).toEqual(['Old export']));
    expect(excerptOf('Old export')).toBe('The PDF renderer blocks on fonts.');
    expect(main.invoked.filter((i) => i.command === 'sessions.searchConversations').at(-1)?.params).toEqual({ words: ['renderer'] });
  });

  it('takes each word from the title or the conversation, the excerpt only when the conversation gave one', async () => {
    open((words) => [
      { id: 1, words: words.filter((w) => w === 'token'), excerpt: 'The token expires too soon.' },
      { id: 2, words: words.filter((w) => w === 'login' || w === 'token'), excerpt: 'Dark mode broke the login token.' },
    ].filter((m) => m.words.length));

    type('login token');
    await waitFor(() => expect(sessionNames()).toEqual(['Dark mode', 'Fix login']));
    expect(excerptOf('Fix login')).toBe('The token expires too soon.');
    type('login');
    await waitFor(() => expect(excerptOf('Dark mode')).toBe('Dark mode broke the login token.'));
    expect(excerptOf('Fix login')).toBeUndefined();
    // Found in itself first, though Dark mode changed later: the conversations' answer adds after what was shown.
    expect(sessionNames()).toEqual(['Fix login', 'Dark mode']);
  });

  it('keeps what the last answer found while the next is under way, for a word it holds', async () => {
    open((words) => (words.some((w) => 'fonts'.includes(w)) ? [{ id: 3, words, excerpt: 'Blocks on fonts.' }] : []));
    type('fonts');
    await waitFor(() => expect(sessionNames()).toEqual(['Old export']));
    type('font');
    expect(sessionNames()).toEqual(['Old export']);
    type('fontz');
    expect(sessionNames()).toEqual([]);
  });

  it('narrows conversation matches with filters too, and asks nothing for filters alone', async () => {
    const main = open(() => [{ id: 3, words: ['fonts'], excerpt: 'fonts' }, { id: 1, words: ['fonts'], excerpt: 'fonts' }]);
    type('is:archived');
    type('is:archived fonts');
    await waitFor(() => expect(sessionNames()).toEqual(['Old export']));
    expect(main.invoked.filter((i) => i.command === 'sessions.searchConversations').map((i) => i.params)).toEqual([{ words: ['fonts'] }]);
  });

  it('keeps the title matches when the conversation search fails', async () => {
    open(() => {
      throw new Error('database locked');
    });
    type('login');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sessionNames()).toEqual(['Fix login']);
  });
});

describe('snoozed Sessions in the palette', () => {
  const later = Date.now() + 3_600_000;
  const sessions = [session(1, { title: 'Fix login', updatedAt: 3 }), session(2, { title: 'Later', snoozedUntil: later, updatedAt: 5 })];

  it('finds them with is:snoozed, whose chip toggles it', () => {
    renderApp(new FakeMain({ projects: [billing], sessions }));
    ctrlK();
    type('is:snoozed');
    expect(sessionNames()).toEqual(['Later']);
    type('');
    fireEvent.click(within(palette()).getByRole('button', { name: 'is:snoozed' }));
    expect(sessionNames()).toEqual(['Later']);
  });

  it('snoozes the open Session from the palette, and wakes a snoozed one', async () => {
    const main = renderApp(new FakeMain({ projects: [billing], sessions }));
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));

    runAction('Snooze this Session…');
    const menu = screen.getByRole('menu', { name: 'Snooze' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: '1 hour' }));
    await waitFor(() => expect(main.invoked.find((i) => i.command === 'sessions.snooze')?.params).toMatchObject({ id: 1, until: expect.any(Number) }));

    ctrlK();
    type('later');
    press('Enter', search());
    ctrlK();
    expect(actionNames()).not.toContain('Snooze this Session…');
    fireEvent.click(within(palette()).getByRole('option', { name: 'Wake this Session' }));
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'sessions.snooze', params: { id: 2, until: null } }));
  });

  it('offers no Snooze for a Working Session, but Rename', () => {
    renderApp(new FakeMain({ projects: [billing], sessions: [session(1, { title: 'Busy', status: 'working', waitingReason: undefined })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Working' }));
    fireEvent.click(screen.getByRole('button', { name: 'Busy' }));
    ctrlK();
    expect(actionNames()).not.toContain('Snooze this Session…');
    expect(actionNames()).toContain('Rename this Session…');
  });
});

describe('renaming from the palette', () => {
  it('renames the open Session', async () => {
    const main = renderApp(new FakeMain({ projects: [billing], sessions: [session(1, { title: 'Fix login' })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));

    runAction('Rename this Session…');
    const form = screen.getByRole('dialog', { name: 'Rename Session' });
    const title = within(form).getByRole('textbox', { name: 'Title' });
    expect(document.activeElement).toBe(title);
    fireEvent.change(title, { target: { value: 'Fix the login page' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'sessions.rename', params: { id: 1, title: 'Fix the login page' } }));
  });

  it('is not offered once the Project is removed', () => {
    renderApp(new FakeMain({ projects: [], sessions: [session(1, { title: 'Orphan', status: 'archived', waitingReason: undefined })] }));
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: 'Orphan' }));
    ctrlK();
    expect(actionNames()).not.toContain('Rename this Session…');
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

describe('more shortcuts', () => {
  const ctrl = (key: string, more: { shiftKey?: boolean; code?: string } = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ctrlKey: true, ...more });
  const three = () =>
    new FakeMain({
      projects: [billing],
      sessions: [session(1, { title: 'First', updatedAt: 9 }), session(2, { title: 'Second', updatedAt: 5 }), session(3, { title: 'Third', updatedAt: 1 })],
    });

  it('k goes to the previous Waiting Session, wrapping round', () => {
    renderApp(three());
    press('k');
    expect(openSessionTitle()).toBe('Third');
    press('k');
    expect(openSessionTitle()).toBe('Second');
    press('j');
    expect(openSessionTitle()).toBe('Third');
  });

  it('Ctrl+1 to Ctrl+9 open the Inbox Sessions by position, by physical key, even while typing', () => {
    renderApp(three());
    ctrl('2', { code: 'Digit2' });
    expect(openSessionTitle()).toBe('Second');
    // AZERTY: the 3 key types ".
    ctrl('"', { code: 'Digit3' }, screen.getByRole('textbox', { name: 'Prompt' }));
    expect(openSessionTitle()).toBe('Third');
    ctrl('9', { code: 'Digit9' });
    expect(openSessionTitle()).toBe('Third');
  });

  it('r focuses the composer of a Waiting Session', () => {
    renderApp(three());
    press('j');
    press('r');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Prompt' }));
  });

  it('u marks the open Session unread', async () => {
    const main = renderApp(three());
    press('j');
    press('u');
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'sessions.setUnread', params: { id: 1, unread: true } }));
  });

  it('Ctrl+Shift+N starts from an issue', () => {
    renderApp(three());
    ctrl('N', { shiftKey: true });
    expect(screen.getByRole('dialog', { name: 'Pick a Project' })).toBeTruthy();
  });

  it('Ctrl+Shift+M asks for a Merge request; Ctrl+Shift+E opens the editor, Ctrl+` a terminal in the dock', async () => {
    const main = renderApp(three());
    press('j');
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    ctrl('M', { shiftKey: true }, prompt);
    ctrl('E', { shiftKey: true }, prompt);
    // AZERTY: the key left of 1 types ².
    ctrl('²', { code: 'Backquote' }, prompt);
    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command !== 'sessions.setUnread').map((i) => i.command)).toEqual(
        expect.arrayContaining(['sessions.requestMergeRequest', 'sessions.openInEditor', 'terminals.open']),
      ),
    );
  });

  it('Ctrl+Shift+Enter retries a prompt that failed, and is only offered then', async () => {
    const main = new FakeMain({ projects: [billing], sessions: [session(1, { title: 'Broke', waitingReason: 'error', error: 'boom' })] });
    renderApp(main);
    act(() =>
      main.publish(
        'transcript',
        [
          { id: 1, kind: 'user', text: 'do it' },
          { id: 2, kind: 'error', message: 'boom' },
        ],
        { sessionId: 1 },
      ),
    );
    press('j');
    ctrlK();
    expect(actionNames()).toContain('Retry the last prompt');
    press('Escape', search());

    ctrl('Enter', { shiftKey: true }, screen.getByRole('textbox', { name: 'Prompt' }));
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'sessions.retry', params: { id: 1 } }));
  });

  it('lists the new actions in the palette with their keys', () => {
    renderApp(three());
    press('j');
    ctrlK();
    const keys = (name: string) => within(within(palette()).getByRole('option', { name })).queryByText((_, el) => el?.tagName === 'KBD')?.textContent;
    expect(keys('Go to previous Waiting Session')).toBe('K');
    expect(keys('Reply to this Session')).toBe('R');
    expect(keys('Mark this Session unread')).toBe('U');
    expect(keys('New Session from an issue…')).toBe('Ctrl Shift N');
    expect(keys('Create Merge request for this Session')).toBe('Ctrl Shift M');
    expect(keys('Open in editor')).toBe('Ctrl Shift E');
    expect(keys('Toggle terminal')).toBe('Ctrl `');
    expect(keys('Open in terminal')).toBeUndefined();
    expect(actionNames()).not.toContain('Retry the last prompt');
  });
});

describe('the keyboard shortcuts list', () => {
  const ctrlQuestion = (target: Element = document.body) => fireEvent.keyDown(target, { key: '?', ctrlKey: true, shiftKey: true });
  const help = () => screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
  const rows = () => within(help()).queryAllByRole('row').filter((r) => within(r).queryAllByRole('cell').length).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));

  it('opens on Ctrl+?, listing every shortcut whether it applies now or not', () => {
    renderApp();
    ctrlQuestion();
    const all = rows();
    expect(all).toContainEqual(['Open the command palette', 'Ctrl K']);
    expect(all).toContainEqual(['Show keyboard shortcuts', 'Ctrl ?']);
    expect(all).toContainEqual(['Go to next Waiting Session', 'J']);
    expect(all).toContainEqual(['Retry the last prompt', 'Ctrl Shift Enter']);
    expect(all).toContainEqual(['Open the nth Waiting Session in the Inbox', 'Ctrl 1…9']);
    expect(document.activeElement).toBe(within(help()).getByRole('searchbox', { name: 'Search shortcuts' }));
    press('Escape', document.activeElement!);
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it("lists the composer's keys, which no longer show under it", () => {
    renderApp();
    ctrlQuestion();
    const searchBox = within(help()).getByRole('searchbox', { name: 'Search shortcuts' });
    fireEvent.change(searchBox, { target: { value: 'enter' } });
    expect(rows()).toEqual([
      ['Retry the last prompt', 'Ctrl Shift Enter'],
      ['Send the message', 'Enter'],
      ['Add a line to the message', 'Shift Enter'],
    ]);
    expect(within(help()).getByText('In the composer')).toBeTruthy();
    expect(within(help()).queryByText('Outside text fields')).toBeNull();
  });

  it('opens from the composer too, and puts focus back there', () => {
    renderApp(new FakeMain({ sessions: [session(1, { title: 'One' })] }));
    press('j');
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    prompt.focus();
    ctrlQuestion(prompt);
    expect(help()).toBeTruthy();
    press('Escape', document.activeElement!);
    expect(document.activeElement).toBe(prompt);
  });

  it('searches by action or by key', () => {
    renderApp();
    ctrlQuestion();
    const searchBox = within(help()).getByRole('searchbox', { name: 'Search shortcuts' });
    fireEvent.change(searchBox, { target: { value: 'waiting' } });
    // Ctrl ones first: they work even while typing.
    expect(rows().map((r) => r[0])).toEqual(['Open the nth Waiting Session in the Inbox', 'Go to next Waiting Session', 'Go to previous Waiting Session']);
    expect(within(help()).getByText('Even while typing')).toBeTruthy();
    expect(within(help()).getByText('Outside text fields')).toBeTruthy();
    fireEvent.change(searchBox, { target: { value: 'ctrl shift' } });
    expect(rows().every((r) => r[1]!.startsWith('Ctrl Shift'))).toBe(true);
    expect(rows().length).toBeGreaterThan(2);
    fireEvent.change(searchBox, { target: { value: 'zzz' } });
    expect(within(help()).getByText('No matching shortcut.')).toBeTruthy();
  });

  it('closes on Ctrl+? again, and opens from the palette', () => {
    renderApp();
    ctrlQuestion();
    ctrlQuestion(within(help()).getByRole('searchbox'));
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();

    runAction('Show keyboard shortcuts');
    expect(help()).toBeTruthy();
  });
});
