import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, UsageDashboard } from '../../src/shared/api';
import { emptyDashboard, FakeMain } from './fake-main';

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'loom',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/loom' },
  forge: { state: 'available', checking: false, kind: 'github', host: 'github.com', repository: 'theholocoder/loom' },
};

const session: Session = {
  id: 7,
  projectId: 1,
  title: 'Fix the login bug',
  workingCopy: { kind: 'checkout', path: '/home/dev/loom' },
  agent: 'OpenCode',
  status: 'archived',
  unread: false,
  createdAt: 1,
  updatedAt: 2,
};

function dashboard(days: UsageDashboard['days'] = 7): UsageDashboard {
  const empty = emptyDashboard(days);
  return {
    ...empty,
    perDay: empty.perDay.map((d, i) => (i === days - 1 ? { ...d, tokens: 1_200_000, byProject: { 1: 900_000, 2: 300_000 } } : d)),
    tokens: 1_200_000,
    reportedCost: 3.4,
    sessionsStarted: 5,
    mergeRequestsMerged: 2,
    medianRunMs: 400_000,
    medianWaitMs: 22 * 60_000,
    perProject: [
      { projectId: 1, project: 'loom', tokens: 900_000 },
      { projectId: 2, project: 'docs', tokens: 300_000 },
    ],
    perModel: [{ model: 'anthropic/claude-sonnet-5-5', tokens: 1_200_000 }],
    mix: { input: 300_000, output: 100_000, cacheRead: 700_000, cacheWrite: 50_000, reasoning: 50_000 },
    cacheHitRate: 700_000 / 1_050_000,
    outcomes: { merged: 2, closed: 0, archived: 1, open: 2, stuck: 1 },
    topSessions: [
      {
        sessionId: 7,
        title: 'Fix the login bug',
        projectId: 1,
        project: 'loom',
        issue: { number: 42, url: 'https://github.com/theholocoder/loom/issues/42' },
        mergeRequest: { number: 12, url: 'https://github.com/theholocoder/loom/pull/12' },
        model: 'anthropic/claude-sonnet-5-5',
        tokens: 900_000,
        workingMs: 72 * 60_000,
        outcome: 'merged',
      },
      { sessionId: 99, title: 'Old Session', projectId: 3, project: 'gone', model: 'openai/gpt-5.1', tokens: 300_000, workingMs: 30_000, outcome: 'archived' },
    ],
  };
}

function openDashboard(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
  return screen.getByRole('main', { name: 'Dashboard' });
}

const tile = (view: HTMLElement, name: string) => within(view).getByRole('group', { name });

