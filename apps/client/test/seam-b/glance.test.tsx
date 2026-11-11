import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const native = { id: 'native', label: 'Native', state: 'connected' as const, bridge: { protocolVersion: 1, version: '0.1.0', os: 'linux', arch: 'x64', home: '/home/dev' } };
const session: Session = {
  id: 7,
  projectId: 1,
  title: 'Fix login',
  workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/billing-api/fix-login' },
  branch: 'loom/12-invoices-show-the-wrong-currency',
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};
const full: Session = {
  ...session,
  agentSessionId: 'ses_abc123',
  issue: { number: 31, url: 'https://github.com/acme/billing-api/issues/31' },
  mergeRequest: { number: 40, url: 'https://github.com/acme/billing-api/pull/40' },
  mergeRequestState: 'open',
  babysit: { ci: 'failed', stale: false },
  diffStat: { files: 4, added: 1210, removed: 3 },
  model: 'anthropic/claude-sonnet-5-5',
  effort: 'high',
  context: { used: 50_000, size: 200_000 },
  usage: { tokens: 125_000, reportedCost: 1.234, workingMs: 6 * 60_000 + 40_000 },
};

function renderApp(s: Session = full, handlers: ConstructorParameters<typeof FakeMain>[1] = {}) {
  const main = new FakeMain({ projects: [project], sessions: [s], environments: [native] }, handlers);
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  const inbox = within(screen.getByRole('complementary', { name: 'Inbox' }));
  if (s.status === 'archived') fireEvent.click(inbox.getByRole('button', { name: 'Archived' }));
  fireEvent.click(inbox.getByRole('button', { name: s.title }));
  return main;
}

const header = () => screen.getByRole('region', { name: 'Session header' });
const glance = () => screen.getByRole('group', { name: 'Session at a glance' });
const details = () => screen.getByRole('dialog', { name: 'Session details' });
const group = (name: string) => within(details()).getByRole('region', { name });
/** The value a fact in `g` shows, by its name. */
const fact = (g: HTMLElement, name: string) => {
  const term = within(g).getAllByRole('term').find((t) => t.textContent === name);
  if (!term) throw new Error(`no fact ${name}`);
  return term.nextElementSibling as HTMLElement;
};
const value = (g: HTMLElement, name: string) => fact(g, name).querySelector('.value')!.textContent;
/** Opens the header's ⋯ menu, giving its items' names and whether each is on. */
const openMenu = () => {
  fireEvent.click(within(header()).getByRole('button', { name: 'More actions' }));
  return screen.getByRole('menu', { name: 'Session actions' });
};
const menuItems = () => within(openMenu()).getAllByRole('menuitem').map((item) => `${item.textContent}${(item as HTMLButtonElement).disabled ? ' (off)' : ''}`);

