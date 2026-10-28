import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LoomApi, TopicName, Topics } from '../shared/api';

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
export function useTopic<T extends TopicName>(topic: T): Topics[T] | undefined {
  const api = useApi();
  const [value, setValue] = useState<Topics[T]>();
  useEffect(() => api.subscribe(topic, setValue), [api, topic]);
  return value;
}
