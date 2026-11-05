// Main's core, with no Electron in it: the Electron entry point and seam A
// tests both build main through createLoom and talk to it only through `api`.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Commands, DatabaseStatus, EnvironmentStatus, LoomApi, Project, Session, Settings as SettingsValues, TopicParams, Topics } from '../shared/api';
import type { AgentAdapter } from './agents/adapter';
import { AcpAdapter } from './agents/acp-adapter';
import { OPENCODE_ACP } from './agents/opencode';
import type { Clock } from './clock';
import { Environment, type SpawnBridge } from './environments/environment';
import { Projects } from './projects/projects';
import { Attachments } from './sessions/attachments';
import { openIn, type Opener } from './sessions/open-in';
import { Sessions, type SessionEnvironment } from './sessions/sessions';
import { Settings } from './settings';
import { DATABASE_FILE, DatabaseDamagedError, openDatabase, type LoomDatabase } from './storage/database';
import { listSnapshots, restoreLatestSnapshot } from './storage/snapshots';
import { Topic } from './topic';
import { isWebLink } from '../shared/links';

export interface LoomOptions {
  userDataDir: string;
  appVersion: string;
  bridgePath: string;
  clock: Clock;
  /** How many untracked files a diff counts lines for (default: the diff service's). */
  maxUntrackedCounted?: number;
  spawnBridge?: SpawnBridge;
  /** Shows the folder picker; resolves to null if the user cancels. */
  chooseFolder?: () => Promise<string | null>;
  /** Opens a URL in the user's browser. */
  openExternal: (url: string) => Promise<void>;
  /** The agent Sessions run on; OpenCode over ACP unless a test gives another. */
  adapter?: AgentAdapter;
}

export interface Loom {
  api: LoomApi;
  close(): Promise<void>;
}

/**
 * Starts main. A damaged database doesn't stop it: main then serves only the
 * `database` topic, for the renderer's blocking screen, and
 * `database.restoreLatestSnapshot`, which starts everything else once done.
 */
export async function createLoom(options: LoomOptions): Promise<Loom> {
  const database = new Topic<DatabaseStatus>({ state: 'ok' });
  const open = () => openDatabase(options.userDataDir, { now: () => options.clock.now() });
  let started: Loom | undefined;
  try {
    started = await startLoom(options, await open(), database);
    return started;
  } catch (error) {
    if (!(error instanceof DatabaseDamagedError)) throw error;
    database.set(damaged(options.userDataDir, error));
  }

  let restoring: Promise<void> | undefined;
  const restore = async () => {
    restoreLatestSnapshot(join(options.userDataDir, DATABASE_FILE), options.userDataDir, options.clock.now());
    try {
      started = await startLoom(options, await open(), database);
    } catch (error) {
      if (error instanceof DatabaseDamagedError) database.set(damaged(options.userDataDir, error));
      throw error;
    }
    database.set({ state: 'ok' });
  };
  const notStarted = () => new Error('the database is damaged; restore a snapshot first');
  return {
    api: {
      invoke: async (command, ...params) => {
        if (started) return started.api.invoke(command, ...params);
        if (command !== 'database.restoreLatestSnapshot') throw notStarted();
        restoring ??= restore().finally(() => (restoring = undefined));
        return restoring as never;
      },
      subscribe: (topic, listener, ...params) => {
        if (started) return started.api.subscribe(topic, listener, ...params);
        if (topic !== 'database') throw notStarted();
        return database.subscribe(listener as never);
      },
    },
    close: async () => {
      await restoring?.catch(() => {});
      await started?.close();
    },
  };
}

function damaged(userDataDir: string, error: DatabaseDamagedError): DatabaseStatus {
  return { state: 'damaged', path: error.path, problem: error.problem, snapshots: listSnapshots(userDataDir).reverse() };
}

