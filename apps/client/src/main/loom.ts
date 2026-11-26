// Main's core, with no Electron in it: the Electron entry point and seam A
// tests both build main through createLoom and talk to it only through `api`.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Commands, DatabaseStatus, EnvironmentStatus, Feedback, LoomApi, OpenSessionRequest, Project, RemovedProject, Session, Settings as SettingsValues, TopicParams, Topics } from '../shared/api';
import type { AgentAdapter } from './agents/adapter';
import { AcpAdapter } from './agents/acp-adapter';
import { OPENCODE_ACP } from './agents/opencode';
import type { Clock } from './clock';
import { bridgeBinaryPath } from './environments/bridge-path';
import { Environment, type SpawnBridge } from './environments/environment';
import { Projects } from './projects/projects';
import { Attachments } from './sessions/attachments';
import { Babysit } from './sessions/babysit';
import { searchConversations } from './sessions/conversation-search';
import { Highlights } from './sessions/highlights';
import { Notifications, type DesktopNotification } from './notifications';
import { openIn, type Opener } from './sessions/open-in';
import { Panels } from './sessions/panels';
import { SessionForge } from './sessions/session-forge';
import { Sessions, type SessionEnvironment } from './sessions/sessions';
import { Terminals } from './sessions/terminals';
import { checkWorktreeRootFolder, expandRoot } from './sessions/working-copies';
import { Settings } from './settings';
import { DATABASE_FILE, DatabaseDamagedError, openDatabase, type LoomDatabase } from './storage/database';
import { listSnapshots, restoreLatestSnapshot } from './storage/snapshots';
import type { SqliteDriver } from './storage/sqlite';
import { Topic } from './topic';
import { Updates, type Updater } from './updates';
import { dashboard } from './usage/usage';
import { UsageSync } from './usage/usage-sync';
import { isWebLink } from '../shared/links';
import { ownLocale } from '../shared/dates';

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
  /** Shows a desktop notification; `onClick` asks the window to open its Session. None are shown without it. */
  notify?: (notification: DesktopNotification) => void;
  /** Whether Loom's window has the focus; taken as not without it. */
  windowFocused?: () => boolean;
  /** The system's regional format, such as `fr-FR`; Intl's own locale without it. */
  systemLocale?: string;
  /** Looks for, downloads and installs releases; Loom looks for no updates without one, as in development. */
  updater?: Updater;
  /** The SQLite driver; better-sqlite3 when its binary loads, node:sqlite otherwise. */
  sqliteDriver?: SqliteDriver;
  /** Sends the user's feedback to Loom's makers; there's none to send without it, as in development. */
  sendFeedback?: (feedback: Feedback) => void;
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
  const open = () => openDatabase(options.userDataDir, { now: () => options.clock.now(), driver: options.sqliteDriver });
  // Looked for whatever state the database is in: a fixed release may be what it takes.
  const updates = new Updates(options.updater, options.clock);
  let started: Loom | undefined;
  try {
    started = await startLoom(options, await open(), database, updates);
    updates.start();
    return started;
  } catch (error) {
    if (!(error instanceof DatabaseDamagedError)) throw error;
    database.set(damaged(options.userDataDir, error));
  }
  updates.start();

  let restoring: Promise<void> | undefined;
  const restore = async () => {
    restoreLatestSnapshot(join(options.userDataDir, DATABASE_FILE), options.userDataDir, options.clock.now());
    try {
      started = await startLoom(options, await open(), database, updates);
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
        if (command === 'update.status') return updates.status.value as never;
        if (command === 'update.restart') return updates.restart() as never;
        if (command === 'feedback.send') return sendFeedback(options, params[0] as Feedback) as never;
        if (command !== 'database.restoreLatestSnapshot') throw notStarted();
        restoring ??= restore().finally(() => (restoring = undefined));
        return restoring as never;
      },
      subscribe: (topic, listener, ...params) => {
        if (started) return started.api.subscribe(topic, listener, ...params);
        if (topic === 'update') return updates.status.subscribe(listener as never);
        if (topic !== 'database') throw notStarted();
        return database.subscribe(listener as never);
      },
    },
    close: async () => {
      updates.stop();
      await restoring?.catch(() => {});
      await started?.close();
    },
  };
}

