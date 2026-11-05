// A Session's agent process: started when it's needed, stopped once the
// Session has waited 10 minutes with nothing in flight, and its conversation
// resumed when it's needed again.
import { describe, expect, it } from 'vitest';
import { processEnded, startMain, tempDir, tempMachine, waitFor, type AcpTurn, type Machine, type OpencodeScript } from './harness';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';
import { CONTINUE_PROMPT, IDLE_STOP_MS } from '../../src/main/sessions/sessions';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

const models = [
  { providerID: 'opencode', id: 'pulse-free', name: 'Pulse Free' },
  { providerID: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
];

function machineWith(acp: OpencodeScript['acp']): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, models, acp });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

async function withProject(machine: Machine, checkout: string, userDataDir?: string) {
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};
const waiting = (reason: string) => (s: Session) => s.status === 'waiting' && s.waitingReason === reason;

/** The pids of the agent processes that have been sent anything, in order. */
function agentPids(machine: Machine): number[] {
  return [...new Set(machine.acpMessages().map((m) => m.pid))];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The ACP methods the agents were sent, leaving out notifications and responses. */
function methods(machine: Machine): string[] {
  return machine.acpMessages().flatMap((m) => (m.message.method && m.message.id !== undefined ? [m.message.method] : []));
}

const texts = (items: TranscriptItem[]) => items.map((i) => [i.kind, 'text' in i ? i.text : 'by' in i ? i.by : '']);

/** A finished checkout Session, its agent still running. */
async function finishedSession(acp: OpencodeScript['acp'], userDataDir?: string) {
  const { machine, checkout } = machineWith(acp);
  const { main, project } = await withProject(machine, checkout, userDataDir);
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
  await waitFor(main.api, 'sessions', session(id, waiting('finished')));
  return { machine, checkout, main, project, id };
}

describe("a Session's agent process", () => {
  it('is stopped once the Session has been Waiting for 10 minutes, and not before', async () => {
    const { machine, main } = await finishedSession({ turns: [{ chunks: ['Done.'] }] });
    const [pid] = agentPids(machine);

    await main.elapse(IDLE_STOP_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid!)).toBe(true);

    await main.elapse(1);
    await processEnded(pid!);
  });

  it('stays Waiting when it is stopped, and resumes its conversation with session/resume for the next prompt', async () => {
    const { machine, checkout, main, id } = await finishedSession({ turns: [{ chunks: ['Done.'] }], resumedTurns: [{ chunks: ['Picked up again.'] }] });
    const [first] = agentPids(machine);
    const { agentSessionId } = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    await main.elapse(IDLE_STOP_MS);
    await processEnded(first!);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'waiting', waitingReason: 'finished' });

    await main.api.invoke('sessions.send', { id, prompt: 'Second' });

    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
    const second = machine.acpMessages().filter((m) => m.pid !== first);
    expect(second.find((m) => m.message.method === 'session/resume')?.message.params).toEqual({ sessionId: agentSessionId, cwd: checkout, mcpServers: expect.any(Array) });
    expect(second.some((m) => m.message.method === 'session/new')).toBe(false);
    expect(second.find((m) => m.message.method === 'session/prompt')?.message.params?.sessionId).toBe(agentSessionId);
    expect(texts(await waitFor(main.api, 'transcript', (items) => items.length === 4, { sessionId: id }))).toEqual([
      ['user', 'First'],
      ['agent', 'Done.'],
      ['user', 'Second'],
      ['agent', 'Picked up again.'],
    ]);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)!.agentSessionId).toBe(agentSessionId);
  });

  it("falls back to session/load when session/resume is turned down, leaving out the history it replays", async () => {
    const { machine, main, id } = await finishedSession({ turns: [{ chunks: ['Done.'] }], resumedTurns: [{ chunks: ['Loaded.'] }], refuse: ['session/resume'] });
    const [first] = agentPids(machine);
    const { agentSessionId } = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    await main.elapse(IDLE_STOP_MS);
    await processEnded(first!);

    await main.api.invoke('sessions.send', { id, prompt: 'Second' });

    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
    const second = machine.acpMessages().filter((m) => m.pid !== first);
    expect(second.flatMap((m) => (m.message.id !== undefined && m.message.method ? [m.message.method] : []))).toEqual(['initialize', 'session/resume', 'session/load', 'session/prompt']);
    expect(second.find((m) => m.message.method === 'session/load')?.message.params?.sessionId).toBe(agentSessionId);
    expect(texts(await waitFor(main.api, 'transcript', (items) => items.length === 4, { sessionId: id }))).toEqual([
      ['user', 'First'],
      ['agent', 'Done.'],
      ['user', 'Second'],
      ['agent', 'Loaded.'],
    ]);
  });

  it('waits on an error when the agent can neither resume nor load its conversation, and starts a new one with the next prompt', async () => {
    const { machine, main, id } = await finishedSession({ turns: [{ chunks: ['Done.'] }], refuse: ['session/resume', 'session/load'] });
    await main.elapse(IDLE_STOP_MS);
    await processEnded(agentPids(machine)[0]!);

    await main.api.invoke('sessions.send', { id, prompt: 'Second' });

    const failed = (await waitFor(main.api, 'sessions', session(id, waiting('error')))).find((s) => s.id === id)!;
    expect(failed.error).toMatch(/^OpenCode could not resume this Session's conversation: .*session not found.*The next prompt starts a new conversation\.$/);
    expect(methods(machine).filter((m) => m === 'session/prompt')).toHaveLength(1);

    await main.api.invoke('sessions.send', { id, prompt: 'Third' });

    const fresh = (await waitFor(main.api, 'sessions', session(id, waiting('finished')))).find((s) => s.id === id)!;
    expect(methods(machine).slice(-3)).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(fresh.agentSessionId).toMatch(/^ses_/);
    expect(fresh.agentSessionId).not.toBe(failed.agentSessionId);
  });

  it('starts its 10 minutes again when the model changes', async () => {
    const { machine, main, id } = await finishedSession({ turns: [{ chunks: ['Done.'] }] });
    const [pid] = agentPids(machine);

    await main.elapse(IDLE_STOP_MS / 2);
    await main.api.invoke('sessions.setModel', { id, model: 'anthropic/claude-sonnet-5-5' });
    await main.elapse(IDLE_STOP_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid!)).toBe(true);

    await main.elapse(1);
    await processEnded(pid!);
  });

  it('is never stopped while the Session is Working', async () => {
    const { machine, checkout } = machineWith({ turns: [{ chunks: ['Busy'], hold: 'long' }] });
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    await main.elapse(2 * IDLE_STOP_MS);

    expect((await main.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'working' });
    expect(alive(agentPids(machine)[0]!)).toBe(true);
    machine.release('long');
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));
  });

  it('is not stopped while the agent waits on a question, and is once the Session has waited 10 minutes after it', async () => {
    const question = { message: 'Which one?', requestedSchema: { type: 'object', properties: { pick: { type: 'string', title: 'Pick' } } } };
    const { machine, checkout } = machineWith({ turns: [{ chunks: [{ elicit: question }, 'Thanks.'] }] });
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'sessions', session(id, waiting('question')));
    const [pid] = agentPids(machine);

    await main.elapse(2 * IDLE_STOP_MS);
    expect(alive(pid!)).toBe(true);
    const items = await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'question'), { sessionId: id });
    await main.api.invoke('sessions.answer', { id, itemId: items.find((i) => i.kind === 'question')!.id, answer: { pick: 'this' } });
    await waitFor(main.api, 'sessions', session(id, waiting('finished')));

    await main.elapse(IDLE_STOP_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid!)).toBe(true);
    await main.elapse(1);
    await processEnded(pid!);
  });
});

