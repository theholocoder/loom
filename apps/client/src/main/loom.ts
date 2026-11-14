// Main's core, with no Electron in it: the Electron entry point and seam A
// tests both build main through createLoom and talk to it only through `api`.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Commands, DatabaseStatus, EnvironmentStatus, LoomApi, OpenSessionRequest, Project, RemovedProject, Session, Settings as SettingsValues, TopicParams, Topics } from '../shared/api';
import type { AgentAdapter } from './agents/adapter';
import { AcpAdapter } from './agents/acp-adapter';
import { OPENCODE_ACP } from './agents/opencode';
import type { Clock } from './clock';
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
import { checkWorktreeRootFolder } from './sessions/working-copies';
import { Settings } from './settings';
import { DATABASE_FILE, DatabaseDamagedError, openDatabase, type LoomDatabase } from './storage/database';
import { listSnapshots, restoreLatestSnapshot } from './storage/snapshots';
import { Topic } from './topic';
import { dashboard } from './usage/usage';
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
  let babysit: Babysit | undefined;
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
        // Babysit asks the Forge, so its first polls wait for that check.
        void projectService.checkForges(status.id).catch(() => {}).then(() => babysit?.pollAll());
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
  const removedProjects = new Topic<RemovedProject[]>([]);
  const projectService = await Projects.load({
    db,
    clock: options.clock,
    environment: (id) => (id === native.status.id ? { label: native.status.label, connected: () => native.status.state === 'connected', request: (...args) => native.request(...args) } : undefined),
    onChange: (list) => projects.set(list),
    onRemovedChange: (list) => removedProjects.set(list),
  });
  projects.set(projectService.list());
  removedProjects.set(projectService.listRemoved());

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
    { checkWorktreeRootFolder: (root) => (native.status.state === 'connected' ? checkWorktreeRootFolder(nativeForSessions, root) : Promise.resolve()) },
  );
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
  /** The Project's checkout, once its Environment is up. */
  const readyCheckout = async (projectId: number) => {
    const checkout = projectService.list().find((p) => p.id === projectId)?.checkout;
    if (!checkout) throw new Error(`unknown Project ${projectId}`);
    if (checkout.environmentId !== native.status.id) throw new Error(`unknown Environment "${checkout.environmentId}"`);
    await native.ready();
    return checkout.path;
  };
  /** The models the agent offers in the Project's checkout, once its Environment is up. */
  const listModels = async (projectId: number) => native.listModels(await readyCheckout(projectId));
  /** The commands and skills the agent offers in the Project's checkout, once its Environment is up. */
  const listCommands = async (projectId: number) => native.listCommands(await readyCheckout(projectId));
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
  const environmentForSession = (session: Session) => (environmentIdOf(session.projectId) === native.status.id ? nativeForSessions : undefined);
  /** The Environment a Session runs in, if Loom has it. */
  const sessionEnvironment = (session: Session) => (environmentIdOf(session.projectId) === native.status.id ? native : undefined);
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
  const adapter = options.adapter ?? new AcpAdapter(OPENCODE_ACP, options.appVersion);
  const sessionService = await Sessions.load({
    db,
    clock: options.clock,
    adapter,
    project: (id) => projectService.list().find((p) => p.id === id),
    environment: (id) => (id === native.status.id ? nativeForSessions : undefined),
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
    maxUntrackedCounted: options.maxUntrackedCounted,
    projectTrust: { get: (id) => projectService.trusted(id), set: (id, trusted) => projectService.setTrusted(id, trusted) },
    approvals: () => settingsService.value.approvals,
    stuckAfterMs: () => settingsService.value.stuckAfterMinutes * 60_000,
    autoPromptDefault: () => settingsService.value.autoPromptDefault,
    approvalModeDefault: () => settingsService.value.approvalModeDefault,
    attachments: new Attachments(options.userDataDir),
    // Only checking what the user picked: not worth holding the change while the Environment starts.
    models: (projectId) => (native.status.state === 'connected' ? listModels(projectId) : Promise.reject(new Error(`${native.status.label} is not connected`))),
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
  });
  const highlighter = highlights;

  babysit = await Babysit.load({
    db,
    clock: options.clock,
    sessions: sessionService,
    project: (id) => projectService.list().find((p) => p.id === id),
    call: (id) => (id === native.status.id ? (...args) => native.request(...args) : undefined),
  });
  const babysitter = babysit;

  void native.start();

  /** Opens a Session's working copy in the user's editor or terminal, in its Environment. */
  const openInSession = (id: number, opener: Opener, file?: string) => {
    const session = sessionOf(id);
    if (!session) throw new Error(`unknown Session ${id}`);
    const environmentId = environmentIdOf(session.projectId);
    if (environmentId !== native.status.id) throw new Error(`unknown Environment "${environmentId}"`);
    const { editorCommand, terminalCommand } = settingsService.value;
    return openIn(nativeForSessions, {
      opener,
      command: opener === 'editor' ? editorCommand : terminalCommand,
      workingCopy: session.workingCopy.path,
      file,
    });
  };

  const topics: { [T in Exclude<keyof Topics, keyof TopicParams>]: Topic<Topics[T]> } = { environments, projects, removedProjects, settings, sessions, database, openSession };
  const paramTopics: { [T in keyof TopicParams]: (params: TopicParams[T], listener: (value: Topics[T]) => void) => () => void } = {
    transcript: ({ sessionId }, listener) => sessionService.subscribeTranscript(sessionId, listener),
    panels: ({ sessionId }, listener) => panels.subscribe(sessionId, listener),
    highlights: ({ sessionId }, listener) => highlighter.subscribe(sessionId, listener),
    terminals: ({ sessionId }, listener) => terminals.subscribeList(sessionId, listener),
    terminalOutput: ({ id }, listener) => terminals.subscribeOutput(id, listener),
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
    'projects.restorable': (params) => projectService.restorable(params),
    'projects.remove': async ({ id, discard }) => {
      return sessionService.removeProject(id, discard ?? false, () => projectService.remove(id));
    },
    'projects.setBranchPrefix': ({ id, branchPrefix }) => projectService.setBranchPrefix(id, branchPrefix),
    'projects.edit': (params) => projectService.edit(params),
    'projects.issues': ({ id, search }) => projectService.issues(id, search),
    'projects.branches': ({ id }) => sessionService.branches(id),
    'projects.check': () => projectService.checkForges(),
    'projects.models': ({ id }) => listModels(id),
    'projects.commands': ({ id }) => listCommands(id),
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
      // What the Sessions have recorded so far counts.
      await sessionService.flush();
      return dashboard(db, days, options.clock.now());
    },
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
      await babysitter.stop();
      await highlighter.stop();
      await terminals.closeAll();
      sessionForge.stop();
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
