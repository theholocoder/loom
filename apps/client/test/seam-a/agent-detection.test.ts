import { describe, expect, it } from 'vitest';
import { Machine, startMain, waitFor } from './harness';
import type { EnvironmentStatus } from '../../src/shared/api';

const native = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native');
const checked = (envs: EnvironmentStatus[]) => {
  const agent = native(envs)?.agent;
  return !!agent && !agent.checking && agent.state !== 'unknown';
};

const signedIn = [
  { id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] },
  { id: 'openai', name: 'OpenAI', connections: [] },
];
const signedOut = [
  { id: 'anthropic', name: 'Anthropic', connections: [] },
  { id: 'openai', name: 'OpenAI', connections: [] },
];

async function detectedAtStartup(machine: Machine) {
  const main = await startMain({ machine });
  const envs = await waitFor(main.api, 'environments', checked);
  return { main, agent: native(envs)!.agent! };
}

describe('detecting OpenCode at startup', () => {
  it('reports OpenCode ready when it is recent enough and signed in to a provider', async () => {
    const machine = new Machine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn });

    const { agent } = await detectedAtStartup(machine);

    expect(agent).toMatchObject({ name: 'OpenCode', state: 'ready', version: '2.1.4' });
  });

  it('reports OpenCode missing when it is not on the PATH', async () => {
    const { agent } = await detectedAtStartup(new Machine());

    expect(agent).toMatchObject({ name: 'OpenCode', state: 'missing' });
    expect(agent.version).toBeUndefined();
  });

  it('reports OpenCode unsupported when it is older than 2.1.4', async () => {
    const machine = new Machine();
    machine.installOpencode({ version: 'opencode v2.1.3', integrations: signedIn });

    const { agent } = await detectedAtStartup(machine);

    expect(agent).toMatchObject({ state: 'unsupported', version: '2.1.3' });
  });

  it('refuses V1 OpenCode', async () => {
    const machine = new Machine();
    machine.installOpencode({ version: '1.19.4', integrations: signedIn });

    const { agent } = await detectedAtStartup(machine);

    expect(agent).toMatchObject({ state: 'unsupported', version: '1.19.4' });
  });

  it('accepts versions newer than the minimum', async () => {
    const machine = new Machine();
    machine.installOpencode({ version: 'opencode v2.10.0', integrations: signedIn });

    const { agent } = await detectedAtStartup(machine);

    expect(agent).toMatchObject({ state: 'ready', version: '2.10.0' });
  });

  it('reports OpenCode signed out when no integration has a connection', async () => {
    const machine = new Machine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedOut });

    const { agent } = await detectedAtStartup(machine);

    expect(agent).toMatchObject({ state: 'signed-out', version: '2.1.4' });
  });

  it('only runs `opencode --version` and a `serve --stdio` probe, never `auth list` or `models`', async () => {
    const machine = new Machine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn });

    await detectedAtStartup(machine);

    const invocations = machine.opencodeInvocations();
    expect(invocations.map((argv) => argv.slice(0, 2))).toEqual([['--version'], ['serve', '--stdio']]);
  });

  it("finds OpenCode on the login shell's PATH, which the launcher's PATH lacks", async () => {
    const machine = new Machine();
    const miseBin = machine.binDir('mise-installs');
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn }, miseBin);
    machine.addToShellPath(miseBin);

    const { agent } = await detectedAtStartup(machine);

    expect(agent.state).toBe('ready');
  });
});

describe('re-checking OpenCode', () => {
  it('detects again when asked, as Settings does when it opens', async () => {
    const machine = new Machine();
    const { main } = await detectedAtStartup(machine);
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn });

    await main.api.invoke('environments.detect');

    expect(native(await main.api.invoke('environments.list'))?.agent).toMatchObject({ state: 'ready', checking: false });
  });

  // Native Windows has no login shell to re-read.
  it.skipIf(process.platform === 'win32')('picks up a changed shell PATH only after Environment Reload', async () => {
    const machine = new Machine();
    const { main } = await detectedAtStartup(machine);
    const newBin = machine.binDir('newly-installed');
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn }, newBin);
    machine.addToShellPath(newBin);

    await main.api.invoke('environments.detect');
    expect(native(await main.api.invoke('environments.list'))?.agent?.state).toBe('missing');

    await main.api.invoke('environments.reload', { id: 'native' });
    expect(native(await main.api.invoke('environments.list'))?.agent?.state).toBe('ready');
  });

  it.skipIf(process.platform === 'win32')("reports that the Environment came from the user's login shell", async () => {
    const main = await startMain();

    const envs = await waitFor(main.api, 'environments', (e) => native(e)?.shellEnvironment !== undefined);

    expect(native(envs)?.shellEnvironment).toBe('interactive');
  });
});
