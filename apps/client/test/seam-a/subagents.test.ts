// Subagents: what a Session's agent starts on its own to do part of the work.
// OpenCode 2.4.2 runs them in the background and, to a client that opts in,
// reports them as `opencode/session/child_update` notifications (the shapes
// here are as recorded from it). A Session is Working while any of them
// runs, and they are kept, transcripts and all, with the Session.
import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type AcpTurn, type MainHarness, type OpencodeScript } from './harness';
import type { EnvironmentStatus, Session, Subagent, TranscriptItem } from '../../src/shared/api';
import { IDLE_STOP_MS } from '../../src/main/sessions/sessions';
import { BACKGROUND_RUN_QUIET_MS } from '../../src/main/agents/acp-adapter';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];
const models = [{ providerID: 'opencode', id: 'pulse-free', name: 'Pulse Free' }];

type Chunk = NonNullable<AcpTurn['after']>[number];

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};
const waiting = (reason: string) => (s: Session) => s.status === 'waiting' && s.waitingReason === reason;
const working = (s: Session) => s.status === 'working';

/** A child_update notification about subagent `child`, as OpenCode 2.4.2 sends it. */
function childUpdate(child: string, what: Record<string, unknown>, { parent = '$ROOT', depth = 1, title = 'Explore auth' } = {}): Chunk {
  return { notify: { method: 'opencode/session/child_update', params: { rootSessionId: '$ROOT', childSessionId: child, parentSessionId: parent, depth, title, ...what } } };
}
const childStatus = (child: string, status: string, options?: Parameters<typeof childUpdate>[2]) => childUpdate(child, { type: 'status', status }, options);
/** One of the subagent's own session updates, its tool calls' ids and titles prefixed as OpenCode does. */
const childSays = (child: string, update: Record<string, unknown>, options?: Parameters<typeof childUpdate>[2]) => childUpdate(child, { type: 'update', update }, options);
const childText = (child: string, text: string, options?: Parameters<typeof childUpdate>[2]) => childSays(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, options);

/**
 * The parent's `subagent` tool call starting `child`, as OpenCode 2.4.2
 * reports it: `send` turns each of its session updates into a chunk (as is
 * for the Session's own agent; inside a child_update for a Subagent's).
 */
function startsSubagent(callId: string, child: string, input: Record<string, unknown>, send: (update: Record<string, unknown>) => Chunk = (update) => ({ update }), options?: Parameters<typeof childUpdate>[2]): Chunk[] {
  return [
    send({ sessionUpdate: 'tool_call', toolCallId: callId, name: 'subagent', title: 'subagent', kind: 'think', status: 'pending', locations: [], rawInput: {} }),
    send({ sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'in_progress', kind: 'think', title: 'subagent', locations: [], rawInput: input }),
    childStatus(child, 'created', { ...options, title: String(input.description) }),
    send({
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      status: 'completed',
      locations: [],
      content: [{ type: 'content', content: { type: 'text', text: `The subagent is working in the background (sessionID: ${child}).` } }],
      rawOutput: { metadata: { sessionID: child, status: 'running', truncated: false } },
    }),
    childStatus(child, 'running', { ...options, title: String(input.description) }),
  ];
}

const EXPLORE = { agent: 'explore', description: 'Explore auth', prompt: 'Find where sessions are checked.' };

function machineWith(acp: OpencodeScript['acp']) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.4.2', integrations: signedIn, models, acp });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

/** Main with a Session whose agent `acp` scripts, started on its first prompt. */
async function started(acp: OpencodeScript['acp'], { userDataDir, notify = true }: { userDataDir?: string; notify?: boolean } = {}) {
  const { machine, checkout } = machineWith(acp);
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  if (notify) await main.api.invoke('settings.setNotification', { kind: 'finished', on: true });
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the login bug' });
  return { machine, main, id, project };
}

