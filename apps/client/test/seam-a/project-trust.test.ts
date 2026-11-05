// No ACP agent asks to trust a Project's local files yet (OpenCode 2.1.4
// doesn't), so these drive the Session service with an agent that does.
import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentSession, OpenOptions } from '../../src/main/agents/adapter';
import type { Session, TranscriptItem } from '../../src/shared/api';
import { startMain, tempDir, tempMachine, waitFor, type Machine } from './harness';

/** An agent that, on each prompt, asks whether to trust the Project's files, then replies once answered. */
class TrustAskingAgent implements AgentAdapter {
  readonly name = 'OpenCode';
  /** What each of its sessions was told, in order. */
  readonly answers: boolean[] = [];
  private opened = 0;

  async open({ onEvent }: OpenOptions): Promise<AgentSession> {
    const id = `ses_trust${++this.opened}`;
    const waiting = new Map<string, () => void>();
    let asks = 0;
    const emit = (event: AgentEvent) => onEvent(event);
    return {
      id,
      configure: async () => {},
      prompt: () => {
        emit({ type: 'run-started' });
        const requestId = `trust-${++asks}`;
        waiting.set(requestId, () => {
          emit({ type: 'text-delta', text: 'Thanks.' });
          emit({ type: 'run-settled' });
        });
        emit({ type: 'trust-asked', requestId, message: 'Trust the plugins in .opencode/?' });
      },
      answer: (requestId, response) => {
        const resume = waiting.get(requestId);
        if (!resume || response.kind !== 'trust') return;
        waiting.delete(requestId);
        this.answers.push(response.trusted);
        // The run goes on after the answer, as an agent's would.
        setTimeout(resume, 0);
      },
      cancel: () => {},
      close: async () => {},
    };
  }
}

const finished = (id: number) => (sessions: Session[]) => sessions.some((s) => s.id === id && s.status === 'waiting' && s.waitingReason === 'finished');
const asking = (id: number) => (sessions: Session[]) => sessions.some((s) => s.id === id && s.status === 'waiting' && s.waitingReason === 'question');
const trustCard = (items: TranscriptItem[]) => items.find((i): i is Extract<TranscriptItem, { kind: 'trust' }> => i.kind === 'trust');

async function started(machine: Machine, agent: AgentAdapter, userDataDir: string) {
  const main = await startMain({ machine, userDataDir, adapter: agent });
  await waitFor(main.api, 'environments', (envs) => envs.some((e) => e.state === 'connected'));
  return main;
}

describe("trusting a Project's local files", () => {
  it('asks once per Project, answers every Session of it waiting on that, and remembers the answer', async () => {
    const machine = tempMachine();
    const userDataDir = tempDir('loom-trust-');
    const agent = new TrustAskingAgent();
    const main = await started(machine, agent, userDataDir);
    const billing = await main.api.invoke('projects.link', { path: machine.gitRepo('billing-api') });
    const create = (projectId: number) => main.api.invoke('sessions.create', { projectId, workingCopy: 'checkout', prompt: 'Fix the tests' });

    // Two Sessions of the Project ask at once: both show the card.
    const first = await create(billing.id);
    const second = await create(billing.id);
    await waitFor(main.api, 'sessions', asking(first.id));
    await waitFor(main.api, 'sessions', asking(second.id));
    const card = trustCard(await waitFor(main.api, 'transcript', (list) => !!trustCard(list), { sessionId: first.id }))!;
    expect(card).toEqual({ kind: 'trust', id: 1, message: 'Trust the plugins in .opencode/?', state: 'asked' });

    // Answering one answers both, and the Sessions go on.
    await main.api.invoke('sessions.trust', { id: first.id, itemId: card.id, trusted: true });
    await waitFor(main.api, 'sessions', finished(first.id));
    await waitFor(main.api, 'sessions', finished(second.id));
    expect(agent.answers).toEqual([true, true]);
    for (const id of [first.id, second.id]) {
      const items = await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'agent'), { sessionId: id });
      expect(trustCard(items)?.state).toBe('trusted');
    }
    await expect(main.api.invoke('sessions.trust', { id: first.id, itemId: card.id, trusted: false })).rejects.toThrow('no longer asking');

    // Later Sessions of the Project aren't asked, even after a restart.
    const third = await create(billing.id);
    await waitFor(main.api, 'sessions', finished(third.id));
    await main.close();
    const again = await started(machine, agent, userDataDir);
    const fourth = await again.api.invoke('sessions.create', { projectId: billing.id, workingCopy: 'checkout', prompt: 'Fix the tests' });
    await waitFor(again.api, 'sessions', finished(fourth.id));
    for (const id of [third.id, fourth.id]) {
      const items = await waitFor(again.api, 'transcript', (list) => list.some((i) => i.kind === 'agent'), { sessionId: id });
      expect(trustCard(items)).toBeUndefined();
    }
    expect(agent.answers).toEqual([true, true, true, true]);

    // Another Project is asked on its own, and keeps a refusal as well.
    const shop = await again.api.invoke('projects.link', { path: machine.gitRepo('shop') });
    const other = await again.api.invoke('sessions.create', { projectId: shop.id, workingCopy: 'checkout', prompt: 'Fix the tests' });
    await waitFor(again.api, 'sessions', asking(other.id));
    const asked = trustCard(await waitFor(again.api, 'transcript', (list) => !!trustCard(list), { sessionId: other.id }))!;
    await again.api.invoke('sessions.trust', { id: other.id, itemId: asked.id, trusted: false });
    await waitFor(again.api, 'sessions', finished(other.id));
    const last = await again.api.invoke('sessions.create', { projectId: shop.id, workingCopy: 'checkout', prompt: 'Fix the tests' });
    await waitFor(again.api, 'sessions', finished(last.id));
    expect(agent.answers).toEqual([true, true, true, true, false, false]);
  });

  it('keeps the first answer when two Sessions of a Project are answered at once', async () => {
    const machine = tempMachine();
    const agent = new TrustAskingAgent();
    const main = await started(machine, agent, tempDir('loom-trust-'));
    const project = await main.api.invoke('projects.link', { path: machine.gitRepo('billing-api') });
    const create = () => main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the tests' });
    const sessions = [await create(), await create()];
    const cards = [];
    for (const { id } of sessions) {
      await waitFor(main.api, 'sessions', asking(id));
      cards.push(trustCard(await waitFor(main.api, 'transcript', (list) => !!trustCard(list), { sessionId: id }))!);
    }

    const [first, second] = await Promise.allSettled([
      main.api.invoke('sessions.trust', { id: sessions[0]!.id, itemId: cards[0]!.id, trusted: true }),
      main.api.invoke('sessions.trust', { id: sessions[1]!.id, itemId: cards[1]!.id, trusted: false }),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { message: 'The agent is no longer asking this.' } });
    const later = await create();
    await waitFor(main.api, 'sessions', finished(later.id));
    expect(agent.answers).toEqual([true, true, true]);
  });
});
