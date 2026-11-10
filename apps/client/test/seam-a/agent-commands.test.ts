import { describe, expect, it } from 'vitest';
import { startMain, tempMachine, waitFor, type Machine, type OpencodeScript } from './harness';
import type { EnvironmentStatus, Session } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

const commands: NonNullable<OpencodeScript['commands']> = [
  { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted' },
  { name: 'hello' },
];
const skills: NonNullable<OpencodeScript['skills']> = [
  { id: 'tdd', name: 'tdd', description: 'Test-driven development.' },
  { id: 'grill-me', name: 'grill-me' },
];

/** A machine with a ready OpenCode offering `commands` and `skills`, and a git checkout. */
function machineWith(script: Partial<OpencodeScript> = {}): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({
    version: 'opencode v2.1.4',
    integrations: signedIn,
    models: [{ providerID: 'opencode', id: 'pulse-free', name: 'Pulse Free' }],
    commands,
    skills,
    acp: { turns: [] },
    ...script,
  });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

async function withProject(machine: Machine, checkout: string) {
  const main = await startMain({ machine });
  await waitFor(main.api, 'environments', ready);
  const project = await main.api.invoke('projects.link', { path: checkout });
  return { main, project };
}

describe("the agent's commands and skills before a Session exists", () => {
  it("lists the commands and skills OpenCode offers in the Project's checkout", async () => {
    const { machine, checkout } = machineWith();
    const { main, project } = await withProject(machine, checkout);

    const listed = await main.api.invoke('projects.commands', { id: project.id });

    expect(listed).toEqual([
      { kind: 'command', name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted' },
      { kind: 'command', name: 'hello' },
      { kind: 'skill', name: 'tdd', description: 'Test-driven development.' },
      { kind: 'skill', name: 'grill-me' },
    ]);
    const asked = machine.opencodeRequests().filter((r) => r.path === '/api/command' || r.path === '/api/skill');
    expect(asked).toEqual([
      { method: 'GET', path: '/api/command', directory: checkout },
      { method: 'GET', path: '/api/skill', directory: checkout },
    ]);
  });

  it('asks OpenCode once per checkout, with its models, until the agent is checked again', async () => {
    const { machine, checkout } = machineWith();
    const { main, project } = await withProject(machine, checkout);

    await main.api.invoke('projects.models', { id: project.id });
    await main.api.invoke('projects.commands', { id: project.id });
    await main.api.invoke('projects.commands', { id: project.id });
    expect(machine.opencodeRequests().filter((r) => r.path === '/api/skill')).toHaveLength(1);
    expect(machine.opencodeRequests().filter((r) => r.path === '/api/model')).toHaveLength(1);

    await main.api.invoke('environments.detect');
    await main.api.invoke('projects.commands', { id: project.id });
    expect(machine.opencodeRequests().filter((r) => r.path === '/api/skill')).toHaveLength(2);
  });

  it('still lists the models, and no commands, when OpenCode lists no commands or skills', async () => {
    const { machine, checkout } = machineWith({ commands: undefined, skills: undefined, noCatalog: true });
    const { main, project } = await withProject(machine, checkout);

    expect(await main.api.invoke('projects.models', { id: project.id })).toHaveLength(1);
    expect(await main.api.invoke('projects.commands', { id: project.id })).toEqual([]);
  });
});

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => {
  const found = sessions.find((s) => s.id === id);
  return !!found && check(found);
};

describe("a Session's commands", () => {
  it('are the commands its agent announces over ACP', async () => {
    const { machine, checkout } = machineWith();
    const { main, project } = await withProject(machine, checkout);

    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Hi' });

    const found = (await waitFor(main.api, 'sessions', session(id, (s) => s.agentCommands !== undefined))).find((s) => s.id === id)!;
    expect(found.agentCommands).toEqual([
      { kind: 'command', name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted' },
      { kind: 'command', name: 'hello' },
      { kind: 'command', name: 'compact', description: 'Compact the session' },
    ]);
  });
});
