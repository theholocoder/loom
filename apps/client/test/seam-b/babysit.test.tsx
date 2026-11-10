import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'loom',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/loom' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/loom' },
};
const url = 'https://github.com/acme/loom/pull/12';

function session(fields: Partial<Session> = {}): Session {
  return { id: 1, projectId: 1, title: 'Fix login', workingCopy: { kind: 'worktree', path: '/w' }, agent: 'OpenCode', status: 'waiting', waitingReason: 'feedback', branch: 'loom/fix', mergeRequest: { number: 12, url }, mergeRequestState: 'open', unread: false, createdAt: 1, updatedAt: 1, ...fields };
}

function open(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));
  return screen.getByRole('log', { name: 'Conversation' });
}

const feedback: Extract<TranscriptItem, { kind: 'feedback' }> = {
  kind: 'feedback',
  id: 0,
  number: 12,
  url,
  state: 'new',
  ci: 'failed',
  items: [
    { kind: 'review', author: 'alice', verdict: 'changes-requested', excerpt: 'Needs work', url: `${url}#r1`, comments: [{ path: 'src/a.ts', line: 10, excerpt: 'Off by one', url: `${url}#r1a` }] },
    { kind: 'comment', author: 'bob', excerpt: 'Add a test', url: `${url}#c2` },
    { kind: 'ci-failed', checks: [{ name: 'unit', url: 'https://ci/1' }] },
    { kind: 'conflicts' },
  ],
};

const calls = (main: FakeMain, command: string) => main.invoked.filter((i) => i.command === command).map((i) => i.params);

describe('the feedback card', () => {
  it('lists the items and CI status, sends them to the agent and opens the Merge request', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    main.publish('transcript', [feedback], { sessionId: 1 });
    const card = within(open(main)).getByRole('group', { name: 'Feedback on Merge request #12' });

    expect(card.textContent).toContain('alice requested changes');
    expect(card.textContent).toContain('Needs work');
    expect(card.textContent).toContain('src/a.ts:10');
    expect(card.textContent).toContain('bob commented');
    expect(card.textContent).toContain('unit');
    expect(card.textContent).toContain('Conflicts with its target branch');
    expect(card.textContent).toContain('CI failed');

    fireEvent.click(within(card).getByRole('button', { name: 'Send to agent' }));
    await waitFor(() => expect(calls(main, 'sessions.sendFeedback')).toEqual([{ id: 1, itemId: 0 }]));
    fireEvent.click(within(card).getByRole('button', { name: 'Open on Forge' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url }]));
  });

  it('says it was sent once it has been, with nothing left to send', () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    main.publish('transcript', [{ ...feedback, state: 'sent' }], { sessionId: 1 });
    const card = within(open(main)).getByRole('group', { name: 'Feedback on Merge request #12' });

    expect(card.textContent).toContain('Sent to the agent');
    expect(within(card).queryByRole('button', { name: 'Send to agent' })).toBeNull();
  });

  it('has nothing to send once the Session is archived, but still opens on the Forge', () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    main.publish('transcript', [feedback], { sessionId: 1 });
    const card = within(open(main)).getByRole('group', { name: 'Feedback on Merge request #12' });
    expect(within(card).queryByRole('button', { name: 'Send to agent' })).not.toBeNull();

    act(() => main.publish('sessions', [session({ status: 'archived', waitingReason: undefined })]));
    const archived = within(screen.getByRole('log', { name: 'Conversation' })).getByRole('group', { name: 'Feedback on Merge request #12' });
    expect(within(archived).queryByRole('button', { name: 'Send to agent' })).toBeNull();
    expect(within(archived).getByRole('button', { name: 'Open on Forge' })).toBeTruthy();
  });
});

describe('info cards', () => {
  it('shows an approval and a green CI quietly', () => {
    const main = new FakeMain({ projects: [project], sessions: [session({ waitingReason: 'finished' })] });
    main.publish('transcript', [{ kind: 'feedback-info', id: 0, event: 'approved', author: 'alice', url }, { kind: 'feedback-info', id: 1, event: 'ci-passed', url }], { sessionId: 1 });
    const notes = within(open(main)).getAllByRole('note').map((n) => n.textContent);

    expect(notes).toEqual(expect.arrayContaining([expect.stringContaining('alice approved'), expect.stringContaining('CI passed')]));
  });
});

describe('Session info', () => {
  const row = () => {
    if (!screen.queryByRole('tabpanel', { name: 'Session info' })) fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    const git = within(screen.getByRole('tabpanel', { name: 'Session info' })).getByRole('region', { name: 'Git' });
    return within(git).getAllByRole('term').find((t) => t.textContent === 'Merge request')!.nextElementSibling as HTMLElement;
  };

  it('shows the CI status and when it was last polled on the Merge request row', () => {
    const at = new Date(2026, 10, 10, 14, 32).getTime();
    open(new FakeMain({ projects: [project], sessions: [session({ babysit: { ci: 'pending', lastPollAt: at, stale: false } })] }));

    expect(row().textContent).toContain('CI pending');
    expect(row().textContent).toContain(`Checked ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    expect(row().textContent).not.toContain('Stale');
  });

  it('shows a stale badge after a failed poll', () => {
    open(new FakeMain({ projects: [project], sessions: [session({ babysit: { ci: 'passed', lastPollAt: 1, stale: true } })] }));

    expect(row().textContent).toContain('Stale');
  });
});
