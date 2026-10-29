// Main's core, with no Electron in it: the Electron entry point and seam A
// tests both build main through createLoom and talk to it only through `api`.
import { spawn } from 'node:child_process';
import type { Commands, EnvironmentStatus, LoomApi, Project, Topics } from '../shared/api';
import type { Clock } from './clock';
import { Environment, type SpawnBridge } from './environments/environment';
import { Projects } from './projects/projects';
import { openDatabase } from './storage/database';
import { Topic } from './topic';

export interface LoomOptions {
  userDataDir: string;
  appVersion: string;
  bridgePath: string;
  clock: Clock;
  spawnBridge?: SpawnBridge;
  /** Shows the folder picker; resolves to null if the user cancels. */
  chooseFolder?: () => Promise<string | null>;
}

export interface Loom {
  api: LoomApi;
  close(): Promise<void>;
}

export async function createLoom(options: LoomOptions): Promise<Loom> {
  const spawnBridge: SpawnBridge = options.spawnBridge ?? ((command, args) => spawn(command, args, { stdio: 'pipe' }));

  const db = await openDatabase(options.userDataDir);

  const environments = new Topic<EnvironmentStatus[]>([]);
  let wasConnected = false;
  const native = new Environment({
    id: 'native',
    label: 'Native',
    bridgePath: options.bridgePath,
    appVersion: options.appVersion,
    clock: options.clock,
    spawnBridge,
    onChange: (status) => {
      environments.set([status]);
      // The Projects' Forges are checked whenever their Environment connects.
      const isConnected = status.state === 'connected';
      if (isConnected && !wasConnected) void projectService.checkForges(status.id);
      wasConnected = isConnected;
    },
  });
  environments.set([native.status]);

  const projects = new Topic<Project[]>([]);
  const projectService = await Projects.load({
    db,
    clock: options.clock,
    environment: (id) => (id === native.status.id ? { label: native.status.label, request: (...args) => native.request(...args) } : undefined),
    onChange: (list) => projects.set(list),
  });
  projects.set(projectService.list());

  void native.start();

  const topics: { [T in keyof Topics]: Topic<Topics[T]> } = { environments, projects };
  const commands: { [C in keyof Commands]: (params: Commands[C]['params']) => Commands[C]['result'] | Promise<Commands[C]['result']> } = {
    'environments.list': () => environments.value,
    'environments.detect': async () => {
      await native.detectAgent();
    },
    'environments.reload': async ({ id }) => {
      if (id !== native.status.id) throw new Error(`unknown Environment "${id}"`);
      await native.reload();
      await projectService.checkForges(id);
    },
    'dialogs.chooseFolder': () => (options.chooseFolder ? options.chooseFolder() : null),
    'projects.list': () => projects.value,
    'projects.link': (params) => projectService.link(params),
    'projects.setBranchPrefix': ({ id, branchPrefix }) => projectService.setBranchPrefix(id, branchPrefix),
    'projects.check': () => projectService.checkForges(),
  };

  const api: LoomApi = {
    invoke: async (command, ...params) => {
      if (!Object.hasOwn(commands, command)) throw new Error(`unknown command "${command}"`);
      return commands[command](params[0] as never) as never;
    },
    subscribe: (topic, listener) => {
      if (!Object.hasOwn(topics, topic)) throw new Error(`unknown topic "${topic}"`);
      return topics[topic].subscribe(listener as never);
    },
  };

  return {
    api,
    close: async () => {
      await native.stop();
      await db.destroy();
    },
  };
}