describe('the dashboard', () => {
  it('shows the headline tiles over the last 7 days, with cost labelled as reported, and no wait tile', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session] }, { 'usage.dashboard': ({ days }) => dashboard(days) });
    const view = openDashboard(main);

    await within(view).findByRole('group', { name: 'Tokens' });
    expect(main.invoked).toContainEqual({ command: 'usage.dashboard', params: { days: 7 } });
    expect(tile(view, 'Tokens').textContent).toContain('1.2M');
    expect(tile(view, 'Reported cost').textContent).toContain('$3.40');
    expect(tile(view, 'Reported cost').textContent).toContain('Subscription and local models report $0');
    expect(tile(view, 'Sessions started').textContent).toContain('5');
    expect(tile(view, 'Merge requests merged').textContent).toContain('2');
    expect(tile(view, 'Cache hit rate').textContent).toContain('67%');
    expect(tile(view, 'Median agent run').textContent).toContain('6m 40s');
    expect(within(view).queryByRole('group', { name: 'Median wait for you' })).toBeNull();
  });

  it('switches between 7, 30 and 90 days', async () => {
    const main = new FakeMain({ projects: [project] }, { 'usage.dashboard': ({ days }) => dashboard(days) });
    const view = openDashboard(main);
    await within(view).findByRole('group', { name: 'Tokens' });

    fireEvent.click(within(view).getByRole('radio', { name: '30 days' }));

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'usage.dashboard', params: { days: 30 } }));
    expect(within(view).getByRole('radio', { name: '30 days' }).getAttribute('aria-checked')).toBe('true');
    expect(within(view).getByRole('radio', { name: '90 days' })).toBeTruthy();
  });

  it('charts tokens per day, Project and model, the token mix with the cache hit rate, and Session outcomes', async () => {
    const main = new FakeMain({ projects: [project] }, { 'usage.dashboard': ({ days }) => dashboard(days) });
    const view = openDashboard(main);
    await within(view).findByRole('group', { name: 'Tokens' });

    expect(within(view).getByRole('img', { name: 'Tokens per day by Project' })).toBeTruthy();
    const perProject = within(view).getByRole('list', { name: 'Tokens per Project' });
    expect(within(perProject).getAllByRole('listitem').map((i) => i.textContent)).toEqual(['loom900k', 'docs300k']);
    const perModel = within(view).getByRole('list', { name: 'Tokens per model' });
    expect(within(perModel).getAllByRole('listitem').map((i) => i.textContent)).toEqual(['anthropic/claude-sonnet-5-5' + '1.2M']);
    const mix = within(view).getByRole('region', { name: 'Token mix' });
    expect(mix.textContent).toContain('cache read 58%');
    expect(mix.textContent).toContain('Cache hit rate 67%');
    const outcomes = within(view).getByRole('list', { name: 'Session outcomes' });
    expect(within(outcomes).getAllByRole('listitem').map((i) => i.textContent)).toEqual(['Merged2', 'Closed0', 'Archived, no Merge request1', 'Open2', 'Stuck at least once1']);
  });

  it('lists the Top Sessions, opening one that is still on this machine', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session] }, { 'usage.dashboard': ({ days }) => dashboard(days) });
    const view = openDashboard(main);
    await within(view).findByRole('group', { name: 'Tokens' });

    const table = within(view).getByRole('table', { name: 'Top Sessions by tokens' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['Fix the login bug', 'loom', '#42 · #12', 'anthropic/claude-sonnet-5-5', '900k', '1h 12m', 'Merged'],
      ['Old Session', 'gone', 'Session without issue', 'openai/gpt-5.1', '300k', '30s', 'Archived'],
    ]);

    fireEvent.click(rows[0]!);
    await waitFor(() => expect(screen.queryByRole('main', { name: 'Dashboard' })).toBeNull());
  });

  it('moves between ranges with the arrow keys', async () => {
    const main = new FakeMain({ projects: [project] }, { 'usage.dashboard': ({ days }) => dashboard(days) });
    const view = openDashboard(main);
    await within(view).findByRole('group', { name: 'Tokens' });

    fireEvent.keyDown(within(view).getByRole('radio', { name: '7 days' }), { key: 'ArrowRight' });

    expect(within(view).getByRole('radio', { name: '30 days' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(within(view).getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'usage.dashboard', params: { days: 30 } }));
  });

  it('opens a Top Session with Enter', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session] }, { 'usage.dashboard': ({ days }) => dashboard(days) });
    const view = openDashboard(main);
    await within(view).findByRole('group', { name: 'Tokens' });

    const row = within(within(view).getByRole('table', { name: 'Top Sessions by tokens' })).getAllByRole('row')[1]!;
    fireEvent.keyDown(row, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByRole('main', { name: 'Dashboard' })).toBeNull());
  });

  it('works the numbers out again when a Session’s status changes', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session] }, { 'usage.dashboard': ({ days }) => dashboard(days) });
    const view = openDashboard(main);
    await within(view).findByRole('group', { name: 'Tokens' });
    const asked = () => main.invoked.filter((i) => i.command === 'usage.dashboard').length;
    const before = asked();

    act(() => main.publish('sessions', [{ ...session, updatedAt: 99 }]));

    await waitFor(() => expect(asked()).toBe(before + 1));
  });

  it('rounds token counts up into the next unit', async () => {
    const main = new FakeMain({ projects: [project] }, { 'usage.dashboard': ({ days }) => ({ ...emptyDashboard(days), tokens: 999_600 }) });
    const view = openDashboard(main);

    await waitFor(() => expect(tile(view, 'Tokens').textContent).toContain('1.0M'));
  });

  it('says so when nothing has been recorded yet', async () => {
    const main = new FakeMain({ projects: [project] });
    const view = openDashboard(main);

    await within(view).findByText('No usage recorded in the last 7 days.');
    expect(tile(view, 'Median agent run').textContent).toContain('—');
    expect(tile(view, 'Cache hit rate').textContent).toContain('—');
  });
});