describe('a run in flight when Loom quit', () => {
  it('comes back Waiting as interrupted, starting nothing, and Continue resumes the conversation and has the agent go on', async () => {
    const { machine, checkout } = machineWith({ turns: [{ chunks: ['Halfway'], hold: 'never' }], resumedTurns: [{ chunks: ['Carrying on.'] }] });
    const userDataDir = tempDir('loom-lifetime-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    const { agentSessionId } = (await main.api.invoke('sessions.list')).find((s) => s.id === id)!;
    await main.close();

    const again = await startMain({ machine, userDataDir });
    await waitFor(again.api, 'environments', ready);

    expect((await again.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'waiting', waitingReason: 'interrupted' });
    expect(texts(await waitFor(again.api, 'transcript', (items) => items.length > 0, { sessionId: id }))).toEqual([
      ['user', 'Go'],
      ['agent', 'Halfway'],
      ['interruption', 'quit'],
    ]);
    expect(agentPids(machine)).toHaveLength(1);

    await again.api.invoke('sessions.continue', { id });

    await waitFor(again.api, 'sessions', session(id, waiting('finished')));
    const resumed = machine.acpMessages().filter((m) => m.pid !== agentPids(machine)[0]);
    expect(resumed.find((m) => m.message.method === 'session/resume')?.message.params?.sessionId).toBe(agentSessionId);
    expect(resumed.find((m) => m.message.method === 'session/prompt')?.message.params?.prompt).toEqual([{ type: 'text', text: CONTINUE_PROMPT }]);
    expect(texts(await waitFor(again.api, 'transcript', (items) => items.length === 5, { sessionId: id }))).toEqual([
      ['user', 'Go'],
      ['agent', 'Halfway'],
      ['interruption', 'quit'],
      ['user', CONTINUE_PROMPT],
      ['agent', 'Carrying on.'],
    ]);
  });

  it('is the only thing Continue takes up', async () => {
    const { main, id } = await finishedSession({ turns: [{ chunks: ['Done.'] }] });

    await expect(main.api.invoke('sessions.continue', { id })).rejects.toThrow(/nothing to continue/i);
  });
});
