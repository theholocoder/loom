import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type EditorInvocation, type Machine } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

/** Main with a Waiting checkout Session on a fresh git checkout, and a stub editor `my-editor`. */
async function withSession(userDataDir?: string) {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: ['Done'] }] } });
  machine.installEditor('my-editor');
  const checkout = machine.gitRepo('billing-api');
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix it' });
  await waitFor(main.api, 'sessions', (list: Session[]) => list.some((s) => s.id === id && s.status === 'waiting'));
  return { machine, main, checkout, id };
}

/** Waits for the stub `name` to have been run `count` times, and returns its runs. */
async function launched(machine: Machine, name: string, count = 1): Promise<EditorInvocation[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const runs = machine.editorInvocations(name);
    if (runs.length >= count) return runs;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${name} was run ${machine.editorInvocations(name).length} times, want ${count}`);
}

describe('open in editor and terminal', () => {
  it('has an editor command and a terminal command setting, kept across restarts', async () => {
    const userDataDir = tempDir('loom-seam-a-');
    const main = await startMain({ machine: tempMachine(), userDataDir });
    expect(await waitFor(main.api, 'settings', () => true)).toMatchObject({ editorCommand: 'code', terminalCommand: '' });

    await main.api.invoke('settings.setEditorCommand', { editorCommand: ' my-editor --new-window ' });
    expect(await main.api.invoke('settings.setTerminalCommand', { terminalCommand: 'my-term -d {path}' })).toMatchObject({
      editorCommand: 'my-editor --new-window',
      terminalCommand: 'my-term -d {path}',
    });
    await expect(main.api.invoke('settings.setEditorCommand', { editorCommand: '  ' })).rejects.toThrow('The editor command is empty');
    await expect(main.api.invoke('settings.setEditorCommand', { editorCommand: 'code "unclosed' })).rejects.toThrow('unclosed quote');
    await main.close();

    const again = await startMain({ machine: tempMachine(), userDataDir });
    expect(await waitFor(again.api, 'settings', () => true)).toMatchObject({ editorCommand: 'my-editor --new-window', terminalCommand: 'my-term -d {path}' });
  });

  it("opens the Session's working copy in the editor, run in its Environment", async () => {
    const { machine, main, checkout, id } = await withSession();
    await main.api.invoke('settings.setEditorCommand', { editorCommand: 'my-editor --new-window' });

    await main.api.invoke('sessions.openInEditor', { id });

    expect(await launched(machine, 'my-editor')).toEqual([{ args: ['--new-window', checkout], cwd: checkout }]);
  });

  it('opens a file of the working copy in the editor', async () => {
    const { machine, main, checkout, id } = await withSession();
    await main.api.invoke('settings.setEditorCommand', { editorCommand: 'my-editor --goto "{path}"' });

    await main.api.invoke('sessions.openInEditor', { id, file: 'src/app.ts' });

    expect(await launched(machine, 'my-editor')).toEqual([{ args: ['--goto', `${checkout}/src/app.ts`], cwd: checkout }]);
    await expect(main.api.invoke('sessions.openInEditor', { id, file: '../elsewhere.ts' })).rejects.toThrow("isn't in the Session's working copy");
  });

  it('opens a terminal in the working copy', async () => {
    const { machine, main, checkout, id } = await withSession();
    machine.installEditor('my-term');

    await expect(main.api.invoke('sessions.openInTerminal', { id })).rejects.toThrow('Set a terminal command in Settings');

    await main.api.invoke('settings.setTerminalCommand', { terminalCommand: 'my-term' });
    await main.api.invoke('sessions.openInTerminal', { id });
    await main.api.invoke('settings.setTerminalCommand', { terminalCommand: 'my-term --working-directory {path}' });
    await main.api.invoke('sessions.openInTerminal', { id });

    // Launches don't wait for the program, so the two runs may log in either order.
    const runs = await launched(machine, 'my-term', 2);
    expect(runs).toHaveLength(2);
    expect(runs).toEqual(
      expect.arrayContaining([
        { args: [], cwd: checkout },
        { args: ['--working-directory', checkout], cwd: checkout },
      ]),
    );
  });

  it("says so when the editor isn't on the Environment's PATH", async () => {
    const { main, id } = await withSession();
    await main.api.invoke('settings.setEditorCommand', { editorCommand: 'no-such-editor' });

    await expect(main.api.invoke('sessions.openInEditor', { id })).rejects.toThrow(
      "no-such-editor isn't installed in Native, or isn't on your shell's PATH. Check the editor command in Settings.",
    );
  });
});
