// Seam B: a fake main implementing the same typed API the real one does, so
// renderer tests control exactly what main reports.
import type { CommandName, Commands, LoomApi, TopicName, Topics } from '../../src/shared/api';

type Handlers = { [C in CommandName]: (params: Commands[C]['params']) => Commands[C]['result'] };

export class FakeMain implements LoomApi {
  private values: Topics;
  private listeners: { [T in TopicName]?: Set<(value: Topics[T]) => void> } = {};
  readonly invoked: Array<{ command: CommandName; params: unknown }> = [];
  private handlers: Handlers;

  constructor(initial: Partial<Topics> = {}) {
    this.values = { environments: [], ...initial };
    this.handlers = {
      'environments.list': () => this.values.environments,
    };
  }

  /** Publishes a new value on `topic`, as main does when its state changes. */
  publish<T extends TopicName>(topic: T, value: Topics[T]): void {
    this.values[topic] = value;
    for (const listener of this.listeners[topic] ?? []) listener(value);
  }

  invoke: LoomApi['invoke'] = async (command, ...params) => {
    this.invoked.push({ command, params: params[0] });
    return this.handlers[command](params[0] as never) as never;
  };

  subscribe: LoomApi['subscribe'] = (topic, listener) => {
    const set = (this.listeners[topic] ??= new Set()) as Set<typeof listener>;
    set.add(listener);
    listener(this.values[topic]);
    return () => set.delete(listener);
  };
}
