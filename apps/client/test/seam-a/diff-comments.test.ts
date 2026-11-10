import { describe, expect, it } from 'vitest';
import { startMain, tempMachine, waitFor, type AcpTurn } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

async function waitingSession(turns: AcpTurn[]) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  const checkout = machine.gitRepo('billing-api');
  const main = await startMain({ machine });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix login' });
  await waitFor(main.api, 'sessions', waiting(id));
  return { machine, main, id };
}

const waiting = (id: number) => (sessions: Session[]) => sessions.find((s) => s.id === id)?.status === 'waiting';

/** The text of every `session/prompt` the agent was sent, in order. */
const promptTexts = (machine: ReturnType<typeof tempMachine>) =>
  machine
    .acpMessages()
    .filter((m) => m.message.method === 'session/prompt')
    .map((m) => (m.message.params!.prompt as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text).join(''));

const comments = [
  { path: 'src/auth/login.ts', start: 2, end: 3, lines: ['-old line', '+new line'], note: 'Keep the old name.' },
  { path: 'README.md', start: 7, end: 7, lines: [' Run it with `pnpm dev`.'], note: 'Say which Node version.' },
];

const blocks = [
  'Comment on `src/auth/login.ts:2-3`:',
  '',
  '```diff',
  '-old line',
  '+new line',
  '```',
  '',
  'Keep the old name.',
  '',
  'Comment on `README.md:7`:',
  '',
  '```diff',
  ' Run it with `pnpm dev`.',
  '```',
  '',
  'Say which Node version.',
].join('\n');

describe('diff comments sent with a prompt', () => {
  it('go to the agent and into the transcript as blocks after the text: path, range, quoted lines and note', async () => {
    const { machine, main, id } = await waitingSession([{ chunks: ['On it.'] }, { chunks: ['Done.'] }]);

    await main.api.invoke('sessions.send', { id, prompt: 'A few things:', comments });

    await waitFor(main.api, 'sessions', (sessions) => waiting(id)(sessions) && promptTexts(machine).length === 2);
    expect(promptTexts(machine)[1]).toBe(`A few things:\n\n${blocks}`);
    const items = await waitFor(main.api, 'transcript', (list) => list.length === 4, { sessionId: id });
    expect(items[2]).toEqual({ kind: 'user', id: 2, text: `A few things:\n\n${blocks}` });
  });

  it('can be the whole prompt', async () => {
    const { machine, main, id } = await waitingSession([{ chunks: ['On it.'] }, { chunks: ['Done.'] }]);

    await main.api.invoke('sessions.send', { id, prompt: ' ', comments });

    await waitFor(main.api, 'sessions', (sessions) => waiting(id)(sessions) && promptTexts(machine).length === 2);
    expect(promptTexts(machine)[1]).toBe(blocks);
  });

  it('fences quoted lines that hold a fence themselves with a longer one', async () => {
    const { machine, main, id } = await waitingSession([{ chunks: ['On it.'] }, { chunks: ['Done.'] }]);

    await main.api.invoke('sessions.send', { id, prompt: '', comments: [{ path: 'docs/a.md', start: 1, end: 1, lines: ['+```ts'], note: 'Name the language.' }] });

    await waitFor(main.api, 'sessions', (sessions) => waiting(id)(sessions) && promptTexts(machine).length === 2);
    expect(promptTexts(machine)[1]).toBe('Comment on `docs/a.md:1`:\n\n````diff\n+```ts\n````\n\nName the language.');
  });

  it('turns down a comment with no note', async () => {
    const { main, id } = await waitingSession([{ chunks: ['On it.'] }]);
    await expect(main.api.invoke('sessions.send', { id, prompt: 'Look', comments: [{ ...comments[0]!, note: '  ' }] })).rejects.toThrow('A diff comment needs a note.');
  });
});
