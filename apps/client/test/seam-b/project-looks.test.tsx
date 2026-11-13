import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, UsageDashboard } from '../../src/shared/api';
import { emptyDashboard, FakeMain } from './fake-main';

afterEach(cleanup);

// One colour per Project, the user's pick, the same in its avatar, the Glance
// strip, the Inbox's cards and the Dashboard's charts.

const web: Project = {
  id: 4,
  name: 'web-frontend',
  color: 'magenta',
  avatar: '🦊',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/web-frontend' },
  forge: { state: 'no-remote', checking: false },
};

const waiting: Session = {
  id: 9,
  projectId: web.id,
  title: 'Fix the header',
  workingCopy: { kind: 'checkout', path: '/home/dev/web-frontend' },
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: 1,
  updatedAt: 2,
};

const usage: UsageDashboard = {
  ...emptyDashboard(7),
  tokens: 100,
  perDay: emptyDashboard(7).perDay.map((d, i) => (i === 6 ? { ...d, tokens: 100, byProject: { [web.id]: 100 } } : d)),
  perProject: [{ projectId: web.id, project: 'web-frontend', color: 'magenta', tokens: 100 }],
};

function renderApp(projects: Project[] = [web]) {
  const main = new FakeMain({ projects, sessions: [waiting] }, { 'usage.dashboard': () => usage });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const inbox = () => within(screen.getByRole('complementary', { name: 'Inbox' }));
const MAGENTA = 'var(--proj-magenta)';

describe("a Project's colour and avatar", () => {
  it('show on its Inbox group: the avatar the user set, on its colour', () => {
    renderApp();

    const avatar = within(inbox().getByRole('group', { name: 'web-frontend' })).getByText('🦊');
    expect(avatar.className).toBe('proj-avatar');
    expect(avatar.getAttribute('style')).toContain(MAGENTA);
  });

  it('show its initials when it has no avatar, in the ink that reads on its colour', () => {
    renderApp([{ ...web, avatar: undefined, color: 'yellow' }]);

    const avatar = within(inbox().getByRole('group', { name: 'web-frontend' })).getByText('WE');
    expect(avatar.getAttribute('style')).toContain('var(--proj-yellow)');
    expect(avatar.getAttribute('style')).toContain('color: var(--proj-yellow-ink)');
  });

  it('colour its badge in the Session header', () => {
    renderApp();
    fireEvent.click(inbox().getByRole('button', { name: 'Fix the header' }));

    const tag = screen.getByRole('region', { name: 'Session header' }).querySelector('.proj-tag')!;
    expect(tag.textContent).toBe('web-frontend');
    expect(tag.querySelector('.proj-dot')!.getAttribute('style')).toContain(MAGENTA);
  });

  it('colour it in the Dashboard charts, whatever its rank', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));

    const perProject = await screen.findByRole('list', { name: 'Tokens per Project' });
    expect(perProject.querySelector('.fill')!.getAttribute('style')).toContain(MAGENTA);
    expect(screen.getByRole('img', { name: 'Tokens per day by Project' }).querySelector('rect[fill]:not(.hit)')?.getAttribute('fill')).toBe(MAGENTA);
  });
});