describe('the Session header', () => {
  it('is one line: the title, the Project, the status, then the Side area, Dock and ⋯ buttons', () => {
    renderApp();
    const h = header();
    expect(within(h).getByRole('heading', { level: 1 }).textContent).toBe('Fix login');
    expect(h.querySelector('.proj-tag')!.textContent).toBe('billing-api');
    expect(within(h).getByRole('status', { name: 'Session status' }).textContent).toBe('Finished');
    expect(within(h).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Fix login', 'Hide the Side area', 'Show the Dock', 'More actions']);
    // The branch, the repository and the working copy are elsewhere.
    expect(h.textContent).not.toContain('loom/12-invoices');
    expect(h.textContent).not.toContain('acme/billing-api');
    expect(h.textContent).not.toContain('worktree');
  });

  it('keeps the worktree-missing warning in the line', () => {
    renderApp({ ...session, worktreeMissing: true });
    expect(within(header()).getByRole('status', { name: 'Worktree missing' })).toBeTruthy();
  });

  it('opens Session details from the title, and closes them again', () => {
    renderApp();
    const title = within(header()).getByRole('button', { name: 'Fix login' });
    expect(title.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(title);
    expect(details()).toBeTruthy();
    expect(title.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(title);
    expect(screen.queryByRole('dialog', { name: 'Session details' })).toBeNull();
  });
});

describe('the Glance strip', () => {
  it('shows the branch, the Merge request and its CI, the changes, the context used and the issue, in that order', () => {
    renderApp();
    expect(within(glance()).getAllByRole('button').map((b) => b.textContent)).toEqual(['loom/12-invoices-show-the-wrong-currency', '#40', 'CI failed', '4 files+1210−3', '25%', '#31']);
  });

  it('shows the whole branch in its tooltip, opening Session details, and offers to copy it on a right-click', () => {
    renderApp();
    const branch = within(glance()).getByRole('button', { name: 'loom/12-invoices-show-the-wrong-currency' });
    expect(branch.title).toBe('loom/12-invoices-show-the-wrong-currency · Session details');
    expect(branch.getAttribute('data-copy')).toBe('loom/12-invoices-show-the-wrong-currency');
    fireEvent.click(branch);
    expect(value(group('Where'), 'Branch')).toBe('loom/12-invoices-show-the-wrong-currency');
  });

  it('opens Changes from the diff stat', () => {
    renderApp({ ...full }, {});
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Side area' })).getByRole('button', { name: 'Close Changes' }));
    expect(screen.queryByRole('complementary', { name: 'Side area' })).toBeNull();
    fireEvent.click(within(glance()).getByRole('button', { name: 'Show changes: 4 files, 1210 added, 3 removed' }));
    expect(within(screen.getByRole('complementary', { name: 'Side area' })).getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true');
  });

  it('says Changes before there is a diff stat, and has no branch yet before the agent starts', () => {
    renderApp({ ...session, branch: undefined, mergeRequest: undefined });
    expect(within(glance()).getByRole('button', { name: 'Show changes' }).textContent).toBe('Changes');
    expect(within(glance()).getByRole('button', { name: 'No branch yet' })).toBeTruthy();
    expect(within(glance()).getByRole('button', { name: 'Context not reported yet' }).textContent).toBe('–');
  });

  it('puts the tokens, Reported cost and Working time in the context meter’s tooltip, opening Session details', () => {
    renderApp();
    const meter = within(glance()).getByRole('button', { name: 'Context 25% used' });
    expect(meter.title).toBe('Context 25%: 50k of 200k tokens\n125k tokens · $1.23 so far · 6m 40s working');
    fireEvent.click(meter);
    expect(value(group('Usage'), 'Context')).toBe('50k / 200k (25%)');
  });

  it('offers to link an issue while none is linked', () => {
    renderApp({ ...full, issue: undefined });
    expect(within(glance()).getByRole('button', { name: 'Link issue' })).toBeTruthy();
  });
});

describe('Session details', () => {
  it('shows where the Session works, copying the path and the branch, opening the editor and the terminal', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const main = renderApp();
    fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    expect(within(details()).getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Where', 'Agent', 'Usage']);
    const where = group('Where');
    expect(value(where, 'Project')).toBe('billing-apiacme/billing-api');
    expect(value(where, 'Environment')).toBe('Native (Linux)');
    expect(value(where, 'Working copy')).toBe('worktree');
    expect(value(where, 'Path')).toBe('/home/dev/loom/worktrees/billing-api/fix-login');
    // Long paths and branches wrap between their parts, not mid-word.
    expect(fact(where, 'Path').querySelectorAll('wbr').length).toBe(8);
    fireEvent.click(within(fact(where, 'Path')).getByRole('button', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith('/home/dev/loom/worktrees/billing-api/fix-login');
    expect(await within(fact(where, 'Path')).findByRole('button', { name: 'Copied' })).toBeTruthy();
    fireEvent.click(within(fact(where, 'Branch')).getByRole('button', { name: 'Copy branch name' }));
    expect(writeText).toHaveBeenCalledWith('loom/12-invoices-show-the-wrong-currency');

    fireEvent.click(within(where).getByRole('button', { name: 'Open in editor' }));
    fireEvent.click(within(where).getByRole('button', { name: 'Open in terminal' }));
    expect(main.invoked.filter((c) => c.command.startsWith('sessions.openIn'))).toEqual([
      { command: 'sessions.openInEditor', params: { id: 7 } },
      { command: 'sessions.openInTerminal', params: { id: 7 } },
    ]);
  });

  it('shows the agent, model and Effort, and its session id to copy', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    renderApp();
    fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    const agent = group('Agent');
    expect(value(agent, 'Agent')).toBe('OpenCode');
    expect(value(agent, 'Model')).toBe('anthropic/claude-sonnet-5-5');
    expect(value(agent, 'Effort')).toBe('high');
    expect(value(agent, 'Agent session')).toBe('ses_abc123');
    fireEvent.click(within(agent).getByRole('button', { name: 'Copy agent session id' }));
    expect(writeText).toHaveBeenCalledWith('ses_abc123');
  });

  it("shows the context used with a bar, the Session's tokens, Reported cost and Working time", () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    const usage = group('Usage');
    expect(value(usage, 'Context')).toBe('50k / 200k (25%)');
    expect(within(usage).getByRole('meter', { name: 'Context used' }).getAttribute('aria-valuenow')).toBe('25');
    expect(value(usage, 'Tokens')).toBe('125k');
    expect(value(usage, 'Reported cost')).toBe('$1.23');
    expect(value(usage, 'Working time')).toBe('6m 40s');
  });

  it('updates live: usage, context and branch, the Working time counting while Working', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(100_000);
    const main = renderApp();
    fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    act(() => main.publish('sessions', [{ ...full, status: 'working', usage: { ...full.usage!, workingSince: 100_000 - 20_000 } }]));
    expect(value(group('Usage'), 'Working time')).toBe('7m');
    act(() => vi.advanceTimersByTime(5000));
    expect(value(group('Usage'), 'Working time')).toBe('7m 5s');

    act(() => main.publish('sessions', [{ ...full, branch: 'loom/other', context: { used: 100_000, size: 200_000 }, usage: { tokens: 130_000, reportedCost: 1.5, workingMs: 8 * 60_000 } }]));
    expect(value(group('Where'), 'Branch')).toBe('loom/other');
    expect(value(group('Usage'), 'Context')).toBe('100k / 200k (50%)');
    expect(value(group('Usage'), 'Tokens')).toBe('130k');
    expect(value(group('Usage'), 'Reported cost')).toBe('$1.50');
    expect(value(group('Usage'), 'Working time')).toBe('8m');
    expect(within(glance()).getByRole('button', { name: 'Context 50% used' })).toBeTruthy();
  });

  it('offers no editor nor terminal for an archived Session, or one whose worktree is missing', () => {
    renderApp({ ...full, worktreeMissing: true });
    fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    expect(within(details()).queryByRole('button', { name: 'Open in editor' })).toBeNull();
    expect(within(details()).queryByRole('button', { name: 'Open in terminal' })).toBeNull();
    cleanup();

    renderApp({ ...full, status: 'archived', waitingReason: undefined });
    fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    expect(within(details()).queryByRole('button', { name: 'Open in editor' })).toBeNull();
    expect(within(details()).getByRole('button', { name: 'Copy path' })).toBeTruthy();
  });

  it('closes on Esc, the focus going back to what opened it', () => {
    renderApp();
    const branch = within(glance()).getByRole('button', { name: 'loom/12-invoices-show-the-wrong-currency' });
    branch.focus();
    fireEvent.click(branch);
    fireEvent.keyDown(details(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Session details' })).toBeNull();
    expect(document.activeElement).toBe(branch);
  });
});

describe('the ⋯ menu', () => {
  it("has Session details, the working copy's actions and the right-click menu's", () => {
    renderApp();
    expect(menuItems()).toEqual([
      'Session details…',
      'Open in editor',
      'Open in terminal',
      'Copy branch name',
      'New Session in this worktree',
      'Snooze…',
      'Rename…',
      'Mark unread',
      'Archive',
      'Delete…',
    ]);
  });

  it('opens Session details beside it', () => {
    renderApp();
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Session details…' }));
    expect(screen.queryByRole('menu', { name: 'Session actions' })).toBeNull();
    expect(details()).toBeTruthy();
  });

  it('opens the working copy in the editor and the terminal, and copies the branch', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const main = renderApp();
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Open in editor' }));
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Open in terminal' }));
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Copy branch name' }));
    expect(main.invoked.filter((c) => c.command.startsWith('sessions.openIn'))).toEqual([
      { command: 'sessions.openInEditor', params: { id: 7 } },
      { command: 'sessions.openInTerminal', params: { id: 7 } },
    ]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('loom/12-invoices-show-the-wrong-currency'));
  });

  it('snoozes the Session from its Snooze… submenu', async () => {
    const main = renderApp();
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Snooze…' }));
    const snooze = screen.getByRole('menu', { name: 'Snooze' });
    fireEvent.click(within(snooze).getAllByRole('menuitem')[0]!);
    await waitFor(() => expect(main.invoked.map((c) => c.command)).toContain('sessions.snooze'));
  });

  it("turns off what a Session whose worktree is missing can't do", () => {
    renderApp({ ...full, worktreeMissing: true, branch: undefined });
    const items = menuItems();
    expect(items.slice(0, 4)).toEqual(['Session details…', 'Open in editor (off)', 'Open in terminal (off)', 'Copy branch name (off)']);
    expect(items).toContain('Archive');
  });
});