/** Lets what the agent sent land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const subagentsOf = (main: MainHarness, id: number, check: (subagents: Subagent[]) => boolean) => waitFor(main.api, 'subagents', check, { sessionId: id });
const transcriptOf = (main: MainHarness, id: number, subagentId: string, check: (items: TranscriptItem[]) => boolean) =>
  waitFor(main.api, 'subagentTranscript', check, { sessionId: id, subagentId });

describe('a Session with Subagents', () => {
  it('stays Working while a Subagent outlives the prompt, with no idle stop and no news, and goes Waiting once it and the run its result starts have ended', async () => {
    const { machine, main, id } = await started({
      turns: [
        {
          chunks: ['Starting a Subagent.', ...startsSubagent('call_sub', 'ses_child1', EXPLORE), ' It runs in the background.'],
          after: [{ hold: 'child-done' }, childText('ses_child1', 'Sessions are checked in auth.ts.'), childStatus('ses_child1', 'completed'), { hold: 'result' }, 'The Subagent found it in auth.ts.'],
        },
      ],
    });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text.endsWith('background.')), { sessionId: id });
    await settle();

    // The prompt has returned; the Subagent goes on.
    await main.elapse(IDLE_STOP_MS + 60_000);
    let [now] = (await main.api.invoke('sessions.list')).filter((s) => s.id === id);
    expect(now).toMatchObject({ status: 'working', unread: false, runningSubagents: 1, subagentsOnly: true });
    expect(main.notifications).toEqual([]);
    // Its agent is still running: no idle stop ended it.
    const pids = [...new Set(machine.acpMessages().map((m) => m.pid))];
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0]!, 0)).not.toThrow();

    machine.release('child-done');
    await subagentsOf(main, id, (list) => list[0]?.status === 'completed');
    await settle();
    [now] = (await main.api.invoke('sessions.list')).filter((s) => s.id === id);
    // The Subagent's result starts the parent's next run.
    expect(now).toMatchObject({ status: 'working' });
    expect(now!.runningSubagents).toBeUndefined();
    expect(now!.subagentsOnly).toBeUndefined();

    machine.release('result');
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'The Subagent found it in auth.ts.'), { sessionId: id });
    await main.elapse(BACKGROUND_RUN_QUIET_MS - 1);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.status).toBe('working');
    await main.elapse(1);
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
    expect(main.notifications.map((n) => n.body)).toEqual(['billing-api: Finished']);
  });

  it("keeps each Subagent, nested ones with their parent, linked to the tool call that started it, its own transcript apart from the Session's", async () => {
    const inner = { agent: 'general', description: 'Read the tests', prompt: 'Read auth.test.ts.', model: 'opencode/pulse-free' };
    const inChild = (update: Record<string, unknown>) => {
      const call = update as { toolCallId: string; title?: string };
      return childSays('ses_child1', { ...update, toolCallId: `ses_child1:${call.toolCallId}`, ...(call.title ? { title: `Explore auth: ${call.title}` } : {}) });
    };
    const { machine, main, id } = await started({
      turns: [
        {
          chunks: [...startsSubagent('call_sub', 'ses_child1', EXPLORE), 'Waiting on it.'],
          after: [
            childSays('ses_child1', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Where to look?' } }),
            childText('ses_child1', 'Looking in src/.'),
            inChild({ sessionUpdate: 'tool_call', toolCallId: 'call_grep', name: 'grep', title: 'grep', kind: 'search', status: 'pending', locations: [], rawInput: { pattern: 'checkSession' } }),
            inChild({ sessionUpdate: 'tool_call_update', toolCallId: 'call_grep', status: 'completed', title: 'grep', content: [{ type: 'content', content: { type: 'text', text: 'src/auth.ts:12' } }] }),
            ...startsSubagent('call_inner', 'ses_child2', inner, inChild, { parent: 'ses_child1', depth: 2 }),
            childText('ses_child2', 'The tests cover it.', { parent: 'ses_child1', depth: 2, title: 'Read the tests' }),
            childStatus('ses_child2', 'completed', { parent: 'ses_child1', depth: 2, title: 'Read the tests' }),
            { hold: 'end' },
            childStatus('ses_child1', 'completed'),
          ],
        },
      ],
    });
    const subagents = await subagentsOf(main, id, (list) => list.length === 2 && list[1]!.status === 'completed');
    expect(subagents.map(({ startedAt: _s, endedAt: _e, ...rest }) => rest)).toEqual([
      { id: 'ses_child1', depth: 1, toolCallId: 'call_sub', agent: 'explore', description: 'Explore auth', status: 'running' },
      { id: 'ses_child2', parentId: 'ses_child1', depth: 2, toolCallId: 'call_inner', agent: 'general', description: 'Read the tests', model: 'opencode/pulse-free', status: 'completed' },
    ]);

    const child = await transcriptOf(main, id, 'ses_child1', (items) => items.some((i) => i.kind === 'tool' && i.toolCallId === 'call_inner' && i.status === 'completed'));
    expect(child.map(({ id: _id, ...rest }) => rest)).toEqual([
      { kind: 'thinking', at: expect.any(Number), text: 'Where to look?', streaming: false },
      { kind: 'agent', at: expect.any(Number), text: 'Looking in src/.', streaming: false },
      expect.objectContaining({ kind: 'tool', toolCallId: 'call_grep', title: 'grep', name: 'grep', status: 'completed', subject: 'checkSession', output: 'src/auth.ts:12' }),
      expect.objectContaining({ kind: 'tool', toolCallId: 'call_inner', name: 'subagent', status: 'completed', subagentId: 'ses_child2' }),
    ]);
    // Ended, its text is finished.
    expect(await transcriptOf(main, id, 'ses_child2', (items) => items.length > 0)).toEqual([{ id: 0, kind: 'agent', at: expect.any(Number), text: 'The tests cover it.', streaming: false }]);

    // The Session's own transcript has its card for the Subagent, and none of the Subagents' words.
    const own = await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    expect(own.filter((i) => i.kind === 'agent').map((i) => (i as { text: string }).text)).toEqual(['Waiting on it.']);
    expect(own.find((i) => i.kind === 'tool')).toMatchObject({ toolCallId: 'call_sub', name: 'subagent', status: 'completed', subagentId: 'ses_child1' });
    expect(own.filter((i) => i.kind === 'tool')).toHaveLength(1);

    machine.release('end');
    await subagentsOf(main, id, (list) => list[0]!.status === 'completed');
    expect(machine.acpMessages().find((m) => m.message.method === 'initialize')?.message.params?.clientCapabilities).toMatchObject({ _meta: { 'opencode/child-session-updates': true } });
  });

  it('keeps Subagents and their transcripts across a restart, one left running interrupted', async () => {
    const userDataDir = tempDir('loom-subagents-');
    const { main, id } = await started(
      { turns: [{ chunks: [...startsSubagent('call_sub', 'ses_child1', EXPLORE), 'Waiting on it.'], after: [childText('ses_child1', 'Half way.'), { hold: 'never' }] }] },
      { userDataDir },
    );
    await transcriptOf(main, id, 'ses_child1', (items) => items.length === 1);
    await main.close();

    const again = await startMain({ machine: tempMachine(), userDataDir });
    const [subagent] = await subagentsOf(again, id, (list) => list.length === 1);
    expect(subagent).toMatchObject({ id: 'ses_child1', status: 'interrupted', toolCallId: 'call_sub', description: 'Explore auth' });
    expect(subagent!.endedAt).toBeGreaterThanOrEqual(subagent!.startedAt);
    expect(await transcriptOf(again, id, 'ses_child1', (items) => items.length === 1)).toEqual([{ id: 0, kind: 'agent', at: expect.any(Number), text: 'Half way.', streaming: true }]);
    const [session] = (await again.api.invoke('sessions.list')).filter((s) => s.id === id);
    expect(session!.runningSubagents).toBeUndefined();
  });

  it("stops one Subagent alone with its own Stop, and the Session's Stop stops only its agent's run", async () => {
    const { machine, main, id } = await started({
      turns: [
        { chunks: [...startsSubagent('call_one', 'ses_child1', EXPLORE), ...startsSubagent('call_two', 'ses_child2', { ...EXPLORE, description: 'Explore billing' }), 'Two at work.'] },
        { chunks: ['Looking myself.'], hold: 'never' },
      ],
    });
    await subagentsOf(main, id, (list) => list.length === 2 && list.every((s) => s.status === 'running'));
    await waitFor(main.api, 'sessions', session(id, (s) => s.subagentsOnly === true && s.canStopSubagents === true));

    // Working on its Subagents alone, the Session takes a message at once, as a reply.
    await main.api.invoke('sessions.send', { id, prompt: 'Look at the logs meanwhile' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && i.text === 'Looking myself.'), { sessionId: id });
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'working', runningSubagents: 2 });
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.queue).toBeUndefined();

    await main.api.invoke('sessions.stop', { id });
    await waitFor(main.api, 'sessions', session(id, (s) => s.subagentsOnly === true));
    await settle();
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'working', runningSubagents: 2 });
    expect(machine.acpMessages().some((m) => m.message.method === 'session/close')).toBe(false);

    await main.api.invoke('sessions.stopSubagent', { id, subagentId: 'ses_child1' });
    const list = await subagentsOf(main, id, (l) => l[0]!.status === 'interrupted');
    expect(list[1]!.status).toBe('running');
    expect(machine.acpMessages().filter((m) => m.message.method === 'session/close').map((m) => m.message.params)).toEqual([{ sessionId: 'ses_child1' }]);
    await expect(main.api.invoke('sessions.stopSubagent', { id, subagentId: 'ses_child1' })).rejects.toThrow('not running');

    await main.api.invoke('sessions.stopSubagent', { id, subagentId: 'ses_child2' });
    // The last one's end starts the run its result would; with nothing said, it ends and the Session is Waiting.
    await subagentsOf(main, id, (l) => l[1]!.status === 'interrupted');
    await main.elapse(BACKGROUND_RUN_QUIET_MS);
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
  });

  it("puts a Subagent's Approval request in the Session, named for the Subagent, and goes back to Working on the answer", async () => {
    const write = { toolCallId: 'call_w', name: 'write', title: '/home/elsewhere/a.txt', kind: 'edit', locations: [{ path: '/home/elsewhere/a.txt' }], rawInput: { path: '/home/elsewhere/a.txt', content: 'hi\n' } };
    const { machine, main, id } = await started({
      turns: [{ chunks: [...startsSubagent('call_sub', 'ses_child1', EXPLORE), 'Waiting on it.'], after: [{ permission: write, from: 'ses_child1' }, childText('ses_child1', 'Written.'), { hold: 'never' }] }],
    });
    const items = await waitFor(main.api, 'transcript', (all) => all.some((i) => i.kind === 'approval'), { sessionId: id });
    const card = items.find((i) => i.kind === 'approval')!;
    expect(card).toMatchObject({ kind: 'approval', title: '/home/elsewhere/a.txt', state: 'asked', subagent: { id: 'ses_child1', description: 'Explore auth' } });
    await waitFor(main.api, 'sessions', session(id, waiting('approval')));

    await main.api.invoke('sessions.approve', { id, itemId: card.id, decision: 'once' });
    await transcriptOf(main, id, 'ses_child1', (all) => all.some((i) => i.kind === 'agent' && i.text === 'Written.'));
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'working', subagentsOnly: true });
    const answers = machine.acpMessages().filter((m) => m.message.result?.outcome);
    expect(answers.map((m) => m.message.result)).toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }]);
  });

  it("counts a Subagent's tokens, when the agent reports them, as the Session's", async () => {
    const { main, id } = await started({
      turns: [
        {
          chunks: [...startsSubagent('call_sub', 'ses_child1', EXPLORE), 'Waiting on it.'],
          tokens: { inputTokens: 100, outputTokens: 10 },
          after: [childUpdate('ses_child1', { type: 'status', status: 'completed', usage: { inputTokens: 40, outputTokens: 2, totalTokens: 42 } })],
        },
      ],
    });
    await subagentsOf(main, id, (list) => list[0]?.status === 'completed');
    await waitFor(main.api, 'sessions', session(id, (s) => s.usage?.tokens === 152));
    const dashboard = await main.api.invoke('usage.dashboard', { days: 7 });
    expect(dashboard.tokens).toBe(152);
  });

  it('takes no run of its own from an update that says nothing, such as usage after the prompt', async () => {
    const usage = { update: { sessionUpdate: 'usage_update', used: 1000, size: 128000, cost: { amount: 0, currency: 'USD' } } };
    const title = { update: { sessionUpdate: 'session_info_update', title: 'Login bug' } };
    const { machine, main, id } = await started({ turns: [{ chunks: ['Done.'], after: [{ hold: 'late' }, usage, title] }] });
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
    machine.release('late');
    await waitFor(main.api, 'sessions', session(id, (s) => s.context?.used === 1000));
    await settle();
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'waiting', waitingReason: 'finished' });
    expect(main.notifications).toHaveLength(1);
  });

  it('never goes stuck while only its Subagents work, however long they say nothing', async () => {
    const { main, id } = await started({ turns: [{ chunks: [...startsSubagent('call_sub', 'ses_child1', EXPLORE), 'Waiting on it.'], after: [{ hold: 'never' }] }] });
    await waitFor(main.api, 'sessions', session(id, (s) => s.subagentsOnly === true));
    await main.elapse(60 * 60_000);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'working', subagentsOnly: true });
  });
});
