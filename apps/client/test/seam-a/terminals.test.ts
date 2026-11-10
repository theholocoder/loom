import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { startMain, tempMachine, waitFor, type MainHarness } from './harness';
import type { EnvironmentStatus, LoomApi, Session, TerminalInfo } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

/** Main with a Waiting checkout Session on a fresh git checkout. */
async function withSession(): Promise<{ main: MainHarness; checkout: string; id: number }> {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done'] }] } });
  const checkout = machine.gitRepo('billing-api');
  const main = await startMain({ machine });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix it' });
  await waitFor(main.api, 'sessions', (list: Session[]) => list.some((s) => s.id === id && s.status === 'waiting'));
  return { main, checkout, id };
}

/**
 * Reads a terminal's output as the renderer does, acknowledging each piece,
 * until it contains `want`; resolves with all of it.
 */
function outputUntil(api: LoomApi, id: number, want: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`terminal ${id} printed ${JSON.stringify(text)}, still waiting for ${JSON.stringify(want)}`));
    }, 5000);
    let done = false;
    const unsubscribe = api.subscribe(
      'terminalOutput',
      ({ data, replay }) => {
        text += decoder.decode(data, { stream: true });
        if (data.length && !replay) void api.invoke('terminals.ack', { id, bytes: data.length }).catch(() => {});
        if (done || !text.includes(want)) return;
        done = true;
        clearTimeout(timer);
        queueMicrotask(() => unsubscribe());
        resolve(text);
      },
      { id },
    );
  });
}

describe.skipIf(process.platform === 'win32')('terminals in the dock', () => {
  it("opens a shell in the Session's working copy, which takes what is typed", async () => {
    const { main, checkout, id } = await withSession();

    const terminal = await main.api.invoke('terminals.open', { sessionId: id, cols: 80, rows: 24 });
    expect(terminal).toMatchObject({ sessionId: id, title: 'Terminal 1' });
    await main.api.invoke('terminals.write', { id: terminal.id, data: 'echo "[$PWD|$TERM]"\r' });

    await outputUntil(main.api, terminal.id, `[${checkout}|xterm-256color]`);
  });

  it("lists each Session's terminals, numbered, and drops one once closed or exited", async () => {
    const { main, id } = await withSession();

    const first = await main.api.invoke('terminals.open', { sessionId: id, cols: 80, rows: 24 });
    const second = await main.api.invoke('terminals.open', { sessionId: id, cols: 80, rows: 24 });
    const titles = (list: TerminalInfo[]) => list.map((t) => t.title).join(',');
    expect(titles(await waitFor(main.api, 'terminals', (list) => list.length === 2, { sessionId: id }))).toBe('Terminal 1,Terminal 2');

    await main.api.invoke('terminals.close', { id: first.id });
    expect(titles(await waitFor(main.api, 'terminals', (list) => list.length === 1, { sessionId: id }))).toBe('Terminal 2');

    await main.api.invoke('terminals.write', { id: second.id, data: 'exit\r' });
    await waitFor(main.api, 'terminals', (list) => list.length === 0, { sessionId: id });
  });

  it('replays what a terminal printed before anyone listened', async () => {
    const { main, id } = await withSession();
    const terminal = await main.api.invoke('terminals.open', { sessionId: id, cols: 80, rows: 24 });
    await main.api.invoke('terminals.write', { id: terminal.id, data: 'echo "early $((6*7))"\r' });
    await outputUntil(main.api, terminal.id, 'early 42');

    // A second listener, as after a renderer reload, gets it all again, marked as a replay.
    await outputUntil(main.api, terminal.id, 'early 42');
    const replayed = await new Promise<boolean | undefined>((resolve) => {
      const stop = main.api.subscribe('terminalOutput', ({ replay }) => {
        queueMicrotask(() => stop());
        resolve(replay);
      }, { id: terminal.id });
    });
    expect(replayed).toBe(true);
  });

  it('holds a flooding shell back until its output is acknowledged', async () => {
    const { main, id } = await withSession();
    const terminal = await main.api.invoke('terminals.open', { sessionId: id, cols: 80, rows: 24 });
    let received = 0;
    const unsubscribe = main.api.subscribe('terminalOutput', ({ data }) => (received += data.length), { id: terminal.id });
    const line = 'x'.repeat(63);
    // About 1.3 MB, all from builtins, then a marker.
    await main.api.invoke('terminals.write', { id: terminal.id, data: `i=0; while [ $i -lt 20000 ]; do echo ${line}; i=$((i+1)); done; echo "do""ne"\r` });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    // The bridge's 256 KiB window, plus what the pseudo-terminal buffers.
    expect(received).toBeLessThan(600_000);
    unsubscribe();

    // With nobody listening, it goes on to the end.
    await outputUntil(main.api, terminal.id, 'done');
  });

  it('resizes a terminal', async () => {
    const { main, id } = await withSession();
    const terminal = await main.api.invoke('terminals.open', { sessionId: id, cols: 80, rows: 24 });

    await main.api.invoke('terminals.resize', { id: terminal.id, cols: 120, rows: 33 });
    // The test machine's PATH has only a few tools; stty is the host's.
    const stty = execFileSync('/bin/sh', ['-c', 'command -v stty'], { encoding: 'utf8' }).trim();
    await main.api.invoke('terminals.write', { id: terminal.id, data: `${stty} size\r` });

    await outputUntil(main.api, terminal.id, '33 120');
  });

  it("closes a Session's terminals when it is archived, and opens none for an archived Session", async () => {
    const { main, id } = await withSession();
    await main.api.invoke('terminals.open', { sessionId: id, cols: 80, rows: 24 });
    await waitFor(main.api, 'terminals', (list) => list.length === 1, { sessionId: id });

    await main.api.invoke('sessions.archive', { id });

    await waitFor(main.api, 'terminals', (list) => list.length === 0, { sessionId: id });
    await expect(main.api.invoke('terminals.open', { sessionId: id, cols: 80, rows: 24 })).rejects.toThrow('archived');
  });
});
