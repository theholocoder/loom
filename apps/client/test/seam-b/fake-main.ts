// Seam B: a fake main implementing the same typed API the real one does, so
// renderer tests control exactly what main reports.
import type { CommandName, Commands, LoomApi, TopicArgs, TopicName, Topics } from '../../src/shared/api';

type Handlers = { [C in CommandName]: (params: Commands[C]['params']) => Commands[C]['result'] | Promise<Commands[C]['result']> };

/** Topics that need no parameters, which the constructor can seed. */
type PlainTopics = Pick<Topics, 'environments' | 'projects' | 'sessions'>;

const EMPTY: { [T in TopicName]: Topics[T] } = { environments: [], projects: [], sessions: [], transcript: [] };

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
      'dialogs.chooseFolder': () => null,
      'projects.list': () => this.value('projects'),
      'projects.link': () => {
        throw new Error('projects.link is not scripted');
      },
      'projects.setBranchPrefix': ({ id }) => this.value('projects').find((p) => p.id === id)!,
      'projects.check': () => {},
      'sessions.list': () => this.value('sessions'),
      'sessions.create': () => {
        throw new Error('sessions.create is not scripted');
      },
      'sessions.send': () => {},
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
