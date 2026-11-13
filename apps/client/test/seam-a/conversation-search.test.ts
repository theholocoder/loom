import { describe, expect, it } from 'vitest';
import { startMain, tempMachine, waitFor, type AcpTurn } from './harness';
import type { EnvironmentStatus } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

/** Main with a Project, and a Session on it per prompt, Waiting as finished, the agent having answered each with `turns`. */
async function twoSessions(prompts: [string, string], turns: AcpTurn[] = [{ chunks: ['Ok.'] }]) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  const checkout = machine.gitRepo('billing-api');
  const main = await startMain({ machine });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const ids: number[] = [];
  for (const prompt of prompts) {
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt });
    await waitFor(main.api, 'sessions', (sessions) => sessions.find((s) => s.id === id)?.status === 'waiting');
    ids.push(id);
  }
  return { main, ids: ids as [number, number] };
}

describe('searching conversations', () => {
  it('finds the Sessions whose messages hold the words, saying which words each holds and where', async () => {
    const { main, ids } = await twoSessions(['Why does the invoice export time out?', 'Add a dark mode to the INVOICE page'], [{ chunks: ['The PDF renderer ', 'blocks on fonts.'] }]);

    expect(await main.api.invoke('sessions.searchConversations', { words: ['dark', 'fonts'] })).toEqual([
      { id: ids[0], words: ['fonts'], excerpt: 'The PDF renderer blocks on fonts.' },
      // The first message holding the most of them.
      { id: ids[1], words: ['dark', 'fonts'], excerpt: 'Add a dark mode to the INVOICE page' },
    ]);
    expect(await main.api.invoke('sessions.searchConversations', { words: ['invoice'] })).toEqual([
      { id: ids[0], words: ['invoice'], excerpt: 'Why does the invoice export time out?' },
      { id: ids[1], words: ['invoice'], excerpt: 'Add a dark mode to the INVOICE page' },
    ]);
    expect(await main.api.invoke('sessions.searchConversations', { words: ['nowhere'] })).toEqual([]);
    expect(await main.api.invoke('sessions.searchConversations', { words: [] })).toEqual([]);
  });

  it('takes the words as text, not patterns, and leaves out what the messages are stored with', async () => {
    const { main, ids } = await twoSessions(['Coverage is at 100% now', 'Rename snake_case keys']);

    expect((await main.api.invoke('sessions.searchConversations', { words: ['100%'] })).map((m) => m.id)).toEqual([ids[0]]);
    expect((await main.api.invoke('sessions.searchConversations', { words: ['e_c'] })).map((m) => m.id)).toEqual([ids[1]]);
    expect(await main.api.invoke('sessions.searchConversations', { words: ['%'] })).toHaveLength(1);
    expect(await main.api.invoke('sessions.searchConversations', { words: ['_'] })).toHaveLength(1);
    // The fields each message is stored with are not what was said.
    expect(await main.api.invoke('sessions.searchConversations', { words: ['streaming'] })).toEqual([]);
  });

  it('folds the case of any letter, not only ASCII ones', async () => {
    const { main, ids } = await twoSessions(['Été comme hiver', 'Other']);
    expect((await main.api.invoke('sessions.searchConversations', { words: ['été'] })).map((m) => m.id)).toEqual([ids[0]]);
  });

  it('cuts a long message down to the words found, around the first of them', async () => {
    const long = `${'lorem '.repeat(60)}the needle sits here ${'ipsum '.repeat(60)}`;
    const { main, ids } = await twoSessions([long, 'Other']);

    const [match] = await main.api.invoke('sessions.searchConversations', { words: ['needle'] });
    expect(match!.id).toBe(ids[0]);
    expect(match!.excerpt).toContain('the needle sits here');
    expect(match!.excerpt.length).toBeLessThan(140);
    expect(match!.excerpt.startsWith('…')).toBe(true);
    expect(match!.excerpt.endsWith('…')).toBe(true);
  });
});
