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

function renderApp(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const inbox = () => screen.getByRole('complementary', { name: 'Inbox' });

const loom: Project = {
  id: 1,
  name: 'loom',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/loom' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'theholocoder/loom' },
};
const billing: Project = {
  id: 2,
  name: 'billing-api',
  branchPrefix: 'billing',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'gitlab', repository: 'acme/billing-api' },
};

// 2026-11-02 10:42 local time.
const NOW = new Date(2026, 10, 2, 10, 42).getTime();

let nextId = 1;
function session(change: Partial<Session>): Session {
  const id = nextId++;
  return {
    id,
    projectId: loom.id,
    title: `Session ${id}`,
    workingCopy: { kind: 'checkout', path: '/home/dev/loom' },
    agent: 'OpenCode',
    status: 'waiting',
    waitingReason: 'finished',
    unread: false,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...change,
  };
}

describe('the Inbox', () => {
  it('lists Waiting Sessions grouped by Project, with each Project’s avatar, name, Forge and count', () => {
    const sessions = [
      session({ title: 'Add Merge request button', projectId: loom.id }),
      session({ title: 'Rate-limit webhook retries', projectId: billing.id }),
      session({ title: 'Fix flaky cleanup test', projectId: loom.id }),
      session({ title: 'Persist Inbox sections', projectId: billing.id, status: 'working', waitingReason: undefined }),
      session({ title: 'Old work', projectId: loom.id, status: 'archived', waitingReason: undefined }),
    ];
    renderApp(new FakeMain({ projects: [billing, loom], sessions }));

    const groups = within(inbox()).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['billing-api', 'loom']);
    const [billingGroup, loomGroup] = groups as [HTMLElement, HTMLElement];
    expect(within(billingGroup).getByText('BI')).toBeTruthy();
    expect(within(billingGroup).getByRole('img', { name: 'GitLab' })).toBeTruthy();
    expect(within(billingGroup).getByLabelText('Waiting').textContent).toBe('1');
    expect(within(billingGroup).getAllByRole('listitem').map((row) => row.getAttribute('aria-label'))).toEqual(['Rate-limit webhook retries']);
    expect(within(loomGroup).getByText('LO')).toBeTruthy();
    expect(within(loomGroup).getByRole('img', { name: 'GitHub' })).toBeTruthy();
    expect(within(loomGroup).getByLabelText('Waiting').textContent).toBe('2');
    expect(within(loomGroup).getAllByRole('listitem').map((row) => row.getAttribute('aria-label'))).toEqual(['Add Merge request button', 'Fix flaky cleanup test']);
  });

  it('shows why each Session is Waiting', () => {
    const reasons = ['finished', 'stopped', 'question', 'approval', 'stuck', 'error', 'interrupted', 'feedback'] as const;
    renderApp(new FakeMain({ projects: [loom], sessions: reasons.map((reason) => session({ title: reason, waitingReason: reason })) }));

    const why = reasons.map((reason) => within(within(inbox()).getByRole('listitem', { name: reason })).getByRole('img', { name: /./ }).getAttribute('aria-label'));

    expect(why).toEqual(['Finished', 'Stopped', 'Asked a question', 'Needs approval', 'Stuck', 'Error', 'Interrupted', 'Feedback']);
  });

  it('shows the title, an unread marker, when it went Waiting and its branch', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    renderApp(
      new FakeMain({
        projects: [loom],
        sessions: [
          session({ title: 'Just now', unread: true, updatedAt: NOW - 10_000, branch: 'loom/31-mr-button' }),
          session({ title: 'This morning', updatedAt: new Date(2026, 10, 2, 9, 5).getTime() }),
          session({ title: 'Last night', updatedAt: new Date(2026, 10, 1, 23, 30).getTime() }),
          session({ title: 'Last week', updatedAt: new Date(2026, 9, 26, 15, 0).getTime() }),
        ],
      }),
    );
    const row = (title: string) => within(inbox()).getByRole('listitem', { name: title });

    expect(within(row('Just now')).getByText('Just now')).toBeTruthy();
    expect(within(row('Just now')).getByRole('img', { name: 'Unread' })).toBeTruthy();
    expect(within(row('This morning')).queryByRole('img', { name: 'Unread' })).toBeNull();
    expect(within(row('Just now')).getByText('now')).toBeTruthy();
    expect(within(row('This morning')).getByText(/^0?9.05/)).toBeTruthy();
    expect(within(row('Last night')).getByText('Yesterday')).toBeTruthy();
    expect(within(row('Last week')).getByText(/26/)).toBeTruthy();
    expect(within(row('Just now')).getByTitle('Branch').textContent).toBe('loom/31-mr-button');
    expect(within(row('This morning')).queryByTitle('Branch')).toBeNull();
  });

  it('keeps Working and Archived Sessions in collapsed sections', () => {
    renderApp(
      new FakeMain({
        projects: [loom],
        sessions: [session({ title: 'Busy', status: 'working', waitingReason: undefined }), session({ title: 'Done long ago', status: 'archived', waitingReason: undefined })],
      }),
    );

    expect(within(inbox()).getByText('Nothing needs you right now.')).toBeTruthy();
    for (const [section, title] of [
      ['Working', 'Busy'],
      ['Archived', 'Done long ago'],
    ] as const) {
      const head = within(inbox()).getByRole('button', { name: section });
      expect(head.getAttribute('aria-expanded')).toBe('false');
      expect(head.textContent).toContain('1');
      expect(within(inbox()).queryByRole('button', { name: title })).toBeNull();
      fireEvent.click(head);
      expect(within(inbox()).getByRole('button', { name: title })).toBeTruthy();
    }
  });

  it('marks a Session read when it is opened, and lets Mark unread stick while it is shown', async () => {
    const unread = session({ title: 'News', unread: true });
    const main = renderApp(new FakeMain({ projects: [loom], sessions: [unread] }));
    expect(within(within(inbox()).getByRole('listitem', { name: 'News' })).queryByRole('button', { name: 'Mark unread' })).toBeNull();

    fireEvent.click(within(inbox()).getByRole('button', { name: 'News' }));
    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.setUnread')).toEqual([{ command: 'sessions.setUnread', params: { id: unread.id, unread: false } }]));
    act(() => main.publish('sessions', [{ ...unread, unread: false }]));

    fireEvent.click(within(within(inbox()).getByRole('listitem', { name: 'News' })).getByRole('button', { name: 'Mark unread' }));
    act(() => main.publish('sessions', [{ ...unread, unread: true }]));

    expect(main.invoked.filter((i) => i.command === 'sessions.setUnread').map((i) => i.params)).toEqual([
      { id: unread.id, unread: false },
      { id: unread.id, unread: true },
    ]);
    expect(within(within(inbox()).getByRole('listitem', { name: 'News' })).getByRole('img', { name: 'Unread' })).toBeTruthy();
  });

  it('archives a Session from its row', () => {
    const waiting = session({ title: 'Done with this' });
    const main = renderApp(new FakeMain({ projects: [loom], sessions: [waiting] }));

    fireEvent.click(within(within(inbox()).getByRole('listitem', { name: 'Done with this' })).getByRole('button', { name: 'Archive' }));

    expect(main.invoked.filter((i) => i.command === 'sessions.archive')).toEqual([{ command: 'sessions.archive', params: { id: waiting.id } }]);
  });

  it('warns before archiving a row with unsaved work: Cancel keeps it, Discard archives it', async () => {
    const dirty = session({ title: 'Half done', workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/loom/half' } });
    const main = renderApp(
      new FakeMain({ projects: [loom], sessions: [dirty] }, { 'sessions.archive': ({ discard }) => (discard ? { archived: true } : { archived: false, unsavedWork: { uncommitted: true, unpushedCommits: 2, detached: false } }) }),
    );
    const archive = () => fireEvent.click(within(within(inbox()).getByRole('listitem', { name: 'Half done' })).getByRole('button', { name: 'Archive' }));

    archive();
    const warning = await screen.findByRole('alertdialog', { name: 'Archive with unsaved work?' });
    expect(warning.textContent).toContain('uncommitted changes and 2 unpushed commits');
    fireEvent.click(within(warning).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    archive();
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(main.invoked.filter((i) => i.command === 'sessions.archive').map((i) => i.params)).toEqual([{ id: dirty.id }, { id: dirty.id }, { id: dirty.id, discard: true }]);
  });

  it('flags a Session whose worktree is missing, offering only Archive', () => {
    const missing = session({ title: 'Gone', workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/loom/gone' }, worktreeMissing: true });
    renderApp(new FakeMain({ projects: [loom], sessions: [missing] }));

    const row = within(inbox()).getByRole('listitem', { name: 'Gone' });

    expect(within(row).getByRole('status', { name: 'Worktree missing' })).toBeTruthy();
    expect(within(row.querySelector('.hover-actions') as HTMLElement).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Archive']);
  });

  it('replies from a row: the Session opens with its composer focused, and leaves the Inbox once sent', async () => {
    const waiting = session({ title: 'Asked me something', waitingReason: 'question' });
    const main = renderApp(
      new FakeMain({ projects: [loom], sessions: [waiting] }, {
        'sessions.send': () => main.publish('sessions', [{ ...waiting, status: 'working', waitingReason: undefined, unread: false }]),
      }),
    );

    fireEvent.click(within(within(inbox()).getByRole('listitem', { name: 'Asked me something' })).getByRole('button', { name: 'Reply' }));

    const prompt = within(screen.getByRole('main', { name: 'Session' })).getByRole('textbox', { name: 'Prompt' });
    expect(document.activeElement).toBe(prompt);
    fireEvent.change(prompt, { target: { value: 'Yes, go ahead' } });
    fireEvent.keyDown(prompt, { key: 'Enter' });

    await waitFor(() => expect(within(inbox()).queryByRole('listitem', { name: 'Asked me something' })).toBeNull());
    expect(within(inbox()).queryByRole('group')).toBeNull();
    expect(within(inbox()).getByRole('button', { name: 'Working' }).textContent).toContain('1');
  });

  it('shows the linked issue and Merge request before the branch, numbered the way each Forge does', () => {
    renderApp(
      new FakeMain({
        projects: [loom, billing],
        sessions: [
          session({
            title: 'On GitHub',
            projectId: loom.id,
            branch: 'loom/28-flaky-cleanup',
            issue: { number: 28, url: 'https://github.com/theholocoder/loom/issues/28' },
            mergeRequest: { number: 40, url: 'https://github.com/theholocoder/loom/pull/40' },
          }),
          session({
            title: 'On GitLab',
            projectId: billing.id,
            branch: 'billing/112-retry-limit',
            issue: { number: 112, url: 'https://gitlab.com/acme/billing-api/-/issues/112' },
            mergeRequest: { number: 87, url: 'https://gitlab.com/acme/billing-api/-/merge_requests/87' },
          }),
          session({ title: 'Unlinked', projectId: loom.id, branch: 'loom/spike' }),
        ],
      }),
    );
    const refs = (title: string) =>
      ['Issue', 'Merge request', 'Branch'].map((what) => within(within(inbox()).getByRole('listitem', { name: title })).queryByTitle(what)?.textContent ?? null);

    expect(refs('On GitHub')).toEqual(['#28', '#40', 'loom/28-flaky-cleanup']);
    expect(refs('On GitLab')).toEqual(['#112', '!87', 'billing/112-retry-limit']);
    expect(refs('Unlinked')).toEqual([null, null, 'loom/spike']);
  });

  it("opens a row's Merge request in the browser", () => {
    const linked = session({ title: 'Linked', mergeRequest: { number: 40, url: 'https://github.com/theholocoder/loom/pull/40' } });
    const main = renderApp(new FakeMain({ projects: [loom], sessions: [linked] }));
    const row = within(within(inbox()).getByRole('listitem', { name: 'Linked' }));
    expect(row.queryByRole('button', { name: 'Create Merge request' })).toBeNull();

    fireEvent.click(row.getByRole('button', { name: 'Open Merge request #40' }));

    expect(main.invoked.filter((i) => i.command === 'links.open')).toEqual([{ command: 'links.open', params: { url: 'https://github.com/theholocoder/loom/pull/40' } }]);
  });

  it('asks the agent to create a Merge request when the Forge is on and none is linked', () => {
    const unlinked = session({ title: 'Unlinked' });
    const offline = { ...billing, forge: { state: 'signed-out', checking: false, kind: 'gitlab', host: 'gitlab.com' } } satisfies Project;
    const main = renderApp(new FakeMain({ projects: [loom, offline], sessions: [unlinked, session({ title: 'Forge off', projectId: offline.id })] }));
    const row = (title: string) => within(within(inbox()).getByRole('listitem', { name: title }));
    expect(row('Forge off').queryByRole('button', { name: /Merge request/ })).toBeNull();

    fireEvent.click(row('Unlinked').getByRole('button', { name: 'Create Merge request' }));

    expect(main.invoked.filter((i) => i.command === 'sessions.requestMergeRequest')).toEqual([{ command: 'sessions.requestMergeRequest', params: { id: unlinked.id } }]);
  });

  it('says why a row action failed, until the Session changes', async () => {
    const waiting = session({ title: 'Stubborn' });
    const main = renderApp(
      new FakeMain({ projects: [loom], sessions: [waiting] }, {
        'sessions.requestMergeRequest': () => {
          throw new Error("This Session's agent has stopped, and Loom can't resume it yet.");
        },
      }),
    );
    const row = within(within(inbox()).getByRole('listitem', { name: 'Stubborn' }));

    fireEvent.click(row.getByRole('button', { name: 'Create Merge request' }));

    expect((await row.findByRole('alert')).textContent).toBe("This Session's agent has stopped, and Loom can't resume it yet.");
    act(() => main.publish('sessions', [{ ...waiting, waitingReason: 'error', updatedAt: waiting.updatedAt + 1_000 }]));
    expect(within(within(inbox()).getByRole('listitem', { name: 'Stubborn' })).queryByRole('alert')).toBeNull();
  });
});

