// Seam B: a fake main implementing the same typed API the real one does, so
// renderer tests control exactly what main reports.
import type { CommandName, Commands, LoomApi, TopicName, Topics } from '../../src/shared/api';

type Handlers = { [C in CommandName]: (params: Commands[C]['params']) => Commands[C]['result'] | Promise<Commands[C]['result']> };

export class FakeMain implements LoomApi {
  private values: Topics;
  private listeners: Partial<Record<TopicName, Set<(value: never) => void>>> = {};
  readonly invoked: Array<{ command: CommandName; params: unknown }> = [];
  private handlers: Handlers;

  /** `handlers` replaces what the given commands do; the rest do nothing. */
  constructor(initial: Partial<Topics> = {}, handlers: Partial<Handlers> = {}) {
    this.values = { environments: [], projects: [], ...initial };
    this.handlers = {
      'environments.list': () => this.values.environments,
      'environments.detect': () => {},
      'environments.reload': () => {},
      'dialogs.chooseFolder': () => null,
      'projects.list': () => this.values.projects,
      'projects.link': () => {
        throw new Error('projects.link is not scripted');
      },
      'projects.setBranchPrefix': ({ id }) => this.values.projects.find((p) => p.id === id)!,
      'projects.check': () => {},
      ...handlers,
    };
  }

  /** Publishes a new value on `topic`, as main does when its state changes. */
  publish<T extends TopicName>(topic: T, value: Topics[T]): void {
    this.values[topic] = value;
    for (const listener of this.listeners[topic] ?? []) (listener as (value: Topics[T]) => void)(value);
  }

  invoke: LoomApi['invoke'] = async (command, ...params) => {
    this.invoked.push({ command, params: params[0] });
    return this.handlers[command](params[0] as never) as never;
  };

  subscribe: LoomApi['subscribe'] = (topic, listener) => {
    const set = (this.listeners[topic] ??= new Set()) as unknown as Set<typeof listener>;
    set.add(listener);
    listener(this.values[topic]);
    return () => set.delete(listener);
  };
}
