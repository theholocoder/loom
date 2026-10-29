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
  invoke: (command, ...params) =>
    ipcRenderer.invoke(IPC.invoke, command, params[0]).catch((error: Error) => {
      // Electron prefixes main's message with "Error invoking remote method …: Error: ".
      throw new Error(error.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''));
    }),
  subscribe: (topic, listener, ...params) => {
    const subscription = nextSubscription++;
    listeners.set(subscription, listener as (value: unknown) => void);
    ipcRenderer.send(IPC.subscribe, subscription, topic, params[0]);
    return () => {
      listeners.delete(subscription);
      ipcRenderer.send(IPC.unsubscribe, subscription);
    };
  },
};

contextBridge.exposeInMainWorld('loom', api);
