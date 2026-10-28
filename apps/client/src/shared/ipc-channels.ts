// The Electron IPC channels that carry the LoomApi between preload and main.
export const IPC = {
  invoke: 'loom:invoke',
  subscribe: 'loom:subscribe',
  unsubscribe: 'loom:unsubscribe',
  topic: 'loom:topic',
} as const;