/** How long the dashboard waits for the agents' records to be read before showing what Loom has. */
const DASHBOARD_SYNC_MS = 5_000;

/** The longest feedback message sent, which is plenty for one. */
const MAX_FEEDBACK = 10_000;

/** Sends the user's feedback, as far as this build sends any; rejects an empty one. */
async function sendFeedback(options: LoomOptions, { kind, message, email }: Feedback): Promise<void> {
  if (!options.sendFeedback) throw new Error('this build of Loom sends no feedback');
  const text = message.trim();
  if (!text) throw new Error('the feedback is empty');
  if (text.length > MAX_FEEDBACK) throw new Error(`the feedback is longer than ${MAX_FEEDBACK} characters`);
  options.sendFeedback({ kind: kind === 'idea' ? 'idea' : 'bug', message: text, email: email?.trim() || undefined });
}

function damaged(userDataDir: string, error: DatabaseDamagedError): DatabaseStatus {
  return { state: 'damaged', path: error.path, problem: error.problem, snapshots: listSnapshots(userDataDir).reverse() };
}

async function startLoom(options: LoomOptions, db: LoomDatabase, database: Topic<DatabaseStatus>, updates: Updates): Promise<Loom> {
  const spawnBridge: SpawnBridge = options.spawnBridge ?? ((command, args, env) => spawn(command, args, { stdio: 'pipe', env: { ...process.env, ...env } }));

  const environments = new Topic<EnvironmentStatus[]>([]);
  let babysit: Babysit | undefined;
  /** Every Environment Loom has, by id: the native one first, then WSL distros'. */
  const envs = new Map<string, Environment>();
  /** Each Environment's agents' records' latest reading since it connected. */
  const usageReads = new Map<string, Promise<void>>();
  /** What an Environment's changes set off; each Environment has its own. */
  const watchEnvironment = () => {
    let wasConnected = false;
    let lastState: EnvironmentStatus['state'] | undefined;
    return (status: EnvironmentStatus) => {
      environments.set([...envs.values()].map((e) => e.status));
      // The Projects' Forges are checked whenever their Environment connects.
      // onChange only fires once start() runs, after projectService exists.
      const isConnected = status.state === 'connected';
      if (isConnected && !wasConnected) {
        // Babysit asks the Forge, so its first polls wait for that check.
        void projectService.checkForges(status.id).catch(() => {}).then(() => babysit?.pollAll());
        // Branches may have changed while Loom wasn't looking.
        void sessionService.lookUpBranches(status.id);
        // So may the agent's usage, in Loom and outside it.
        usageReads.set(status.id, usageSync.sync(status.id));
        // The native bridge is how Loom finds WSL distros.
        if (status.id === NATIVE) void listDistros();
      }
      wasConnected = isConnected;
      // A bridge that was up and died took its agents with it.
      if (status.state === 'disconnected' && (lastState === 'connected' || lastState === 'unresponsive')) sessionService.environmentRestarted(status.id);
      lastState = status.state;
    };
  };
  const native = new Environment({
    id: NATIVE,
    label: 'Native',
    launch: () => ({ command: options.bridgePath, args: [] }),
    appVersion: options.appVersion,
    clock: options.clock,
    spawnBridge,
    onChange: watchEnvironment(),
  });
  envs.set(NATIVE, native);

  // WSL distros, which the native bridge on Windows lists, and installs each one's bridge into (ADR 0008).
  /** wsl.exe's path, as the native bridge last found it. */
  let wslPath: string | undefined;
  /** The Linux bridge, which is copied into each distro. */
  const linuxBridgePath = bridgeBinaryPath(dirname(options.bridgePath), 'linux', 'x64');
  /** The Environment of WSL distro `distro`, made the first time it is asked for: it starts once used. */
  const wslEnvironment = (distro: string): Environment => {
    const id = `${WSL_PREFIX}${distro}`;
    const known = envs.get(id);
    if (known) return known;
    const environment = new Environment({
      id,
      label: distro,
      distro,
      stopped: true,
      // Started from the distro's own filesystem, never /mnt/c, which may be unmounted or moved.
      launch: async () => {
        if (!wslPath) await listDistros();
        if (!wslPath) throw new Error('WSL is not installed');
        return { command: wslPath, args: ['-d', distro, '--exec', '/bin/sh', '-c', 'exec "$HOME/.local/share/loom/bridge/$1/loom-bridge"', 'sh', options.appVersion], env: wslEnv() };
      },
      install: async () => {
        await native.ready();
        await native.request('wsl.install', WSL_INSTALL_TIMEOUT_MS + 10_000, { distro, version: options.appVersion, binary: linuxBridgePath, timeoutMs: WSL_INSTALL_TIMEOUT_MS });
      },
      appVersion: options.appVersion,
      clock: options.clock,
      spawnBridge,
      onChange: watchEnvironment(),
    });
    envs.set(id, environment);
    environments.set([...envs.values()].map((e) => e.status));
    return environment;
  };
  /** Looks for WSL distros through the native bridge, and adds an Environment for each new one. */
  const listDistros = async () => {
    try {
      await native.ready();
      const { wsl, distros } = await native.request<{ wsl?: string; distros: Array<{ name: string }> }>('wsl.list', WSL_LIST_TIMEOUT_MS);
      wslPath = wsl || undefined;
      for (const { name } of distros) wslEnvironment(name);
    } catch {
      // No WSL to list, or none now: the distros known stay.
    }
  };
  environments.set([native.status]);

  const projects = new Topic<Project[]>([]);
  const removedProjects = new Topic<RemovedProject[]>([]);
  const projectService = await Projects.load({
    db,
    clock: options.clock,
    environment: (id) => {
      const environment = envs.get(id);
      return environment && { label: environment.status.label, connected: () => environment.status.state === 'connected', request: (...args) => environment.request(...args) };
    },
    onChange: (list) => projects.set(list),
    onRemovedChange: (list) => removedProjects.set(list),
  });
  projects.set(projectService.list());
  removedProjects.set(projectService.listRemoved());
  // The distros the Projects' checkouts are in, whether or not WSL lists them now.
  for (const { checkout } of projectService.list()) if (checkout.environmentId.startsWith(WSL_PREFIX)) wslEnvironment(checkout.environmentId.slice(WSL_PREFIX.length));

  let highlights: Highlights | undefined;
  // Each Session's Panels, served in the Layout without the Terminals that ended (ADR 0009).
  const panels = await Panels.load(db, { layout: () => settingsService.value.layout, ended: (id) => terminals.ended(id) });
  const settingsService = await Settings.load(
    db,
    (value) => {
      settings.set(value);
      highlights?.settingsChanged();
      panels.settingsChanged();
    },
    // Checked where worktrees go, when Loom can: an Environment not up yet tells at the next worktree Session.
    { checkWorktreeRootFolder: (root) => (native.status.state === 'connected' ? checkWorktreeRootFolder(forSessions(native), root) : Promise.resolve()) },
  );
  const settings = new Topic<SettingsValues>(settingsService.value);

  /** Each Environment as the Session services take it. */
  const sessionEnvironments = new Map<Environment, SessionEnvironment>();
  const forSessions = (environment: Environment): SessionEnvironment => {
    const known = sessionEnvironments.get(environment);
    if (known) return known;
    const made: SessionEnvironment = {
      label: environment.status.label,
      request: (...args) => environment.request(...args),
      home: () => environment.status.bridge?.home || undefined,
      openChannel: (params) => environment.openChannel(params),
      ready: async () => {
        await environment.ready();
        // The agent's records are first read before its first run, which they then count (ADR 0012).
        if (adapter.usage && !usageSync.covers(adapter.name, environment.status.id)) await usageReads.get(environment.status.id);
      },
      restart: () => environment.restart(),
      tempDir: () => tempDirOf(environment.status.bridge?.os, environment.status.bridge?.home),
      bridgeExecutable: () => environment.status.bridge?.executable || undefined,
    };
    sessionEnvironments.set(environment, made);
    return made;
  };
  /** The Environment with this id, if Loom has it. */
  const environmentById = (id: string | undefined) => (id === undefined ? undefined : envs.get(id));
  /** The Environment with this id; throws if Loom has none. */
  const knownEnvironment = (id: string | undefined) => {
    const environment = environmentById(id);
    if (!environment) throw new Error(`unknown Environment "${id}"`);
    return environment;
  };
  /** Starts Environment `id` to link a checkout in it, if it waits to be used. */
  const startedToLink = async (id = NATIVE) => {
    const environment = envs.get(id);
    if (environment?.status.state === 'stopped') await environment.ready();
  };
  /** The Project's checkout, and its Environment once it is up. */
  const readyCheckout = async (projectId: number) => {
    const checkout = projectService.list().find((p) => p.id === projectId)?.checkout;
    if (!checkout) throw new Error(`unknown Project ${projectId}`);
    const environment = knownEnvironment(checkout.environmentId);
    await environment.ready();
    return { environment, path: checkout.path };
  };
  /** The models the agent offers in the Project's checkout, once its Environment is up. */
  const listModels = async (projectId: number) => {
    const { environment, path } = await readyCheckout(projectId);
    return environment.listModels(path);
  };
  /** The commands and skills the agent offers in the Project's checkout, once its Environment is up; asked of it again when `fresh`. */
  const listCommands = async (projectId: number, fresh?: boolean) => {
    const { environment, path } = await readyCheckout(projectId);
    return environment.listCommands(path, fresh);
  };
  const sessions = new Topic<Session[]>([]);
  const openSession = new Topic<OpenSessionRequest | null>(null);
  /** The Session the window shows, as the renderer last said. */
  let showing: number | null = null;
  /** The Session with this id, if Loom has it. */
  const sessionOf = (id: number) => sessionService.list().find((s) => s.id === id);
  const projectName = (id: number) => projectService.list().find((p) => p.id === id)?.name ?? `Project ${id}`;
  const notifications = new Notifications({
    settings: () => settingsService.value.notifications,
    session: sessionOf,
    projectName,
    inView: (id) => showing === id && (options.windowFocused?.() ?? false),
    show: (notification) => options.notify?.(notification),
    open: (sessionId) => openSession.set({ sessionId, click: (openSession.value?.click ?? 0) + 1 }),
  });
  /** The id of the Environment the Project's checkout is in. */
  const environmentIdOf = (projectId: number) => projectService.list().find((p) => p.id === projectId)?.checkout.environmentId;
  /** The Environment a Session's agent and git run in, as the Session services take it, if Loom has it. */
  const environmentForSession = (session: Session) => {
    const environment = sessionEnvironment(session);
    return environment && forSessions(environment);
  };
  /** The Environment a Session runs in, if Loom has it. */
  const sessionEnvironment = (session: Session) => environmentById(environmentIdOf(session.projectId));
  const terminals = new Terminals({
    session: sessionOf,
    environment: (session) => {
      const environment = sessionEnvironment(session);
      return environment && { label: environment.status.label, os: () => environment.status.bridge?.os, ready: () => environment.ready(), openChannel: (params) => environment.openChannel(params) };
    },
    onChange: (sessionId) => panels.terminalsChanged(sessionId),
  });
  // What Loom reads from, and does on, each Session's Merge request and issue.
  const sessionForge = new SessionForge({
    session: sessionOf,
    project: (id) => projectService.list().find((p) => p.id === id),
    environment: environmentForSession,
    linkIssue: (id, issue) => sessionService.linkIssue({ id, issue }),
  });
  const adapter = options.adapter ?? new AcpAdapter(OPENCODE_ACP, options.appVersion, options.clock);
  // Usage read from the agents' own records, where they keep them (ADR 0012).
  const usageSync = await UsageSync.load({
    db,
    clock: options.clock,
    agents: adapter.usage ? [{ name: adapter.name, usage: adapter.usage }] : [],
    environment: (id) => {
      const environment = environmentById(id);
      return environment?.status.state === 'connected' ? (...args) => environment.request(...args) : undefined;
    },
    loomFolder: (environmentId, directory) => {
      const environment = environmentById(environmentId);
      if (!environment) return false;
      const path = directory.replaceAll('\\', '/').replace(/\/+$/, '');
      // Session highlights' checks' folder, and the worktrees Loom made (ADR 0012).
      if (path.endsWith('/loom-highlights')) return true;
      try {
        const root = expandRoot(forSessions(environment), settingsService.value.worktreeRoot).replaceAll('\\', '/');
        return path.startsWith(`${root}/`);
      } catch {
        return false;
      }
    },
    session: (id) => sessionService.usageFiling(id),
    onSessionUsage: (id, tokens, cost) => sessionService.addUsage(id, tokens, cost),
  });
  /** Each Session's agent and Environment, as its usage is counted. */
  const usageOf = (session: Session) => {
    const environmentId = environmentIdOf(session.projectId);
    return environmentId === undefined ? undefined : { agent: session.agent, environmentId };
  };
  const sessionService = await Sessions.load({
    db,
    clock: options.clock,
    adapter,
    project: (id) => projectService.list().find((p) => p.id === id),
    environment: (id) => {
      const environment = environmentById(id);
      return environment && forSessions(environment);
    },
    worktreeRoot: () => settingsService.value.worktreeRoot,
    onChange: (list) => {
      sessions.set(list);
      babysit?.sessionsChanged(list);
      terminals.sessionsChanged(list);
      highlights?.sessionsChanged(list);
    },
    onTurnEnded: (id, through) => highlights?.turnEnded(id, through),
    linkNamedIssue: (id, issue) => sessionForge.linkNamedIssue(id, issue),
    onNews: (id, reason) => notifications.news(id, reason),
    usage: { covers: (agent, environmentId) => usageSync.covers(agent, environmentId), changed: (agent, environmentId) => void usageSync.sync(environmentId, agent) },
    maxUntrackedCounted: options.maxUntrackedCounted,
    projectTrust: { get: (id) => projectService.trusted(id), set: (id, trusted) => projectService.setTrusted(id, trusted) },
    approvals: () => settingsService.value.approvals,
    stuckAfterMs: () => settingsService.value.stuckAfterMinutes * 60_000,
    autoPromptDefault: () => settingsService.value.autoPromptDefault,
    approvalModeDefault: () => settingsService.value.approvalModeDefault,
    attachments: new Attachments(options.userDataDir),
    // Only checking what the user picked: not worth holding the change while the Environment starts.
    models: (projectId) => {
      const environment = environmentById(environmentIdOf(projectId));
      if (!environment) return Promise.reject(new Error(`unknown Environment for Project ${projectId}`));
      return environment.status.state === 'connected' ? listModels(projectId) : Promise.reject(new Error(`${environment.status.label} is not connected`));
    },
  });
  sessions.set(sessionService.list());
  highlights = await Highlights.load({
    db,
    clock: options.clock,
    adapter,
    settings: () => settingsService.value.highlights,
    session: sessionOf,
    sessions: () => sessionService.list(),
    environment: environmentForSession,
    transcript: (id) => sessionService.transcriptItems(id),
    projectName,
    onCounts: (id, counts) => sessionService.setHighlightCounts(id, counts),
    // A check runs on the adapter's agent, whichever its Session's is.
    usage: {
      covers: (session) => {
        const key = usageOf(session);
        return !!key && usageSync.covers(adapter.name, key.environmentId);
      },
      register: async (session, conversationId) => {
        const key = usageOf(session);
        if (key) await usageSync.registerHighlights(adapter.name, key.environmentId, conversationId, session.id);
      },
      changed: (session) => {
        const key = usageOf(session);
        if (key) void usageSync.sync(key.environmentId, adapter.name);
      },
    },
  });
  const highlighter = highlights;

  babysit = await Babysit.load({
    db,
    clock: options.clock,
    sessions: sessionService,
    project: (id) => projectService.list().find((p) => p.id === id),
    call: (id) => {
      const environment = environmentById(id);
      return environment && ((...args) => environment.request(...args));
    },
  });
  const babysitter = babysit;

  void native.start();
  // A distro a Project's checkout is in is in use: its Environment starts now.
  for (const { checkout } of projectService.list()) environmentById(checkout.environmentId)?.ready().catch(() => {});

  /** Opens a Session's working copy in the user's editor or terminal, in its Environment. */
  const openInSession = (id: number, opener: Opener, file?: string) => {
    const session = sessionOf(id);
    if (!session) throw new Error(`unknown Session ${id}`);
    const environment = knownEnvironment(environmentIdOf(session.projectId));
    const { editorCommand, terminalCommand } = settingsService.value;
    return openIn(forSessions(environment), {
      opener,
      command: opener === 'editor' ? editorCommand : terminalCommand,
      workingCopy: session.workingCopy.path,
      file,
    });
  };

  const topics: { [T in Exclude<keyof Topics, keyof TopicParams>]: Topic<Topics[T]> } = { environments, projects, removedProjects, settings, sessions, database, openSession, update: updates.status };
  const paramTopics: { [T in keyof TopicParams]: (params: TopicParams[T], listener: (value: Topics[T]) => void) => () => void } = {
    transcript: ({ sessionId }, listener) => sessionService.subscribeTranscript(sessionId, listener),
    panels: ({ sessionId }, listener) => panels.subscribe(sessionId, listener),
    highlights: ({ sessionId }, listener) => highlighter.subscribe(sessionId, listener),
    reviewThreads: ({ sessionId }, listener) => babysitter.subscribeThreads(sessionId, listener),
    terminals: ({ sessionId }, listener) => terminals.subscribeList(sessionId, listener),
    terminalOutput: ({ id }, listener) => terminals.subscribeOutput(id, listener),
    subagents: ({ sessionId }, listener) => sessionService.subscribeSubagents(sessionId, listener),
    subagentTranscript: ({ sessionId, subagentId }, listener) => sessionService.subscribeSubagentTranscript(sessionId, subagentId, listener),
  };
  const commands: { [C in keyof Commands]: (params: Commands[C]['params']) => Commands[C]['result'] | Promise<Commands[C]['result']> } = {
    'environments.list': () => environments.value,
    'environments.detect': async () => {
      await listDistros();
      await Promise.all([...envs.values()].map((e) => e.detectAgent()));
    },
    'environments.start': async ({ id }) => {
      const environment = knownEnvironment(id);
      if (environment.status.state === 'connected') return environment.detectAgent();
      await environment.restart();
      await environment.ready();
    },
    'environments.reload': async ({ id }) => {
      await knownEnvironment(id).reload();
      await projectService.checkForges(id);
    },
    'links.open': async ({ url }) => {
      if (!isWebLink(url)) throw new Error('Loom only opens web links.');
      await options.openExternal(url);
    },
    'dialogs.chooseFolder': () => (options.chooseFolder ? options.chooseFolder() : null),
    'projects.list': () => projects.value,
    'projects.link': async (params) => {
      await startedToLink(params.environmentId);
      return projectService.link(params);
    },
    'projects.restorable': async (params) => {
      await startedToLink(params.environmentId);
      return projectService.restorable(params);
    },
    'projects.remove': async ({ id, discard }) => {
      return sessionService.removeProject(id, discard ?? false, () => projectService.remove(id));
    },
    'projects.setBranchPrefix': ({ id, branchPrefix }) => projectService.setBranchPrefix(id, branchPrefix),
    'projects.edit': (params) => projectService.edit(params),
    'projects.issues': ({ id, search }) => projectService.issues(id, search),
    'projects.branches': ({ id }) => sessionService.branches(id),
    'projects.check': () => projectService.checkForges(),
    'projects.models': ({ id }) => listModels(id),
    'projects.commands': ({ id, fresh }) => listCommands(id, fresh),
    'projects.files': ({ id, ref }) => sessionService.projectFiles(id, ref),
    'sessions.check': async () => {
      await Promise.all(environments.value.map((e) => sessionService.lookUpBranches(e.id)));
      babysitter.pollAll();
    },
    'settings.setWorktreeRoot': ({ worktreeRoot }) => settingsService.setWorktreeRoot(worktreeRoot),
    'settings.setEditorCommand': ({ editorCommand }) => settingsService.setEditorCommand(editorCommand),
    'settings.setTerminalCommand': ({ terminalCommand }) => settingsService.setTerminalCommand(terminalCommand),
    'settings.setStuckAfterMinutes': ({ minutes }) => settingsService.setStuckAfterMinutes(minutes),
    'settings.setAutoPromptDefault': ({ on }) => settingsService.setAutoPromptDefault(on),
    'settings.setApprovalModeDefault': ({ mode }) => settingsService.setApprovalModeDefault(mode),
    'settings.setDiffCollapsedPatterns': ({ patterns }) => settingsService.setDiffCollapsedPatterns(patterns),
    'settings.setAppearance': (appearance) => settingsService.setAppearance(appearance),
    'settings.setPanelSize': ({ kind, dimension, size }) => settingsService.setPanelSize(kind, dimension, size),
    'settings.setPanelPlace': ({ kind, area, stack }) => settingsService.setPanelPlace(kind, area, stack),
    'settings.setInbox': (inbox) => settingsService.setInbox(inbox),
    'settings.setDiffView': (diffView) => settingsService.setDiffView(diffView),
    'settings.setHighlights': (value) => settingsService.setHighlights(value),
    'settings.setApproval': ({ category, setting }) => settingsService.setApproval(category, setting),
    'settings.setNotification': ({ kind, on }) => settingsService.setNotification(kind, on),
    'settings.setKeybinding': ({ name, shortcut }) => settingsService.setKeybinding(name, shortcut),
    'settings.setSingleKeyShortcuts': ({ on }) => settingsService.setSingleKeyShortcuts(on),
    'settings.resetKeybindings': () => settingsService.resetKeybindings(),
    'settings.setDateFormat': (dates) => settingsService.setDateFormat(dates),
    'settings.systemLocale': () => options.systemLocale || ownLocale(),
    'window.showing': ({ sessionId }) => {
      if (sessionId !== null && typeof sessionId !== 'number') throw new Error('The Session shown is a Session id, or null for none.');
      showing = sessionId;
    },
    'sessions.list': () => sessions.value,
    'sessions.create': (params) => sessionService.create(params),
    'sessions.diffBases': ({ id }) => sessionService.diffBases(id),
    'sessions.setDiffBase': ({ id, base }) => sessionService.setDiffBase(id, base),
    'sessions.send': (params) => sessionService.send(params),
    'sessions.files': ({ id }) => sessionService.files(id),
    'sessions.stop': (params) => sessionService.stop(params),
    'sessions.stopSubagent': (params) => sessionService.stopSubagent(params),
    'sessions.removeQueued': (params) => sessionService.removeQueued(params),
    'sessions.editQueued': (params) => sessionService.editQueued(params),
    'sessions.sendNow': (params) => sessionService.sendNow(params),
    'sessions.steer': (params) => sessionService.steer(params),
    'sessions.setModel': (params) => sessionService.setModel(params),
    'sessions.archive': (params) => sessionService.archive(params),
    'sessions.unarchive': (params) => sessionService.unarchive(params),
    'sessions.delete': (params) => sessionService.delete(params),
    'sessions.unsavedWork': (params) => sessionService.unsavedWork(params),
    'sessions.requestMergeRequest': (params) => sessionService.requestMergeRequest(params),
    'sessions.linkMergeRequest': (params) => sessionService.linkMergeRequest(params),
    'sessions.mergeRequest': (params) => sessionForge.mergeRequest(params),
    'sessions.mergeRequestDiff': (params) => sessionForge.mergeRequestDiff(params),
    'sessions.squashAndMerge': async (params) => {
      const result = await sessionForge.squashAndMerge(params);
      // Babysit archives the Session once it sees it merged, so it looks now; without Babysit, the merge is just recorded.
      if (!babysitter.pollNow(params.id) && result.state && result.state !== 'open') sessionService.setMergeRequestState(params.id, result.state);
      return result;
    },
    // Babysit reads the Merge request again, so that its notes show the reply, or go once resolved.
    'sessions.replyToReviewThread': async (params) => {
      await sessionForge.replyToReviewThread(params);
      babysitter.pollNow(params.id);
    },
    'sessions.resolveReviewThread': async (params) => {
      await sessionForge.resolveReviewThread(params);
      babysitter.pollNow(params.id);
    },
    'sessions.sendFeedback': (params) => sessionService.sendFeedback(params),
    'sessions.setAutoPrompt': (params) => sessionService.setAutoPrompt(params),
    'sessions.setBabysitting': (params) => sessionService.setBabysitting(params),
    'sessions.setUnread': (params) => sessionService.setUnread(params),
    'sessions.snooze': (params) => sessionService.snooze(params),
    'sessions.rename': (params) => sessionService.rename(params),
    'sessions.searchConversations': async ({ words }) => {
      if (!Array.isArray(words)) throw new Error('A search needs the words to look for.');
      // Searches the conversations as written so far, of the Sessions Loom has.
      await sessionService.flush();
      return searchConversations(db, new Set(sessionService.list().map((s) => s.id)), words);
    },
    'sessions.linkIssue': (params) => sessionService.linkIssue(params),
    'sessions.unlinkIssue': (params) => sessionService.unlinkIssue(params),
    'sessions.issue': (params) => sessionForge.issue(params),
    'sessions.setPanels': async ({ id, panels: state }) => {
      if (!sessionService.list().some((s) => s.id === id)) throw new Error(`unknown Session ${id}`);
      // Kept in the Layout a move asked for just before, not the one it replaces.
      await settingsService.layoutKept();
      return panels.set(id, state);
    },
    'sessions.resolveHighlight': (params) => highlighter.resolve(params),
    'sessions.seeHighlights': (params) => highlighter.see(params),
    'sessions.openInEditor': ({ id, file }) => openInSession(id, 'editor', file),
    'sessions.openInTerminal': ({ id }) => openInSession(id, 'terminal'),
    'terminals.open': (params) => terminals.open(params),
    'terminals.write': ({ id, data }) => terminals.write(id, data),
    'terminals.resize': ({ id, cols, rows }) => terminals.resize(id, { cols, rows }),
    'terminals.ack': ({ id, bytes }) => terminals.ack(id, bytes),
    'terminals.close': ({ id }) => terminals.close(id),
    'sessions.diff': ({ id, scope }) => sessionService.diff(id, scope),
    'sessions.diffFingerprint': ({ id }) => sessionService.diffFingerprint(id),
    'sessions.diffFile': ({ id, path, scope }) => sessionService.diffFile(id, path, scope),
    'sessions.retry': (params) => sessionService.retry(params),
    'sessions.continue': (params) => sessionService.continue(params),
    'sessions.answer': (params) => sessionService.answer(params),
    'sessions.trust': (params) => sessionService.trust(params),
    'sessions.approve': (params) => sessionService.approve(params),
    'usage.dashboard': async ({ days }) => {
      // What the agents' records hold now counts, as far as they can be read in a moment.
      let timer: unknown;
      await Promise.race([Promise.all([...envs.keys()].map((id) => usageSync.sync(id))), new Promise<void>((resolve) => (timer = options.clock.setTimeout(resolve, DASHBOARD_SYNC_MS)))]);
      options.clock.clearTimeout(timer);
      // What the Sessions have recorded so far counts.
      await sessionService.flush();
      const data = await dashboard(db, days, options.clock.now());
      return usageSync.countingPast() ? { ...data, countingPast: true } : data;
    },
    'update.status': () => updates.status.value,
    'update.restart': () => updates.restart(),
    'feedback.send': (feedback) => sendFeedback(options, feedback),
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
      updates.stop();
      await babysitter.stop();
      await highlighter.stop();
      await terminals.closeAll();
      sessionForge.stop();
      await sessionService.shutdown();
      await usageSync.stop();
      await Promise.all([...envs.values()].map((e) => e.stop()));
      await db.destroy();
    },
  };
}

