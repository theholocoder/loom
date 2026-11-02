import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LoomApi, TopicArgs, TopicName, Topics } from '../shared/api';

const ApiContext = createContext<LoomApi | null>(null);

/** Gives the UI its connection to main: the preload's `window.loom`, or a fake in tests. */
export function ApiProvider({ api, children }: { api: LoomApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): LoomApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi needs an ApiProvider');
  return api;
}

/** The current value of a main topic, kept up to date. */
export function useTopic<T extends TopicName>(topic: T, ...params: TopicArgs<T>): Topics[T] | undefined {
  const api = useApi();
  const [value, setValue] = useState<{ key: string; value: Topics[T] }>();
  const key = JSON.stringify([topic, params]);
  useEffect(
    () => api.subscribe(topic, (value) => setValue({ key, value }), ...params),
    // params are compared by value, through key.
    [api, key],
  );
  // A value from before the params changed belongs to the other subscription.
  return value?.key === key ? value.value : undefined;
}
