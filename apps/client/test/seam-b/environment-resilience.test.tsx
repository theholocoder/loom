import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { EnvironmentStatus, Project, Session, TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};

const working: Session = {
  id: 7,
  projectId: 1,
  title: 'Say hello',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'working',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};
const failed: Session = { ...working, status: 'waiting', waitingReason: 'error', error: 'Native could not start: spawn ENOENT' };

const environment = (state: EnvironmentStatus['state']): EnvironmentStatus => ({ id: 'native', label: 'Native', state });

function openSession(main: FakeMain, session: Session, transcript: TranscriptItem[] = []) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  if (session.status === 'working') fireEvent.click(screen.getByRole('button', { name: 'Working' }));
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  act(() => main.publish('transcript', transcript, { sessionId: session.id }));
  return within(screen.getByRole('log', { name: 'Conversation' }));
}

describe('a Working Session whose Environment is starting', () => {
  it('shows "Starting Native…" until the Environment is connected', () => {
    const main = new FakeMain({ projects: [project], sessions: [working], environments: [environment('starting')] });
    const chat = openSession(main, working, [{ kind: 'user', id: 1, text: 'Say hello' }]);

    expect(chat.getByText('Starting Native…')).toBeTruthy();

    act(() => main.publish('environments', [environment('connected')]));
    expect(chat.queryByText('Starting Native…')).toBeNull();
  });

  it('shows "Starting Native…" while the Environment waits to restart', () => {
    const main = new FakeMain({ projects: [project], sessions: [working], environments: [environment('disconnected')] });
    expect(openSession(main, working).getByText('Starting Native…')).toBeTruthy();
  });
});

describe('a Session Waiting on an error', () => {
  it('offers Retry when its last prompt went unanswered', async () => {
    const main = new FakeMain({ projects: [project], sessions: [failed], environments: [environment('failed')] });
    const chat = openSession(main, failed, [
      { kind: 'user', id: 1, text: 'Say hello' },
      { kind: 'error', id: 2, message: failed.error! },
    ]);

    fireEvent.click(chat.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.retry')).toEqual([{ command: 'sessions.retry', params: { id: 7 } }]));
  });

  it('shows why Retry failed', async () => {
    const main = new FakeMain(
      { projects: [project], sessions: [failed], environments: [environment('failed')] },
      {
        'sessions.retry': () => {
          throw new Error('Native is not connected');
        },
      },
    );
    const chat = openSession(main, failed, [
      { kind: 'user', id: 1, text: 'Say hello' },
      { kind: 'error', id: 2, message: failed.error! },
    ]);

    fireEvent.click(chat.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(chat.getAllByRole('alert').some((a) => a.textContent === 'Native is not connected')).toBe(true));
  });

  it('offers no Retry once the agent has answered: Continue carries on instead', () => {
    const restarted: Session = { ...failed, error: 'Environment restarted' };
    const main = new FakeMain({ projects: [project], sessions: [restarted], environments: [environment('connected')] });
    const chat = openSession(main, restarted, [
      { kind: 'user', id: 1, text: 'Say hello' },
      { kind: 'agent', id: 2, text: 'Hello', streaming: false },
      { kind: 'error', id: 3, message: 'Environment restarted' },
    ]);

    expect(chat.getByRole('alert').textContent).toContain('Environment restarted');
    expect(chat.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(chat.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});
