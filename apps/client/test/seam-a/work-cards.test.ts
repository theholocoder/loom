import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_CAP } from '../../src/main/sessions/tool-output';
import { startMain, tempDir, tempMachine, waitFor, type AcpTurn, type Machine } from './harness';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

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

const waiting = (id: number) => (sessions: Session[]) => sessions.some((s) => s.id === id && s.status === 'waiting');

const thought = (text: string) => ({ update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } });
const tool = (sessionUpdate: 'tool_call' | 'tool_call_update', fields: Record<string, unknown>) => ({ update: { sessionUpdate, ...fields } });
const text = (value: string) => [{ type: 'content', content: { type: 'text', text: value } }];

/** Runs one Session through `turns`' first turn until it is Waiting; main is closed, its database kept. */
async function ranThrough(turns: AcpTurn[]) {
  const { machine, checkout } = machineWith(turns);
  const userDataDir = tempDir('loom-work-');
  const main = await started(machine, userDataDir);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the tests' });
  await waitFor(main.api, 'sessions', waiting(id));
  const live = await waitFor(main.api, 'transcript', () => true, { sessionId: id });
  await main.close();
  return { machine, checkout, userDataDir, id, live };
}

async function replayed(machine: Machine, userDataDir: string, id: number): Promise<TranscriptItem[]> {
  const again = await started(machine, userDataDir);
  const items = await waitFor(again.api, 'transcript', (list) => list.length > 0, { sessionId: id });
  await again.close();
  return items;
}

describe("how a Session's agent worked", () => {
  it('shows thinking apart from the reply, and each tool call as one card kept up to date, after a restart too', async () => {
    const { machine, userDataDir, id, live } = await ranThrough([
      {
        chunks: [
          thought('The tests fail '),
          thought('on a typo.'),
          'Let me look.',
          tool('tool_call', { toolCallId: 'call_1', title: 'Read src/app.ts', kind: 'read', status: 'pending', rawInput: { filePath: 'src/app.ts' } }),
          tool('tool_call', { toolCallId: 'call_2', title: 'bash', kind: 'execute', status: 'in_progress' }),
          tool('tool_call_update', { toolCallId: 'call_1', status: 'completed', content: text('export const app = 1;'), someFutureField: true }),
          tool('tool_call_update', { toolCallId: 'call_2', status: 'failed', rawOutput: { output: 'command not found: pnpx', metadata: { exit: 127 } } }),
          tool('tool_call', { toolCallId: 'call_3', status: 'completed', content: [{ type: 'diff', path: 'src/app.ts', oldText: 'a', newText: 'b' }] }),
          { update: { sessionUpdate: 'plan', entries: [] } },
          'Fixed.',
        ],
      },
    ]);

    const expected = [
      { kind: 'user', id: 0, text: 'Fix the tests' },
      { kind: 'thinking', id: 1, text: 'The tests fail on a typo.', streaming: false },
      { kind: 'agent', id: 2, text: 'Let me look.', streaming: false },
      { kind: 'tool', id: 3, toolCallId: 'call_1', title: 'Read src/app.ts', toolKind: 'read', status: 'completed', input: '{\n  "filePath": "src/app.ts"\n}', output: 'export const app = 1;' },
      { kind: 'tool', id: 4, toolCallId: 'call_2', title: 'bash', toolKind: 'execute', status: 'failed', output: 'command not found: pnpx' },
      { kind: 'tool', id: 5, toolCallId: 'call_3', title: 'Tool call', status: 'completed', output: '[diff of src/app.ts]' },
      { kind: 'agent', id: 6, text: 'Fixed.', streaming: false },
    ];
    expect(live).toEqual(expected);
    expect(await replayed(machine, userDataDir, id)).toEqual(expected);
  });

  it('stores a huge tool output capped at 256 KB, keeping its head and tail around a marker', async () => {
    const bytes = 3 * 1024 * 1024;
    const { machine, userDataDir, id, live } = await ranThrough([
      { chunks: [tool('tool_call', { toolCallId: 'call_big', title: 'cat big.log', kind: 'read', status: 'in_progress' }), { bigOutput: { toolCallId: 'call_big', bytes } }] },
    ]);

    const db = new Database(join(userDataDir, 'loom.db'), { readonly: true });
    const row = db.prepare("SELECT data FROM events WHERE session_id = ? AND kind = 'tool'").get(id) as { data: string };
    db.close();
    const stored = JSON.parse(row.data) as { output: string; truncated: boolean; status: string };
    for (const card of [stored, live.find((i) => i.kind === 'tool')!, (await replayed(machine, userDataDir, id)).find((i) => i.kind === 'tool')!]) {
      expect(card).toMatchObject({ status: 'completed', truncated: true });
      const output = (card as { output: string }).output;
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(TOOL_OUTPUT_CAP);
      expect(output.startsWith('HEAD>xxx')).toBe(true);
      expect(output.endsWith('xxx<TAIL')).toBe(true);
      expect(output).toMatch(/\n… \d+ bytes truncated …\n/);
    }
  });

  it('ends the thinking and fails the tool calls still running when the run fails', async () => {
    const { live } = await ranThrough([
      { chunks: [tool('tool_call', { toolCallId: 'call_1', title: 'webfetch', status: 'in_progress' }), thought('Still waiting')], error: 'provider overloaded' },
    ]);

    expect(live.slice(1)).toEqual([
      { kind: 'tool', id: 1, toolCallId: 'call_1', title: 'webfetch', status: 'failed' },
      { kind: 'thinking', id: 2, text: 'Still waiting', streaming: false },
      { kind: 'error', id: 3, message: 'provider overloaded' },
    ]);
  });

  it("leaves the user's own OpenCode setup to OpenCode: no tools added, nothing but `acp`, in the working copy", async () => {
    const { machine, checkout } = await ranThrough([{ chunks: ['Done.'] }]);

    expect(machine.opencodeInvocations().filter((argv) => argv[0] === 'acp')).toEqual([['acp']]);
    const created = machine.acpMessages().filter((m) => m.message.method === 'session/new');
    expect(created.map((m) => [m.cwd, m.message.params])).toEqual([[checkout, { cwd: checkout, mcpServers: [] }]]);
  });
});
