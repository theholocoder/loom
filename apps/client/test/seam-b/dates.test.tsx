import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session, type Settings } from '../../src/shared/api';
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
  color: 'blue',
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

/** Sessions Snoozed until tomorrow, Friday and the end of the month, each at 9:00. */
const snoozed = () => [
  session({ title: 'Tomorrow', snoozedUntil: new Date(2026, 10, 12, 9, 0).getTime() }),
  session({ title: 'Friday', snoozedUntil: new Date(2026, 10, 13, 9, 0).getTime() }),
  session({ title: 'Later', snoozedUntil: new Date(2026, 10, 30, 9, 0).getTime() }),
];

/** The app on a system whose regional format is `systemLocale`, as main reports it. */
function renderApp({ systemLocale, settings = {}, sessions = [] }: { systemLocale: string; settings?: Partial<Settings>; sessions?: Session[] }) {
  const main = new FakeMain({ projects: [loom], sessions, settings: { ...DEFAULT_SETTINGS, ...settings } }, { 'settings.systemLocale': () => systemLocale });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const inbox = () => screen.getByRole('complementary', { name: 'Inbox' });
/** When each Snoozed card's Session comes back, by title. */
function wakeTimes(): Record<string, string | null> {
  if (!within(inbox()).queryByRole('list', { name: 'Snoozed' })) fireEvent.click(within(inbox()).getByRole('button', { name: 'Snoozed' }));
  const list = within(inbox()).getByRole('list', { name: 'Snoozed' });
  return Object.fromEntries(within(list).getAllByRole('listitem').map((item) => [item.getAttribute('aria-label'), within(item).getByRole('time').textContent]));
}

describe('dates and times', () => {
  it("are written in English, in the order and on the clock of a French system's regional format", async () => {
    renderApp({ systemLocale: 'fr-FR', sessions: snoozed() });

    await waitFor(() => expect(wakeTimes()).toEqual({ Tomorrow: 'until Tomorrow 09:00', Friday: 'until Fri 09:00', Later: 'until 30 Nov 09:00' }));
    const later = within(within(inbox()).getByRole('listitem', { name: 'Later' })).getByRole('time');
    expect(later.getAttribute('title')).toBe('Comes back Mon, 30 Nov 2026, 09:00');
  });

  it("follow a United States system's regional format", async () => {
    renderApp({ systemLocale: 'en-US', sessions: snoozed() });

    await waitFor(() => expect(wakeTimes()).toEqual({ Tomorrow: 'until Tomorrow 9:00 AM', Friday: 'until Fri 9:00 AM', Later: 'until Nov 30 9:00 AM' }));
  });

  it('follow the regional format and clock picked in Settings over the system', async () => {
    renderApp({ systemLocale: 'fr-FR', settings: { dateFormat: 'en-US', hourCycle: '24h' }, sessions: snoozed() });

    await waitFor(() => expect(wakeTimes()).toEqual({ Tomorrow: 'until Tomorrow 09:00', Friday: 'until Fri 09:00', Later: 'until Nov 30 09:00' }));
  });

  it('write how long ago in English, then the day in the regional format', async () => {
    renderApp({
      systemLocale: 'de-DE',
      sessions: [session({ title: 'Recent', updatedAt: NOW - 3 * HOUR }), session({ title: 'Old', updatedAt: new Date(2026, 9, 26, 15, 0).getTime() }), session({ title: 'Last year', updatedAt: new Date(2025, 9, 26, 15, 0).getTime() })],
    });

    const time = (title: string) => within(within(inbox()).getByRole('listitem', { name: title })).getByRole('time');
    await waitFor(() => expect(time('Old').textContent).toBe('26 Oct'));
    expect(time('Recent').textContent).toBe('3h');
    expect(time('Last year').textContent).toBe('26 Oct 2025');
    expect(time('Old').getAttribute('title')).toBe('Waiting since Mon, 26 Oct 2026, 15:00');
  });

  it("say, under the custom snooze's date and time, when it comes back, as Loom writes it", async () => {
    renderApp({ systemLocale: 'fr-FR', sessions: [session({ title: 'Later' })] });
    await waitFor(() => expect(within(within(inbox()).getByRole('listitem', { name: 'Later' })).getByRole('time').textContent).toBe('1m'));
    fireEvent.click(within(within(inbox()).getByRole('listitem', { name: 'Later' })).getByRole('button', { name: 'Snooze' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Snooze' })).getByRole('menuitem', { name: 'Custom…' }));
    const custom = within(screen.getByRole('dialog', { name: 'Snooze' }));

    fireEvent.change(custom.getByLabelText('Date'), { target: { value: '2026-11-12' } });
    fireEvent.change(custom.getByLabelText('Time'), { target: { value: '14:30' } });
    expect(custom.getByRole('status').textContent).toBe('Comes back Tomorrow 14:30');
    fireEvent.change(custom.getByLabelText('Date'), { target: { value: '2026-11-20' } });
    expect(custom.getByRole('status').textContent).toBe('Comes back 20 Nov 14:30');
    fireEvent.change(custom.getByLabelText('Date'), { target: { value: '2026-11-01' } });
    expect(custom.queryByRole('status')).toBeNull();
  });
});

describe('the date settings', () => {
  const pick = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
  const options = (name: string) => {
    fireEvent.click(pick(name));
    return within(screen.getByRole('listbox', { name })).getAllByRole('option');
  };
  const openSettings = (main: FakeMain) => {
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    return main;
  };

  it("match the system until set, each option showing how it writes the same moment", async () => {
    openSettings(renderApp({ systemLocale: 'fr-FR' }));

    await waitFor(() => expect(pick('Regional format').textContent).toBe('Match system (Mon, 9 Nov 2026, 14:05)'));
    const formats = options('Regional format').map((o) => o.textContent);
    expect(formats).toContain('United States (Mon, Nov 9, 2026, 2:05 PM)');
    expect(formats).toContain('Germany (Mon, 9 Nov 2026, 14:05)');
    fireEvent.click(pick('Regional format'));
    expect(pick('Clock').textContent).toBe('Match the format (14:05)');
    expect(options('Clock').map((o) => o.textContent)).toEqual(['Match the format (14:05)', '12-hour (2:05 pm)', '24-hour (14:05)']);
  });

  it('saves the regional format and the clock picked', async () => {
    const main = openSettings(renderApp({ systemLocale: 'fr-FR' }));
    await waitFor(() => expect(pick('Regional format').textContent).toMatch(/^Match system/));

    fireEvent.click(pick('Regional format'));
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Regional format' })).getByRole('option', { name: /^United States/ }));
    await waitFor(() => expect(pick('Regional format').textContent).toBe('United States (Mon, Nov 9, 2026, 2:05 PM)'));
    fireEvent.click(pick('Clock'));
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Clock' })).getByRole('option', { name: /^24-hour/ }));

    await waitFor(() => expect(pick('Clock').textContent).toBe('24-hour (14:05)'));
    expect(main.invoked.filter((i) => i.command === 'settings.setDateFormat').map((i) => i.params)).toEqual([{ dateFormat: 'en-US' }, { hourCycle: '24h' }]);
  });
});
