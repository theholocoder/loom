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

    expect(within(row('Just now')).getByText('Just now').className).toContain('title');
    expect(within(row('Just now')).getByRole('img', { name: 'Unread' })).toBeTruthy();
    expect(within(row('This morning')).queryByRole('img', { name: 'Unread' })).toBeNull();
    expect(row('Just now').querySelector('time')?.textContent).toBe('now');
    expect(row('This morning').querySelector('time')?.textContent).toMatch(/^0?9.05/);
    expect(row('Last night').querySelector('time')?.textContent).toBe('Yesterday');
    expect(row('Last week').querySelector('time')?.textContent).toMatch(/26/);
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
});
