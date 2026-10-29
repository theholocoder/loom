// Main's core, with no Electron in it: the Electron entry point and seam A
// tests both build main through createLoom and talk to it only through `api`.
import { spawn } from 'node:child_process';
import type { Commands, EnvironmentStatus, LoomApi, Project, Session, TopicParams, Topics } from '../shared/api';
import { AcpAdapter } from './agents/acp-adapter';
import { OPENCODE_ACP } from './agents/opencode';
import type { Clock } from './clock';
import { Environment, type SpawnBridge } from './environments/environment';
import { Projects } from './projects/projects';
import { Sessions } from './sessions/sessions';
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
      // onChange only fires once start() runs, after projectService exists.
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
    environment: (id) => (id === native.status.id ? { label: native.status.label, connected: () => native.status.state === 'connected', request: (...args) => native.request(...args) } : undefined),
    onChange: (list) => projects.set(list),
  });
  projects.set(projectService.list());

  const sessions = new Topic<Session[]>([]);
  const sessionService = await Sessions.load({
    db,
    clock: options.clock,
    adapter: new AcpAdapter(OPENCODE_ACP, options.appVersion),
    project: (id) => projectService.list().find((p) => p.id === id),
    environment: (id) => (id === native.status.id ? { label: native.status.label, openChannel: (params) => native.openChannel(params) } : undefined),
    onChange: (list) => sessions.set(list),
  });
  sessions.set(sessionService.list());

  void native.start();

  const topics: { [T in Exclude<keyof Topics, keyof TopicParams>]: Topic<Topics[T]> } = { environments, projects, sessions };
  const paramTopics: { [T in keyof TopicParams]: (params: TopicParams[T], listener: (value: Topics[T]) => void) => () => void } = {
    transcript: ({ sessionId }, listener) => sessionService.subscribeTranscript(sessionId, listener),
  };
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
    'sessions.list': () => sessions.value,
    'sessions.create': (params) => sessionService.create(params),
    'sessions.send': (params) => sessionService.send(params),
  };

  const api: LoomApi = {
    invoke: async (command, ...params) => {
      if (!Object.hasOwn(commands, command)) throw new Error(`unknown command "${command}"`);
      return commands[command](params[0] as never) as never;
    },
    subscribe: (topic, listener, ...params) => {
      if (Object.hasOwn(paramTopics, topic)) {
        if (!params[0]) throw new Error(`topic "${topic}" needs parameters`);
        return paramTopics[topic as keyof TopicParams](params[0] as never, listener as never);
      }
      if (!Object.hasOwn(topics, topic)) throw new Error(`unknown topic "${topic}"`);
      return topics[topic as keyof typeof topics].subscribe(listener as never);
    },
  };

  return {
    api,
    close: async () => {
      await sessionService.shutdown();
      await native.stop();
      await db.destroy();
    },
  };
}
