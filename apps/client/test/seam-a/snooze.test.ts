import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type AcpTurn } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];
const HOUR = 3_600_000;

/** Main with a Project, and a Session on it Waiting as finished, read. */
async function waitingSession(turns: AcpTurn[] = [{ chunks: ['Done.'] }], userDataDir?: string) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  const checkout = machine.gitRepo('billing-api');
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
  await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
  await main.api.invoke('sessions.setUnread', { id, unread: false });
  return { main, machine, id };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

describe('a snoozed Session', () => {
  it('is snoozed until the time given, then comes back unread', async () => {
    const { main, id } = await waitingSession();
    const until = main.clock.now() + HOUR;

    await main.api.invoke('sessions.snooze', { id, until });
    await waitFor(main.api, 'sessions', session(id, (s) => s.snoozedUntil === until && !s.unread));

    await main.elapse(HOUR - 1000);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)?.snoozedUntil).toBe(until);
    await main.elapse(1000);
    const woken = (await waitFor(main.api, 'sessions', session(id, (s) => s.snoozedUntil === undefined))).find((s) => s.id === id)!;
    expect(woken).toMatchObject({ status: 'waiting', waitingReason: 'finished', unread: true });
  });

  it('stops being snoozed when its status changes: the user replies', async () => {
    const { main, id } = await waitingSession([{ chunks: ['Done.'] }, { chunks: ['Again.'], hold: 'reply' }]);
    await main.api.invoke('sessions.snooze', { id, until: main.clock.now() + HOUR });
    await main.api.invoke('sessions.send', { id, prompt: 'More' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'working' && s.snoozedUntil === undefined));
  });

  it('can be woken now by hand, read as it was', async () => {
    const { main, id } = await waitingSession();
    await main.api.invoke('sessions.snooze', { id, until: main.clock.now() + HOUR });
    await main.api.invoke('sessions.snooze', { id, until: null });
    await waitFor(main.api, 'sessions', session(id, (s) => s.snoozedUntil === undefined && !s.unread));
    await main.elapse(HOUR);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)?.unread).toBe(false);
  });

  it('stays snoozed after a restart, and comes back at once if its time came while Loom was closed', async () => {
    const userDataDir = tempDir('loom-snooze-');
    const { main, machine, id } = await waitingSession(undefined, userDataDir);
    const until = main.clock.now() + HOUR;
    await main.api.invoke('sessions.snooze', { id, until });
    await main.close();

    const again = await startMain({ machine, userDataDir });
    expect((await again.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ snoozedUntil: until, unread: false });
    await again.close();

    const later = await startMain({ machine, userDataDir, now: until + 1 });
    expect((await later.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'waiting', unread: true });
    expect((await later.api.invoke('sessions.list')).find((s) => s.id === id)?.snoozedUntil).toBeUndefined();
  });

  it('refuses a time that has passed, and a Session that is not Waiting', async () => {
    const { main, id } = await waitingSession([{ chunks: ['Done.'] }, { chunks: ['Again.'], hold: 'reply' }]);
    await expect(main.api.invoke('sessions.snooze', { id, until: main.clock.now() })).rejects.toThrow('A snooze must end in the future.');
    await expect(main.api.invoke('sessions.snooze', { id, until: Number.NaN })).rejects.toThrow('A snooze needs a time to wake at.');
    await main.api.invoke('sessions.send', { id, prompt: 'More' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'working'));
    await expect(main.api.invoke('sessions.snooze', { id, until: main.clock.now() + HOUR })).rejects.toThrow('Only a Waiting Session can be snoozed.');
  });
});
