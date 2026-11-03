import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Issue, Project, Session } from '../../src/shared/api';
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
    expect(main.invoked.find((i) => i.command === 'sessions.create')?.params).toEqual({ projectId: 1, workingCopy: 'worktree', issue: loginBug, prompt: '' });
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
    [{ state: 'no-remote' }, 'needs an origin remote'],
    [{ state: 'error', error: 'boom' }, 'boom'],
  ] as const)('is off with a hint when the Forge is %o', (forge, hint) => {
    renderApp(new FakeMain({ projects: [{ ...project, forge: { ...forge, checking: false } }] }));
    const button = within(startNewSession()).getByRole('button', { name: 'Issue' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain(hint);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toContain(hint);
  });

  it("isn't shown before the Forge is checked", () => {
    renderApp(new FakeMain({ projects: [{ ...project, forge: { state: 'unknown', checking: true } }] }));
    expect(within(startNewSession()).queryByRole('button', { name: 'Issue' })).toBeNull();
  });
});

describe("a Session's linked issue", () => {
  it('shows in its header, opening the issue', () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [fromIssue] }));
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: fromIssue.title }));

    const link = within(screen.getByRole('region', { name: 'Session header' })).getByTitle('Issue');
    expect(link.textContent).toBe('#31');
    fireEvent.click(link);
    expect(main.invoked).toContainEqual({ command: 'links.open', params: { url: loginBug.url } });
  });
});
