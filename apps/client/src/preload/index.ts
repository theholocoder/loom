// Exposes the LoomApi to the renderer as `window.loom`, carried over IPC.
import { contextBridge, ipcRenderer } from 'electron';
import type { LoomApi } from '../shared/api';
import { IPC } from '../shared/ipc-channels';

const listeners = new Map<number, (value: unknown) => void>();
let nextSubscription = 1;

ipcRenderer.on(IPC.topic, (_event, subscription: number, value: unknown) => {
  listeners.get(subscription)?.(value);
});

const api: LoomApi = {
  invoke: (command, ...params) => ipcRenderer.invoke(IPC.invoke, command, params[0]),
  subscribe: (topic, listener) => {
    const subscription = nextSubscription++;
    listeners.set(subscription, listener as (value: unknown) => void);
    ipcRenderer.send(IPC.subscribe, subscription, topic);
    return () => {
      listeners.delete(subscription);
      ipcRenderer.send(IPC.unsubscribe, subscription);
    };
  },
};

contextBridge.exposeInMainWorld('loom', api);
