// Seam B: a fake main implementing the same typed API the real one does, so
// renderer tests control exactly what main reports.
import { DEFAULT_SETTINGS, type CommandName, Commands, LoomApi, TopicArgs, TopicName, Topics, type UsageDashboard, type UsageRange } from '../../src/shared/api';
import { clampPanelSize, DEFAULT_SESSION_PANELS, type SessionPanels } from '../../src/shared/panels';
import { clampInboxWidth } from '../../src/shared/window';

/** A dashboard with nothing recorded, over `days` days ending 5 November 2026. */
export function emptyDashboard(days: UsageRange): UsageDashboard {
  const perDay = Array.from({ length: days }, (_, i) => {
    const day = new Date(2026, 10, 5 - (days - 1 - i));
    return { day: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`, tokens: 0, byProject: {} };
  });
  return {
    days,
    perDay,
    tokens: 0,
    reportedCost: 0,
    sessionsStarted: 0,
    mergeRequestsMerged: 0,
    perProject: [],
    perModel: [],
    mix: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    outcomes: { merged: 0, closed: 0, archived: 0, open: 0, stuck: 0 },
    topSessions: [],
  };
}

/** A Session's Panels with both areas hidden: Changes open in the Side area, but not shown. */
export const HIDDEN_PANELS: SessionPanels = { side: { panels: ['changes'], shown: 'changes', open: false }, dock: { panels: [], shown: null, open: false } };

type Handlers = { [C in CommandName]: (params: Commands[C]['params']) => Commands[C]['result'] | Promise<Commands[C]['result']> };

/** Topics that need no parameters, which the constructor can seed. */
type PlainTopics = Pick<Topics, 'environments' | 'projects' | 'removedProjects' | 'settings' | 'sessions' | 'database'>;

const EMPTY: { [T in TopicName]: Topics[T] } = {
  environments: [],
  projects: [],
  removedProjects: [],
  settings: DEFAULT_SETTINGS,
  sessions: [],
  transcript: [],
  panels: DEFAULT_SESSION_PANELS,
  highlights: { highlights: [], seenThrough: 0, checking: false },
  terminals: [],
  terminalOutput: { data: new Uint8Array() },
  database: { state: 'ok' },
};

export class FakeMain implements LoomApi {
  /** Each topic's value, by topic and parameters. */
  private values = new Map<string, unknown>();
  private listeners = new Map<string, Set<(value: never) => void>>();
  readonly invoked: Array<{ command: CommandName; params: unknown }> = [];
  private handlers: Handlers;

  /** `handlers` replaces what the given commands do; the rest do nothing. */
  constructor(initial: Partial<PlainTopics> = {}, handlers: Partial<Handlers> = {}) {
    for (const [topic, value] of Object.entries(initial)) this.values.set(key(topic as TopicName, []), value);
    this.handlers = {
      'environments.list': () => this.value('environments'),
      'environments.detect': () => {},
      'environments.reload': () => {},
      'links.open': () => {},
      'dialogs.chooseFolder': () => null,
      'projects.list': () => this.value('projects'),
      'projects.link': () => {
        throw new Error('projects.link is not scripted');
      },
      'projects.restorable': () => null,
      'projects.remove': () => ({ removed: true }),
      'projects.setBranchPrefix': ({ id }) => this.value('projects').find((p) => p.id === id)!,
      'projects.issues': () => [],
      'projects.branches': () => ({ defaultBranch: 'main', remote: ['main'], existing: [], worktrees: [] }),
      'projects.check': () => {},
      'projects.models': () => [],
      'projects.commands': () => [],
      'projects.files': () => [],
      'sessions.files': () => [],
      'sessions.check': () => {},
      'sessions.linkIssue': () => {},
      'settings.setWorktreeRoot': ({ worktreeRoot }) => {
        const settings = { ...this.value('settings'), worktreeRoot };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setEditorCommand': ({ editorCommand }) => {
        const settings = { ...this.value('settings'), editorCommand };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setTerminalCommand': ({ terminalCommand }) => {
        const settings = { ...this.value('settings'), terminalCommand };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setStuckAfterMinutes': ({ minutes }) => {
        const settings = { ...this.value('settings'), stuckAfterMinutes: minutes };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setAutoPromptDefault': ({ on }) => {
        const settings = { ...this.value('settings'), autoPromptDefault: on };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setApprovalModeDefault': ({ mode }) => {
        const settings = { ...this.value('settings'), approvalModeDefault: mode };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setDiffCollapsedPatterns': ({ patterns }) => {
        const settings = { ...this.value('settings'), diffCollapsedPatterns: patterns };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setAppearance': (appearance) => {
        const settings = { ...this.value('settings'), ...appearance };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setHighlights': (highlights) => {
        if (highlights.on && !highlights.model) throw new Error('Pick the model that checks Sessions for highlights before turning it on.');
        const settings = { ...this.value('settings'), highlights };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setDiffView': (diffView) => {
        const settings = { ...this.value('settings'), diffView };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setPanelSize': ({ kind, dimension, size }) => {
        const current = this.value('settings');
        const { layout } = current;
        const settings = { ...current, layout: { ...layout, [dimension]: { ...layout[dimension], [kind]: clampPanelSize(kind, dimension, size) } } };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setPanelArea': ({ kind, area }) => {
        const current = this.value('settings');
        const settings = { ...current, layout: { ...current.layout, area: { ...current.layout.area, [kind]: area } } };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setInbox': ({ width, open }) => {
        const current = this.value('settings');
        const settings = { ...current, inbox: { width: width === undefined ? current.inbox.width : clampInboxWidth(width), open: open ?? current.inbox.open } };
        this.publish('settings', settings);
        return settings;
      },
      'settings.setApproval': ({ category, setting }) => {
        const current = this.value('settings');
        const settings = { ...current, approvals: { ...current.approvals, [category]: setting } };
        this.publish('settings', settings);
        return settings;
      },
      'sessions.list': () => this.value('sessions'),
      'sessions.create': () => {
        throw new Error('sessions.create is not scripted');
      },
      'sessions.send': () => {},
      'sessions.stop': () => {},
      'sessions.removeQueued': () => {},
      'sessions.sendNow': () => {},
      'sessions.steer': () => {},
      'sessions.setModel': () => {},
      'sessions.archive': () => ({ archived: true }),
      'sessions.delete': () => ({ deleted: true }),
      'sessions.requestMergeRequest': () => {},
      'sessions.linkMergeRequest': () => {},
      'sessions.mergeRequest': () => {
        throw new Error('sessions.mergeRequest is not scripted');
      },
      'sessions.mergeRequestDiff': () => {
        throw new Error('sessions.mergeRequestDiff is not scripted');
      },
      'sessions.squashAndMerge': () => {
        throw new Error('sessions.squashAndMerge is not scripted');
      },
      'sessions.replyToReviewThread': () => {},
      'sessions.resolveReviewThread': () => {},
      'sessions.sendFeedback': () => {},
      'sessions.setAutoPrompt': () => {},
      'sessions.setBabysitting': () => {},
      'sessions.setUnread': () => {},
      'sessions.snooze': () => {},
      'sessions.rename': () => {},
      'sessions.setPanels': ({ id, panels }) => this.publish('panels', panels, { sessionId: id }),
      'sessions.resolveHighlight': () => {},
      'sessions.seeHighlights': () => {},
      'sessions.openInEditor': () => {},
      'sessions.openInTerminal': () => {},
      'terminals.open': () => {
        throw new Error('terminals.open is not scripted');
      },
      'terminals.write': () => {},
      'terminals.resize': () => {},
      'terminals.ack': () => {},
      'terminals.close': () => {},
      'sessions.diff': () => ({ available: false, reason: 'No diff available' }),
      'sessions.diffFile': () => ({ text: '', truncated: false }),
      'sessions.diffFingerprint': () => '',
      'sessions.diffBases': () => [],
      'sessions.setDiffBase': () => {},
      'sessions.retry': () => {},
      'sessions.continue': () => {},
      'sessions.answer': () => {},
      'sessions.trust': () => {},
      'sessions.approve': () => {},
      'usage.dashboard': ({ days }) => emptyDashboard(days),
      'database.restoreLatestSnapshot': () => {},
      ...handlers,
    };
  }

  /** The topic's current value. */
  value<T extends TopicName>(topic: T, ...params: TopicArgs<T>): Topics[T] {
    const k = key(topic, params);
    return (this.values.has(k) ? this.values.get(k) : EMPTY[topic]) as Topics[T];
  }

  /** Publishes a new value on `topic`, as main does when its state changes. */
  publish<T extends TopicName>(topic: T, value: Topics[T], ...params: TopicArgs<T>): void {
    const k = key(topic, params);
    this.values.set(k, value);
    for (const listener of this.listeners.get(k) ?? []) (listener as (value: Topics[T]) => void)(value);
  }

  invoke: LoomApi['invoke'] = async (command, ...params) => {
    this.invoked.push({ command, params: params[0] });
    return this.handlers[command](params[0] as never) as never;
  };

  subscribe: LoomApi['subscribe'] = (topic, listener, ...params) => {
    const k = key(topic, params);
    let set = this.listeners.get(k);
    if (!set) this.listeners.set(k, (set = new Set()));
    const typed = set as unknown as Set<typeof listener>;
    typed.add(listener);
    listener(this.value(topic, ...params));
    return () => typed.delete(listener);
  };
}

function key(topic: TopicName, params: unknown[]): string {
  return JSON.stringify([topic, ...params]);
}
