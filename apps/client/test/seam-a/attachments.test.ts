import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type AcpTurn, type Machine } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

function machineWith(turns: AcpTurn[], acp: { images?: boolean } = {}): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns, ...acp } });
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

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** The content blocks of every `session/prompt` the agent was sent, in order. */
function prompts(machine: Machine): Array<Array<Record<string, unknown>>> {
  return machine
    .acpMessages()
    .filter((m) => m.message.method === 'session/prompt')
    .map((m) => m.message.params!.prompt as Array<Record<string, unknown>>);
}

describe('attachments', () => {
  it('stores a file attached to the first prompt by content hash, and links the agent to a copy in its Environment', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Read it.'] }]);
    const userDataDir = tempDir('loom-attachments-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const content = 'timeout: 30s\n';

    const { id } = await main.api.invoke('sessions.create', {
      projectId: project.id,
      workingCopy: 'checkout',
      prompt: 'Why does this time out?',
      attachments: [{ name: 'config.yaml', data: bytes(content) }],
    });

    const items = await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'agent'), { sessionId: id });
    const attachment = { name: 'config.yaml', mimeType: 'application/yaml', size: content.length, hash: sha256(content) };
    expect(items[0]).toEqual({ kind: 'user', id: 0, text: 'Why does this time out?', attachments: [attachment] });
    expect(readFileSync(join(userDataDir, 'attachments', String(id), `${attachment.hash}.yaml`), 'utf8')).toBe(content);

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    const [prompt] = prompts(machine);
    expect(prompt).toEqual([
      { type: 'text', text: 'Why does this time out?' },
      { type: 'resource_link', name: 'config.yaml', uri: expect.stringMatching(/^file:\/\//), mimeType: 'application/yaml', size: content.length },
    ]);
    // The agent reads the copy in its own Environment, under its real name.
    const copy = fileURLToPath(prompt![1]!.uri as string);
    expect(copy.endsWith('/config.yaml')).toBe(true);
    expect(readFileSync(copy, 'utf8')).toBe(content);
  });

  it('sends an image inline to an agent that takes images, naming its copy in the Environment', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['A red dot.'] }], { images: true });
    const { main, project } = await withProject(machine, checkout);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    const { id } = await main.api.invoke('sessions.create', {
      projectId: project.id,
      workingCopy: 'checkout',
      prompt: 'What is this?',
      attachments: [{ name: 'screenshot.png', mimeType: 'image/png', data: png }],
    });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
    const [prompt] = prompts(machine);
    expect(prompt).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64'), uri: expect.stringMatching(/\/screenshot\.png$/) },
    ]);
    expect(new Uint8Array(readFileSync(fileURLToPath(prompt![1]!.uri as string)))).toEqual(png);
  });

  it('takes a reply that is only an attachment', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Send the log.'] }, { chunks: ['Found it.'] }]);
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'It crashes' });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));

    await main.api.invoke('sessions.send', { id, prompt: '  ', attachments: [{ name: 'crash.log', data: bytes('panic\n') }] });

    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && prompts(machine).length === 2));
    expect(prompts(machine)[1]).toEqual([{ type: 'resource_link', name: 'crash.log', uri: expect.any(String), mimeType: 'text/plain', size: 6 }]);
    const items = await waitFor(main.api, 'transcript', (list) => list.length === 4, { sessionId: id });
    expect(items[2]).toEqual({ kind: 'user', id: 2, text: '', attachments: [{ name: 'crash.log', mimeType: 'text/plain', size: 6, hash: sha256('panic\n') }] });
  });

  it('keeps the attachments of a queued message, across a restart, and sends them with it', async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Working on it.'], hold: 'first' }]);
    const userDataDir = tempDir('loom-attachments-');
    const { main, project } = await withProject(machine, checkout, userDataDir);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Refactor billing' });
    await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'agent'), { sessionId: id });
    const attachment = { name: 'design.md', mimeType: 'text/markdown', size: 7, hash: sha256('# Plan\n') };

    await main.api.invoke('sessions.send', { id, prompt: 'Follow this', attachments: [{ name: 'design.md', data: bytes('# Plan\n') }] });

    const queued = await waitFor(main.api, 'sessions', session(id, (s) => !!s.queue));
    expect(queued.find((s) => s.id === id)!.queue).toEqual([{ id: expect.any(Number), text: 'Follow this', attachments: [attachment] }]);
    await main.close();

    const again = await startMain({ machine, userDataDir });
    await waitFor(again.api, 'environments', ready);
    const [restarted] = (await again.api.invoke('sessions.list')).filter((s) => s.id === id);
    expect(restarted!.queue).toEqual([{ id: expect.any(Number), text: 'Follow this', attachments: [attachment] }]);
    expect(readFileSync(join(userDataDir, 'attachments', String(id), `${attachment.hash}.md`), 'utf8')).toBe('# Plan\n');
  });

  it('turns down what it cannot attach', async () => {
    const { machine, checkout } = machineWith([]);
    const { main, project } = await withProject(machine, checkout);
    const create = (attachments: unknown) =>
      main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Look', attachments: attachments as never });

    await expect(create(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, data: bytes('x') })))).rejects.toThrow('at most 10 attachments');
    await expect(create([{ name: 'huge.bin', data: new Uint8Array(10 * 1024 * 1024 + 1) }])).rejects.toThrow('huge.bin is over 10 MB');
    await expect(create([{ name: '', data: bytes('x') }])).rejects.toThrow('needs a file name');
    await expect(create([{ name: 'empty.txt' }])).rejects.toThrow('no content');
    expect(await main.api.invoke('sessions.list')).toEqual([]);
  });
});

describe('@-mentions', () => {
  it("lists the working copy's tracked and untracked files, leaving out what git ignores", async () => {
    const { machine, checkout } = machineWith([{ chunks: ['Done.'] }]);
    mkdirSync(join(checkout, 'src'));
    machine.commit(checkout, 'src/billing.ts', 'export {};\n');
    machine.commit(checkout, '.gitignore', 'dist/\n');
    writeFileSync(join(checkout, 'notes.md'), 'draft\n');
    mkdirSync(join(checkout, 'dist'));
    writeFileSync(join(checkout, 'dist', 'billing.js'), '');
    const { main, project } = await withProject(machine, checkout);
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Hi' });

    const files = await main.api.invoke('sessions.files', { id });

    expect(files).toContain('src/billing.ts');
    expect(files).toContain('notes.md');
    expect(files).toContain('.gitignore');
    expect(files.some((f) => f.startsWith('dist/'))).toBe(false);
    expect(await main.api.invoke('projects.files', { id: project.id })).toEqual(files);
  });
});