/** The native Environment's id; a WSL distro's is `wsl:<distro>`. */
const NATIVE = 'native';
const WSL_PREFIX = 'wsl:';
/** Listing WSL's distros; wsl.exe hangs when WSL is wedged, which the bridge bounds at 20 s. */
const WSL_LIST_TIMEOUT_MS = 30_000;
/** Installing a distro's bridge, which may have to boot the distro first. */
const WSL_INSTALL_TIMEOUT_MS = 120_000;

/**
 * What a WSL distro's bridge, started through wsl.exe, runs with: wsl.exe's
 * own messages in UTF-8, and the bridge's error reporting settings passed
 * into the distro, where Windows' environment isn't.
 */
function wslEnv(): Record<string, string> {
  const shared = ['LOOM_BRIDGE_SENTRY_DSN', 'LOOM_SENTRY_RELEASE', 'LOOM_SENTRY_ENVIRONMENT'].filter((name) => process.env[name]).map((name) => `${name}/u`);
  return { WSL_UTF8: '1', WSLENV: [process.env.WSLENV, ...shared].filter(Boolean).join(':') };
}

/**
 * The Environment's temp directory: `/tmp`, or on native Windows `%TEMP%`,
 * which the bridge doesn't report, so its usual place under the home.
 */
function tempDirOf(os: string | undefined, home: string | undefined): string {
  if (os === 'windows' && home) return `${home.replaceAll('\\', '/')}/AppData/Local/Temp`;
  return '/tmp';
}
