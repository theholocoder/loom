// Main's core, with no Electron in it: the Electron entry point and seam A
// tests both build main through createLoom and talk to it only through `api`.
import { spawn } from 'node:child_process';
import type { Commands, EnvironmentStatus, LoomApi, Topics } from '../shared/api';
import type { Clock } from './clock';
import { Environment, type SpawnBridge } from './environments/environment';
import { openDatabase } from './storage/database';
import { Topic } from './topic';

export interface LoomOptions {
  userDataDir: string;
  appVersion: string;
  bridgePath: string;
  clock: Clock;
  spawnBridge?: SpawnBridge;
}

export interface Loom {
  api: LoomApi;
  close(): Promise<void>;
}

export async function createLoom(options: LoomOptions): Promise<Loom> {
  const spawnBridge: SpawnBridge = options.spawnBridge ?? ((command, args) => spawn(command, args, { stdio: 'pipe' }));

  const db = await openDatabase(options.userDataDir);

  const environments = new Topic<EnvironmentStatus[]>([]);
  const native = new Environment({
    id: 'native',
    label: 'Native',
    bridgePath: options.bridgePath,
    appVersion: options.appVersion,
    clock: options.clock,
    spawnBridge,
    onChange: (status) => environments.set([status]),
  });
  environments.set([native.status]);
  void native.start();

  const topics: { [T in keyof Topics]: Topic<Topics[T]> } = { environments };
  const commands: { [C in keyof Commands]: (params: Commands[C]['params']) => Commands[C]['result'] | Promise<Commands[C]['result']> } = {
    'environments.list': () => environments.value,
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
