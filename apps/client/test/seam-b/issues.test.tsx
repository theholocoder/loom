import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Issue, IssueDetails, Project, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

function renderApp(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const loginBug: Issue = { number: 31, title: 'Fix the login bug', body: 'SSO 500s.', url: 'https://github.com/acme/billing-api/issues/31' };
const darkMode: Issue = { number: 7, title: 'Dark mode', body: '', url: 'https://github.com/acme/billing-api/issues/7' };

const fromIssue: Session = {
  id: 9,
  projectId: 1,
  title: '#31 Fix the login bug',
  workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/billing-api/31-fix-the-login-bug' },
  agent: 'OpenCode',
  branch: 'loom/31-fix-the-login-bug',
  issue: { number: 31, url: loginBug.url },
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};

function startNewSession() {
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
  // With Projects, the Project picker comes first: take the highlighted one.
  const filter = screen.queryByRole('combobox', { name: 'Filter Projects' });
  if (filter) fireEvent.keyDown(filter, { key: 'Enter' });
  return screen.getByRole('main', { name: 'New Session' });
}

describe('starting a Session from an issue', () => {
  it('searches open issues, names the branch after the one picked, and starts with no prompt of its own', async () => {
    const main = renderApp(
      new FakeMain({ projects: [project] }, {
        'projects.issues': ({ search }) => [loginBug, darkMode].filter((i) => !search || i.title.toLowerCase().includes(search.toLowerCase())),
        'sessions.create': () => {
          main.publish('sessions', [fromIssue]);
          return fromIssue;
        },
      }),
    );
    const pane = startNewSession();

    fireEvent.click(within(pane).getByRole('button', { name: 'Issue' }));
    await within(pane).findByRole('option', { name: '#7 Dark mode' });
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Search issues' }), { target: { value: 'login' } });
    await waitFor(() => expect(within(pane).queryByRole('option', { name: '#7 Dark mode' })).toBeNull());
    fireEvent.click(within(pane).getByRole('option', { name: '#31 Fix the login bug' }));

    expect(within(pane).getByTitle(loginBug.url).textContent).toContain('#31 Fix the login bug');
    expect((within(pane).getByRole('textbox', { name: 'Branch' }) as HTMLInputElement).value).toBe('loom/31-fix-the-login-bug');
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('main', { name: 'Session' })).toBeTruthy());
    expect(main.invoked.find((i) => i.command === 'sessions.create')?.params).toEqual({ projectId: 1, workingCopy: 'worktree', issue: loginBug, approvalMode: 'supervised', prompt: '' });
    expect(main.invoked.find((i) => i.command === 'projects.issues')?.params).toEqual({ id: 1 });
  });

  it('can be unlinked before starting, going back to the branch from the prompt', async () => {
    renderApp(new FakeMain({ projects: [project] }, { 'projects.issues': () => [loginBug] }));
    const pane = startNewSession();
    fireEvent.click(within(pane).getByRole('button', { name: 'Issue' }));
    fireEvent.click(await within(pane).findByRole('option', { name: '#31 Fix the login bug' }));

    fireEvent.click(within(pane).getByRole('button', { name: 'Unlink issue' }));

    expect((within(pane).getByRole('textbox', { name: 'Branch' }) as HTMLInputElement).value).toBe('');
    expect((within(pane).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    [{ state: 'cli-missing', kind: 'gitlab', host: 'git.acme.dev' }, 'Install glab and sign in to git.acme.dev'],
    [{ state: 'cli-missing', kind: 'github', host: 'github.com' }, 'Install gh and sign in to github.com'],
    [{ state: 'signed-out', kind: 'gitlab', host: 'git.acme.dev' }, 'Run `glab auth login --hostname git.acme.dev`'],
    [{ state: 'signed-out', kind: 'github', host: 'github.com' }, 'Run `gh auth login --hostname github.com`'],
    [{ state: 'unsupported', host: 'git.acme.dev' }, 'needs an origin on GitHub or GitLab; git.acme.dev'],
    [{ state: 'unsupported', host: 'gitlab-ssh.axiocode.net', error: 'none of the git remotes point to a known GitLab host' }, 'glab said: none of the git remotes point to a known GitLab host'],
    [{ state: 'no-remote' }, 'needs an origin remote'],
    [{ state: 'error', error: 'boom' }, 'boom'],
  ] as const)('is off with a hint when the Forge is %o', (forge, hint) => {
    renderApp(new FakeMain({ projects: [{ ...project, forge: { ...forge, checking: false } }] }));
    const button = within(startNewSession()).getByRole('button', { name: 'Issue' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain(hint);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toContain(hint);
  });

  it('is on for a GitLab glab resolved from the checkout, whose web host differs from the SSH one', () => {
    const forge = { state: 'available', checking: false, kind: 'gitlab', host: 'gitlab.axiocode.net', repository: 'axio/team/app', remote: 'git@gitlab-ssh.axiocode.net:axio/team/app.git' } as const;
    renderApp(new FakeMain({ projects: [{ ...project, forge }] }));
    expect((within(startNewSession()).getByRole('button', { name: 'Issue' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("isn't shown before the Forge is checked", () => {
    renderApp(new FakeMain({ projects: [{ ...project, forge: { state: 'unknown', checking: true } }] }));
    expect(within(startNewSession()).queryByRole('button', { name: 'Issue' })).toBeNull();
  });
});

describe("a Session's linked issue", () => {
  const glance = () => screen.getByRole('group', { name: 'Session at a glance' });
  const openSession = (title: string) => fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: title }));
  const plain: Session = { ...fromIssue, title: 'Fix SSO', issue: undefined };

  it('is linked from the Link issue chip, searching the open issues', async () => {
    const main = renderApp(
      new FakeMain({ projects: [project], sessions: [plain] }, {
        'projects.issues': () => [loginBug, darkMode],
        'sessions.linkIssue': ({ issue }) => main.publish('sessions', [{ ...plain, issue }]),
      }),
    );
    openSession('Fix SSO');

    fireEvent.click(within(glance()).getByRole('button', { name: 'Link issue' }));
    const picker = screen.getByRole('dialog', { name: 'Pick an issue' });
    fireEvent.click(await within(picker).findByRole('option', { name: '#7 Dark mode' }));

    expect(screen.queryByRole('dialog', { name: 'Pick an issue' })).toBeNull();
    expect(main.invoked).toContainEqual({ command: 'sessions.linkIssue', params: { id: 9, issue: { number: 7, url: darkMode.url } } });
    await waitFor(() => expect(within(glance()).getByRole('button', { name: '#7' })).toBeTruthy());
  });

  it('says why linking one failed', async () => {
    renderApp(
      new FakeMain({ projects: [project], sessions: [plain] }, {
        'projects.issues': () => [loginBug],
        'sessions.linkIssue': () => {
          throw new Error("This Session's Project was removed, so it can't be linked to an issue.");
        },
      }),
    );
    openSession('Fix SSO');
    fireEvent.click(within(glance()).getByRole('button', { name: 'Link issue' }));
    fireEvent.click(await within(screen.getByRole('dialog', { name: 'Pick an issue' })).findByRole('option', { name: '#31 Fix the login bug' }));

    expect((await screen.findByRole('alert')).textContent).toContain("can't be linked to an issue");
  });

  it('offers no Link issue with the Forge off, nor on an archived Session', () => {
    renderApp(new FakeMain({ projects: [{ ...project, forge: { state: 'no-remote', checking: false } }], sessions: [plain] }));
    openSession('Fix SSO');
    expect(within(glance()).queryByRole('button', { name: 'Link issue' })).toBeNull();
    cleanup();

    renderApp(new FakeMain({ projects: [project], sessions: [{ ...plain, status: 'archived', waitingReason: undefined }] }));
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: 'Archived' }));
    openSession('Fix SSO');
    expect(within(glance()).queryByRole('button', { name: 'Link issue' })).toBeNull();
  });
});

describe('the Issue Panel', () => {
  const glance = () => screen.getByRole('group', { name: 'Session at a glance' });
  const openSession = (title: string) => fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: title }));
  const details: IssueDetails = {
    number: 31,
    url: loginBug.url,
    title: 'Fix the login bug',
    state: 'open',
    labels: ['bug', 'sso'],
    author: 'aduval',
    at: Date.now() - 3 * 60 * 60_000,
    comments: 2,
    body: 'Signing in with **SSO** returns a 500.',
  };
  /** The Issue Panel, shown from the `#31` chip in the Glance strip if it isn't shown. */
  const panel = () => {
    if (!screen.queryByRole('tabpanel', { name: 'Issue' })) fireEvent.click(within(glance()).getByRole('button', { name: '#31' }));
    return screen.getByRole('tabpanel', { name: 'Issue' });
  };

  it("opens from the issue's chip in the Glance strip, showing its state, reference, labels, title, author, age, comments and body", async () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [fromIssue] }, { 'sessions.issue': () => details }));
    openSession(fromIssue.title);

    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });
    expect(main.invoked).toContainEqual({ command: 'sessions.issue', params: { id: 9 } });
    expect(within(shown).getByText('Open')).toBeTruthy();
    expect(within(shown).getByText('acme/billing-api#31')).toBeTruthy();
    expect(within(shown).getByRole('list', { name: 'Labels' }).textContent).toBe('bugsso');
    expect(within(shown).getByText(/Opened by aduval/).textContent).toBe('Opened by aduval · 3 h ago');
    expect(within(shown).getByText('2 comments')).toBeTruthy();
    expect(within(shown).getByText('SSO').tagName).toBe('STRONG');
    // Not opened in the browser: the Panel has the button for that.
    expect(main.invoked.some((i) => i.command === 'links.open')).toBe(false);
  });

  it('opens it on the Forge, and unlinks it, closing the Panel', async () => {
    const main = renderApp(
      new FakeMain({ projects: [project], sessions: [fromIssue] }, {
        'sessions.issue': () => details,
        'sessions.unlinkIssue': () => main.publish('sessions', [{ ...fromIssue, issue: undefined }]),
      }),
    );
    openSession(fromIssue.title);
    const shown = panel();

    fireEvent.click(within(shown).getByRole('button', { name: 'Open on GitHub' }));
    expect(main.invoked).toContainEqual({ command: 'links.open', params: { url: loginBug.url } });

    fireEvent.click(within(shown).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(screen.queryByRole('tabpanel', { name: 'Issue' })).toBeNull());
    expect(main.invoked).toContainEqual({ command: 'sessions.unlinkIssue', params: { id: 9 } });
    expect(within(glance()).getByRole('button', { name: 'Link issue' })).toBeTruthy();
  });

  it('says it is closed, and on GitLab, opens it there', async () => {
    const gitlab: Project = { ...project, forge: { state: 'available', checking: false, kind: 'gitlab', repository: 'acme/billing-api' } };
    renderApp(new FakeMain({ projects: [gitlab], sessions: [fromIssue] }, { 'sessions.issue': () => ({ ...details, state: 'closed', labels: [], comments: 1, body: '' }) }));
    openSession(fromIssue.title);

    const shown = panel();
    await within(shown).findByText('Closed');
    expect(within(shown).queryByRole('list', { name: 'Labels' })).toBeNull();
    expect(within(shown).getByText('1 comment')).toBeTruthy();
    expect(within(shown).getByText('No description.')).toBeTruthy();
    expect(within(shown).getByRole('button', { name: 'Open on GitLab' })).toBeTruthy();
  });

  it("says why it couldn't be read, and reads it again on asking", async () => {
    let fail = true;
    renderApp(
      new FakeMain({ projects: [project], sessions: [fromIssue] }, {
        'sessions.issue': () => {
          if (fail) throw new Error('gh: Not Found (HTTP 404)');
          return details;
        },
      }),
    );
    openSession(fromIssue.title);

    const shown = panel();
    expect((await within(shown).findByRole('alert')).textContent).toContain("Couldn't read it from GitHub: gh: Not Found (HTTP 404)");
    fail = false;
    fireEvent.click(within(shown).getByRole('button', { name: 'Try again' }));
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });
    expect(within(shown).queryByRole('alert')).toBeNull();
  });

  it('is offered by the + menu only while the Session has an issue', () => {
    renderApp(new FakeMain({ projects: [project], sessions: [fromIssue] }, { 'sessions.issue': () => details }));
    openSession(fromIssue.title);
    fireEvent.click(screen.getByRole('button', { name: 'Add a Panel to the Side area' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Issue' }));
    expect(screen.getByRole('tabpanel', { name: 'Issue' })).toBeTruthy();
    cleanup();

    renderApp(new FakeMain({ projects: [project], sessions: [{ ...fromIssue, issue: undefined }] }));
    openSession(fromIssue.title);
    fireEvent.click(screen.getByRole('button', { name: 'Add a Panel to the Side area' }));
    expect(screen.queryByRole('menuitem', { name: 'Issue' })).toBeNull();
  });
});
