import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type AcpTurn, type Machine } from './harness';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

/** A machine with a ready OpenCode playing `turns`, and a git checkout. */
function machineWith(turns: AcpTurn[]): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

async function started(machine: Machine, userDataDir?: string) {
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  return main;
}

/** Main with a Project on `checkout`. */
async function withProject(machine: Machine, checkout: string, userDataDir?: string) {
  const main = await started(machine, userDataDir);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

const agentText = (items: TranscriptItem[]) =>
  items
    .filter((i) => i.kind === 'agent')
    .map((i) => i.text)
    .join('');

describe('a checkout Session', () => {
  it("streams the agent's reply while Working, then waits as finished", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Hello', ', world'], hold: 'reply' }]);
    const { main, project } = await withProject(machine, checkout);

    const created = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Say hello' });

    expect(created).toMatchObject({ projectId: project.id, title: 'Say hello', agent: 'OpenCode', workingCopy: { kind: 'checkout', path: checkout }, status: 'working' });
    const streaming = await waitFor(main.api, 'transcript', (items) => agentText(items) === 'Hello, world', { sessionId: created.id });
    expect(streaming).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Say hello' },
      { kind: 'agent', id: expect.any(Number), text: 'Hello, world', streaming: true },
    ]);
    expect((await main.api.invoke('sessions.list')).find((s) => s.id === created.id)?.status).toBe('working');

    machine.release('reply');

    await waitFor(main.api, 'sessions', session(created.id, (s) => s.status === 'waiting' && s.waitingReason === 'finished'));
    expect(await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent' && !i.streaming), { sessionId: created.id })).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Say hello' },
      { kind: 'agent', id: expect.any(Number), text: 'Hello, world', streaming: false },
    ]);
  });

  it('waits on an error, showing the provider error, when the run fails', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Let me'], error: 'Insufficient credits: add more at https://example.com/billing' }]);
    const { main, project } = await withProject(machine, checkout);

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix it' });

    const [failed] = (await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'))).filter((s) => s.id === id);
    expect(failed).toMatchObject({ waitingReason: 'error', error: 'Insufficient credits: add more at https://example.com/billing' });
    expect(await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'error'), { sessionId: id })).toEqual([
      { kind: 'user', id: expect.any(Number), text: 'Fix it' },
      { kind: 'agent', id: expect.any(Number), text: 'Let me', streaming: false },
      { kind: 'error', id: expect.any(Number), message: 'Insufficient credits: add more at https://example.com/billing' },
    ]);
  });

  it("runs its own opencode acp in the checkout, and stores the agent's ses_ id", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    const userDataDir = tempDir('loom-sessions-');
    const { main, project } = await withProject(machine, checkout, userDataDir);

    const first = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'One' });
    const second = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Two' });
    const settled = await waitFor(main.api, 'sessions', (list) => [first.id, second.id].every((id) => session(id, (s) => s.status === 'waiting')(list)));

    expect(machine.opencodeInvocations().filter((argv) => argv[0] === 'acp')).toEqual([['acp'], ['acp']]);
    const messages = machine.acpMessages();
    expect(new Set(messages.map((m) => m.pid)).size).toBe(2);
    expect(messages.every((m) => m.cwd === checkout)).toBe(true);
    expect(messages.filter((m) => m.message.method === 'session/new').map((m) => m.message.params?.cwd)).toEqual([checkout, checkout]);
    const ids = [first.id, second.id].map((id) => settled.find((s) => s.id === id)!.agentSessionId);
    for (const [i, prompt] of ['One', 'Two'].entries()) {
      expect(ids[i]).toMatch(/^ses_/);
      const sent = messages.find((m) => m.message.method === 'session/prompt' && m.message.params?.sessionId === ids[i]);
      expect(sent?.message.params?.prompt).toEqual([{ type: 'text', text: prompt }]);
    }

    await main.close();
    const again = await started(machine, userDataDir);
    const kept = await again.api.invoke('sessions.list');
    expect(kept.map((s) => [s.title, s.agentSessionId, s.status, s.waitingReason])).toEqual([
      ['Two', ids[1], 'waiting', 'finished'],
      ['One', ids[0], 'waiting', 'finished'],
    ]);
  });

  it('sends a reply to the same agent conversation, Working again until it settles', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['First answer.'] }, { chunks: ['Second answer.'], hold: 'second' }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'First' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    await main.api.invoke('sessions.send', { id, prompt: 'Second' });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'working' && s.waitingReason === undefined));
    await expect(main.api.invoke('sessions.send', { id, prompt: 'Third' })).rejects.toThrow('The agent is still working on this Session.');
    machine.release('second');
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'finished'));
    expect((await waitFor(main.api, 'transcript', (items) => items.length === 4, { sessionId: id })).map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([
      ['user', 'First'],
      ['agent', 'First answer.'],
      ['user', 'Second'],
      ['agent', 'Second answer.'],
    ]);
    const prompts = machine.acpMessages().filter((m) => m.message.method === 'session/prompt');
    expect(new Set(prompts.map((m) => m.pid)).size).toBe(1);
    expect(new Set(prompts.map((m) => m.message.params?.sessionId)).size).toBe(1);
  });

  it('waits on an error when the agent process exits during a run', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it'], hold: 'never' }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });

    process.kill(machine.acpMessages()[0]!.pid, 'SIGKILL');

    const [failed] = (await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'))).filter((s) => s.id === id);
    expect(failed).toMatchObject({ waitingReason: 'error' });
    // Killed on Linux; on Windows, the stand-in's .cmd shim exits with a code.
    expect(failed!.error).toMatch(/^the agent (was killed|exited with code \d+)$/);
  });

  it('waits on an error when OpenCode is not installed', async () => {
    const machine = tempMachine();
    const checkout = machine.gitRepo('billing-api');
    const main = await startMain({ machine });
    await waitFor(main.api, 'environments', (envs) => envs[0]?.agent?.state === 'missing');
    const project = await main.api.invoke('projects.link', { path: checkout });

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });

    const [failed] = (await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'))).filter((s) => s.id === id);
    expect(failed).toMatchObject({ waitingReason: 'error', error: "OpenCode isn't installed in Native, or isn't on your shell's PATH." });
  });

  it('is Waiting as interrupted when main starts again after quitting during a run', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Halfway'], hold: 'never' }]);
    const userDataDir = tempDir('loom-sessions-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Go' });
    await waitFor(main.api, 'transcript', (items) => items.some((i) => i.kind === 'agent'), { sessionId: id });
    await main.close();

    const again = await started(machine, userDataDir);

    expect((await again.api.invoke('sessions.list')).find((s) => s.id === id)).toMatchObject({ status: 'waiting', waitingReason: 'interrupted' });
  });
});