async function startLoom(options: LoomOptions, db: LoomDatabase, database: Topic<DatabaseStatus>): Promise<Loom> {
  const spawnBridge: SpawnBridge = options.spawnBridge ?? ((command, args) => spawn(command, args, { stdio: 'pipe' }));

  const environments = new Topic<EnvironmentStatus[]>([]);
  let wasConnected = false;
  let lastState: EnvironmentStatus['state'] = 'starting';
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
      if (isConnected && !wasConnected) {
        void projectService.checkForges(status.id);
        // Branches may have changed while Loom wasn't looking.
        void sessionService.lookUpBranches(status.id);
      }
      wasConnected = isConnected;
      // A bridge that was up and died took its agents with it.
      if (status.state === 'disconnected' && (lastState === 'connected' || lastState === 'unresponsive')) sessionService.environmentRestarted(status.id);
      lastState = status.state;
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

  const settingsService = await Settings.load(db, (value) => settings.set(value));
  const settings = new Topic<SettingsValues>(settingsService.value);

  const nativeForSessions: SessionEnvironment = {
    label: native.status.label,
    request: (...args) => native.request(...args),
    home: () => native.status.bridge?.home || undefined,
    openChannel: (params) => native.openChannel(params),
    ready: () => native.ready(),
    restart: () => native.restart(),
    tempDir: () => tempDirOf(native.status.bridge?.os, native.status.bridge?.home),
    bridgeExecutable: () => native.status.bridge?.executable || undefined,
  };
  /** The models the agent offers in the Project's checkout, once its Environment is up. */
  const listModels = async (projectId: number) => {
    const checkout = projectService.list().find((p) => p.id === projectId)?.checkout;
    if (!checkout) throw new Error(`unknown Project ${projectId}`);
    if (checkout.environmentId !== native.status.id) throw new Error(`unknown Environment "${checkout.environmentId}"`);
    await native.ready();
    return native.listModels(checkout.path);
  };
  const sessions = new Topic<Session[]>([]);
  const sessionService = await Sessions.load({
    db,
    clock: options.clock,
    adapter: options.adapter ?? new AcpAdapter(OPENCODE_ACP, options.appVersion),
    project: (id) => projectService.list().find((p) => p.id === id),
    environment: (id) => (id === native.status.id ? nativeForSessions : undefined),
    worktreeRoot: () => settingsService.value.worktreeRoot,
    onChange: (list) => sessions.set(list),
    maxUntrackedCounted: options.maxUntrackedCounted,
    projectTrust: { get: (id) => projectService.trusted(id), set: (id, trusted) => projectService.setTrusted(id, trusted) },
    approvals: () => settingsService.value.approvals,
    attachments: new Attachments(options.userDataDir),
    // Only checking what the user picked: not worth holding the change while the Environment starts.
    models: (projectId) => (native.status.state === 'connected' ? listModels(projectId) : Promise.reject(new Error(`${native.status.label} is not connected`))),
  });
  sessions.set(sessionService.list());

  void native.start();

  /** Opens a Session's working copy in the user's editor or terminal, in its Environment. */
  const openInSession = (id: number, opener: Opener, file?: string) => {
    const session = sessionService.list().find((s) => s.id === id);
    if (!session) throw new Error(`unknown Session ${id}`);
    const environmentId = projectService.list().find((p) => p.id === session.projectId)?.checkout.environmentId;
    if (environmentId !== native.status.id) throw new Error(`unknown Environment "${environmentId}"`);
    const { editorCommand, terminalCommand } = settingsService.value;
    return openIn(nativeForSessions, {
      opener,
      command: opener === 'editor' ? editorCommand : terminalCommand,
      workingCopy: session.workingCopy.path,
      file,
    });
  };

  const topics: { [T in Exclude<keyof Topics, keyof TopicParams>]: Topic<Topics[T]> } = { environments, projects, settings, sessions, database };
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
    'links.open': async ({ url }) => {
      if (!isWebLink(url)) throw new Error('Loom only opens web links.');
      await options.openExternal(url);
    },
    'dialogs.chooseFolder': () => (options.chooseFolder ? options.chooseFolder() : null),
    'projects.list': () => projects.value,
    'projects.link': (params) => projectService.link(params),
    'projects.setBranchPrefix': ({ id, branchPrefix }) => projectService.setBranchPrefix(id, branchPrefix),
    'projects.issues': ({ id, search }) => projectService.issues(id, search),
    'projects.branches': ({ id }) => sessionService.branches(id),
    'projects.check': () => projectService.checkForges(),
    'projects.models': ({ id }) => listModels(id),
    'projects.files': ({ id, ref }) => sessionService.projectFiles(id, ref),
    'sessions.check': async () => {
      await Promise.all(environments.value.map((e) => sessionService.lookUpBranches(e.id)));
    },
    'settings.setWorktreeRoot': ({ worktreeRoot }) => settingsService.setWorktreeRoot(worktreeRoot),
    'settings.setEditorCommand': ({ editorCommand }) => settingsService.setEditorCommand(editorCommand),
    'settings.setTerminalCommand': ({ terminalCommand }) => settingsService.setTerminalCommand(terminalCommand),
    'settings.setDiffCollapsedPatterns': ({ patterns }) => settingsService.setDiffCollapsedPatterns(patterns),
    'settings.setAppearance': (appearance) => settingsService.setAppearance(appearance),
    'settings.setApproval': ({ category, setting }) => settingsService.setApproval(category, setting),
    'sessions.list': () => sessions.value,
    'sessions.create': (params) => sessionService.create(params),
    'sessions.diffBases': ({ id }) => sessionService.diffBases(id),
    'sessions.setDiffBase': ({ id, base }) => sessionService.setDiffBase(id, base),
    'sessions.send': (params) => sessionService.send(params),
    'sessions.files': ({ id }) => sessionService.files(id),
    'sessions.stop': (params) => sessionService.stop(params),
    'sessions.removeQueued': (params) => sessionService.removeQueued(params),
    'sessions.sendNow': (params) => sessionService.sendNow(params),
    'sessions.steer': (params) => sessionService.steer(params),
    'sessions.setModel': (params) => sessionService.setModel(params),
    'sessions.archive': (params) => sessionService.archive(params),
    'sessions.requestMergeRequest': (params) => sessionService.requestMergeRequest(params),
    'sessions.linkMergeRequest': (params) => sessionService.linkMergeRequest(params),
    'sessions.setUnread': (params) => sessionService.setUnread(params),
    'sessions.openInEditor': ({ id, file }) => openInSession(id, 'editor', file),
    'sessions.openInTerminal': ({ id }) => openInSession(id, 'terminal'),
    'sessions.diff': ({ id, uncommittedOnly }) => sessionService.diff(id, uncommittedOnly),
    'sessions.diffFile': ({ id, path, uncommittedOnly }) => sessionService.diffFile(id, path, uncommittedOnly),
    'sessions.retry': (params) => sessionService.retry(params),
    'sessions.answer': (params) => sessionService.answer(params),
    'sessions.trust': (params) => sessionService.trust(params),
    'sessions.approve': (params) => sessionService.approve(params),
    'database.restoreLatestSnapshot': () => {
      throw new Error('the database is not damaged');
    },
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

/**
 * The Environment's temp directory: `/tmp`, or on native Windows `%TEMP%`,
 * which the bridge doesn't report, so its usual place under the home.
 */
function tempDirOf(os: string | undefined, home: string | undefined): string {
  if (os === 'windows' && home) return `${home.replaceAll('\\', '/')}/AppData/Local/Temp`;
  return '/tmp';
}
