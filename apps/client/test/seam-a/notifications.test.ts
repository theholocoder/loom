// Desktop notifications: a Session gone Waiting notifies, for each kind of
// news the user turned on (none are by default), unless the window has the
// focus on that Session. A click asks the window to open it.
import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type MainHarness, type OpencodeScript } from './harness';
import { DEFAULT_NOTIFICATIONS, type EnvironmentStatus, type NotificationKind, type Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];
const MINUTE = 60_000;

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};
const waiting = (reason: string) => (s: Session) => s.status === 'waiting' && s.waitingReason === reason;

const question = { elicit: { message: 'Which color?', requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Color' } }, required: [] } } };
const write = { permission: { toolCallId: 'call_w', name: 'write', title: '/home/elsewhere/a.txt', kind: 'edit', locations: [{ path: '/home/elsewhere/a.txt' }], rawInput: { path: '/home/elsewhere/a.txt', content: 'hi\n' } } };

/** Main with a Project, the given kinds of notification on, ready to start Sessions whose agent `acp` scripts. */
async function withProject(acp: OpencodeScript['acp'], on: NotificationKind[], { userDataDir }: { userDataDir?: string } = {}) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp });
  const checkout = machine.gitRepo('billing-api');
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  for (const kind of on) await main.api.invoke('settings.setNotification', { kind, on: true });
  const project = await main.api.invoke('projects.link', { path: checkout });
  const start = async (prompt = 'Fix the login bug') => (await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt })).id;
  return { machine, main, start };
}

/** Lets what the agent sent land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const shown = (main: MainHarness) => main.notifications.map(({ title, body }) => ({ title, body }));

describe('desktop notifications', () => {
  it('are all off by default, and a finished Session notifies nothing', async () => {
    const { main, start } = await withProject({ turns: [{ chunks: ['Done.'] }] }, []);
    expect((await waitFor(main.api, 'settings', () => true)).notifications).toEqual(DEFAULT_NOTIFICATIONS);

    const id = await start();
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
    await settle();

    expect(main.notifications).toEqual([]);
  });

  it('tells a Session finished, once turned on, and a click asks the window to open it', async () => {
    const { main, start } = await withProject({ turns: [{ chunks: ['Done.'] }] }, ['finished']);
    const id = await start();
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));

    expect(shown(main)).toEqual([{ title: 'Fix the login bug', body: 'billing-api: Finished' }]);
    expect(await waitFor(main.api, 'openSession', () => true)).toBeNull();
    main.notifications[0]!.click();
    expect(await waitFor(main.api, 'openSession', () => true)).toEqual({ sessionId: id, click: 1 });
    main.notifications[0]!.click();
    expect(await waitFor(main.api, 'openSession', () => true)).toEqual({ sessionId: id, click: 2 });
  });

  it('tells nothing while the window has the focus on the Session, but does when it shows another or has lost the focus', async () => {
    const turn = (text: string, hold: string) => ({ chunks: [text], hold });
    const { machine, main, start } = await withProject({ turns: [turn('Done.', 'first'), turn('Again.', 'second'), turn('Once more.', 'third')] }, ['finished']);
    const finishes = async (id: number, hold: string) => {
      machine.release(hold);
      await waitFor(main.api, 'sessions', session(id, waiting('finished')));
      await settle();
    };
    const id = await start();
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    main.setWindowFocused(true);
    await main.api.invoke('window.showing', { sessionId: id });
    await finishes(id, 'first');
    expect(main.notifications).toEqual([]);

    // Another Session, or none, shown.
    await main.api.invoke('window.showing', { sessionId: null });
    await main.api.invoke('sessions.send', { id, prompt: 'Again' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Again.'), { sessionId: id });
    await finishes(id, 'second');
    expect(main.notifications).toHaveLength(1);

    // Shown, but the window is in the background.
    await main.api.invoke('window.showing', { sessionId: id });
    main.setWindowFocused(false);
    await main.api.invoke('sessions.send', { id, prompt: 'Once more' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Once more.'), { sessionId: id });
    await finishes(id, 'third');
    expect(main.notifications).toHaveLength(2);
  });

  it('tells a question and an Approval request only as each is turned on', async () => {
    const { main, start } = await withProject({ turns: [{ chunks: ['Let me ask.', question], hold: 'never' }] }, ['question']);
    const id = await start('Pick a color');
    await waitFor(main.api, 'sessions', session(id, waiting('question')));
    expect(shown(main)).toEqual([{ title: 'Pick a color', body: 'billing-api: Asks you a question' }]);

    const approving = await withProject({ turns: [{ chunks: ['Writing.', write], hold: 'never' }] }, ['finished', 'question']);
    const other = await approving.start();
    await waitFor(approving.main.api, 'sessions', session(other, waiting('approval')));
    await settle();
    expect(approving.main.notifications).toEqual([]);
  });

  it('tells an Approval request', async () => {
    const { main, start } = await withProject({ turns: [{ chunks: ['Writing.', write], hold: 'never' }] }, ['approval']);
    const id = await start('Write the file');
    await waitFor(main.api, 'sessions', session(id, waiting('approval')));
    expect(shown(main)).toEqual([{ title: 'Write the file', body: 'billing-api: Needs your approval' }]);
  });

  it('tells a stuck Session', async () => {
    const { main, start } = await withProject({ turns: [{ chunks: ['On it.'], hold: 'never' }] }, ['stuck', 'finished']);
    const id = await start();
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.elapse(15 * MINUTE);
    await waitFor(main.api, 'sessions', session(id, waiting('stuck')));
    expect(shown(main)).toEqual([{ title: 'Fix the login bug', body: 'billing-api: Stuck: its agent has gone quiet' }]);
  });

  it('tells nothing of a Session the user stopped', async () => {
    const { main, start } = await withProject({ turns: [{ chunks: ['On it.'], hold: 'never' }] }, ['finished', 'question', 'approval', 'feedback', 'stuck']);
    const id = await start();
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    await main.api.invoke('sessions.stop', { id });
    await waitFor(main.api, 'sessions', session(id, waiting('stopped')));
    await settle();

    expect(main.notifications).toEqual([]);
  });

  it('tells nothing again when the user reopens a finished Session they archived', async () => {
    const { main, start } = await withProject({ turns: [{ chunks: ['Done.'] }] }, ['finished']);
    const id = await start();
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
    expect(main.notifications).toHaveLength(1);

    await main.api.invoke('sessions.archive', { id });
    await main.api.invoke('sessions.unarchive', { id });
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
    await settle();

    expect(main.notifications).toHaveLength(1);
  });

  it('keeps which kinds are on when Loom restarts, and rejects an unknown kind', async () => {
    const userDataDir = tempDir('loom-notifications-');
    const first = await withProject({ turns: [] }, ['question', 'stuck'], { userDataDir });
    await expect(first.main.api.invoke('settings.setNotification', { kind: 'nonsense' as NotificationKind, on: true })).rejects.toThrow('"nonsense" is not a kind of notification');
    await first.main.close();

    const again = await startMain({ userDataDir, machine: first.machine });
    expect((await waitFor(again.api, 'settings', () => true)).notifications).toEqual({ ...DEFAULT_NOTIFICATIONS, question: true, stuck: true });
  });
});
