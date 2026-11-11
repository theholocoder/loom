import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

// Wednesday 2026-11-11, 10:42 local time.
const NOW = new Date(2026, 10, 11, 10, 42).getTime();
const HOUR = 3_600_000;

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const loom: Project = {
  id: 1,
  name: 'loom',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/loom' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'theholocoder/loom' },
};

let nextId = 1;
function session(change: Partial<Session> = {}): Session {
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
    createdAt: NOW - HOUR,
    updatedAt: NOW - 60_000,
    ...change,
  };
}

function renderApp(sessions: Session[]) {
  const main = new FakeMain({ projects: [loom], sessions });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const inbox = () => screen.getByRole('complementary', { name: 'Inbox' });
const row = (title: string) => within(inbox()).getByRole('listitem', { name: title });
const snoozes = (main: FakeMain) => main.invoked.filter((i) => i.command === 'sessions.snooze').map((i) => i.params);
const openMenu = (title: string) => {
  fireEvent.click(within(row(title)).getByRole('button', { name: 'Snooze' }));
  return screen.getByRole('menu', { name: 'Snooze' });
};

describe('snoozing a Session from its Inbox row', () => {
  it('offers 1 hour, 3 hours, tomorrow and next week at 9:00, and custom', () => {
    renderApp([session({ title: 'Later' })]);
    const menu = openMenu('Later');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.getAttribute('aria-label'))).toEqual(['1 hour', '3 hours', 'Tomorrow', 'Next week', 'Custom…']);
  });

  it.each([
    ['1 hour', NOW + HOUR],
    ['3 hours', NOW + 3 * HOUR],
    ['Tomorrow', new Date(2026, 10, 12, 9, 0).getTime()],
    ['Next week', new Date(2026, 10, 16, 9, 0).getTime()],
  ])('snoozes for %s', async (label, until) => {
    const later = session({ title: 'Later' });
    const main = renderApp([later]);
    fireEvent.click(within(openMenu('Later')).getByRole('menuitem', { name: label }));
    await waitFor(() => expect(snoozes(main)).toEqual([{ id: later.id, until }]));
    expect(screen.queryByRole('menu', { name: 'Snooze' })).toBeNull();
  });

  it('snoozes on a Monday until the Monday after', async () => {
    vi.setSystemTime(new Date(2026, 10, 16, 8, 0));
    const later = session({ title: 'Later' });
    const main = renderApp([later]);
    fireEvent.click(within(openMenu('Later')).getByRole('menuitem', { name: 'Next week' }));
    await waitFor(() => expect(snoozes(main)).toEqual([{ id: later.id, until: new Date(2026, 10, 23, 9, 0).getTime() }]));
  });

  it('snoozes until a date and time picked', async () => {
    const later = session({ title: 'Later' });
    const main = renderApp([later]);
    fireEvent.click(within(openMenu('Later')).getByRole('menuitem', { name: 'Custom…' }));
    const custom = screen.getByRole('dialog', { name: 'Snooze' });
    fireEvent.change(within(custom).getByLabelText('Date'), { target: { value: '2026-11-20' } });
    fireEvent.change(within(custom).getByLabelText('Time'), { target: { value: '14:30' } });
    fireEvent.click(within(custom).getByRole('button', { name: 'Snooze' }));
    await waitFor(() => expect(snoozes(main)).toEqual([{ id: later.id, until: new Date(2026, 10, 20, 14, 30).getTime() }]));
    expect(screen.queryByRole('dialog', { name: 'Snooze' })).toBeNull();
  });

  it('snoozes for a duration given', async () => {
    const later = session({ title: 'Later' });
    const main = renderApp([later]);
    fireEvent.click(within(openMenu('Later')).getByRole('menuitem', { name: 'Custom…' }));
    const custom = screen.getByRole('dialog', { name: 'Snooze' });
    fireEvent.click(within(custom).getByRole('radio', { name: 'For' }));
    fireEvent.change(within(custom).getByLabelText('Hours'), { target: { value: '2' } });
    fireEvent.change(within(custom).getByLabelText('Minutes'), { target: { value: '15' } });
    fireEvent.click(within(custom).getByRole('button', { name: 'Snooze' }));
    await waitFor(() => expect(snoozes(main)).toEqual([{ id: later.id, until: NOW + 2 * HOUR + 15 * 60_000 }]));
  });

  it('will not snooze until a time that has passed, nor for no time at all', () => {
    const main = renderApp([session({ title: 'Later' })]);
    fireEvent.click(within(openMenu('Later')).getByRole('menuitem', { name: 'Custom…' }));
    const custom = screen.getByRole('dialog', { name: 'Snooze' });
    fireEvent.change(within(custom).getByLabelText('Date'), { target: { value: '2026-11-11' } });
    fireEvent.change(within(custom).getByLabelText('Time'), { target: { value: '09:00' } });
    expect((within(custom).getByRole('button', { name: 'Snooze' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(custom).getByRole('radio', { name: 'For' }));
    fireEvent.change(within(custom).getByLabelText('Hours'), { target: { value: '0' } });
    fireEvent.change(within(custom).getByLabelText('Minutes'), { target: { value: '0' } });
    expect((within(custom).getByRole('button', { name: 'Snooze' }) as HTMLButtonElement).disabled).toBe(true);
    expect(snoozes(main)).toEqual([]);
  });
});

describe('a snoozed Session', () => {
  it('leaves the Inbox for the Snoozed section, with when it comes back', () => {
    renderApp([session({ title: 'Now' }), session({ title: 'Later', snoozedUntil: new Date(2026, 10, 12, 9, 0).getTime() })]);
    expect(within(inbox()).getAllByRole('listitem').map((item) => item.getAttribute('aria-label'))).toEqual(['Now']);
    const section = within(inbox()).getByRole('button', { name: 'Snoozed' });
    expect(section.textContent).toContain('1');
    fireEvent.click(section);
    const snoozed = within(inbox()).getByRole('button', { name: 'Later' });
    expect(within(snoozed).getByRole('time').textContent).toBe('Tomorrow 09:00');
  });

  it('is skipped by j and k', () => {
    renderApp([session({ title: 'First' }), session({ title: 'Later', snoozedUntil: NOW + HOUR, updatedAt: NOW }), session({ title: 'Second', updatedAt: NOW - 120_000 })]);
    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(within(screen.getByRole('region', { name: 'Session header' })).getByRole('heading').textContent).toBe('Second');
  });

  it('says so in its header, where it can be woken now', async () => {
    const later = session({ title: 'Later', snoozedUntil: NOW + HOUR });
    const main = renderApp([later]);
    fireEvent.click(within(inbox()).getByRole('button', { name: 'Snoozed' }));
    fireEvent.click(within(inbox()).getByRole('button', { name: 'Later' }));
    const header = within(screen.getByRole('region', { name: 'Session header' }));
    expect(header.getByRole('status', { name: 'Snoozed' }).textContent).toBe('Snoozed until 11:42');
    fireEvent.click(header.getByRole('button', { name: 'Unsnooze' }));
    await waitFor(() => expect(snoozes(main)).toEqual([{ id: later.id, until: null }]));
  });
});
