import { ipcMain, type WebContents } from 'electron';
import type { CommandName, LoomApi, TopicName, Unsubscribe } from '../shared/api';
import { IPC } from '../shared/ipc-channels';

/** Serves `api` to every renderer over IPC. */
export function serveApi(api: LoomApi): void {
  ipcMain.handle(IPC.invoke, (_event, command: CommandName, params: unknown) =>
    (api.invoke as (command: CommandName, params?: unknown) => Promise<unknown>)(command, params),
  );

  const subscriptions = new Map<WebContents, Map<number, Unsubscribe>>();
  ipcMain.on(IPC.subscribe, (event, subscription: number, topic: TopicName) => {
    const sender = event.sender;
    let forSender = subscriptions.get(sender);
    if (!forSender) {
      const created = new Map<number, Unsubscribe>();
      subscriptions.set(sender, created);
      sender.once('destroyed', () => {
        for (const unsubscribe of created.values()) unsubscribe();
        subscriptions.delete(sender);
      });
      forSender = created;
    }
    try {
      forSender.set(
        subscription,
        api.subscribe(topic, (value) => {
          if (!sender.isDestroyed()) sender.send(IPC.topic, subscription, value);
        }),
      );
    } catch (error) {
      console.error(`renderer subscription to "${topic}" refused:`, error);
    }
  });
  ipcMain.on(IPC.unsubscribe, (event, subscription: number) => {
    const forSender = subscriptions.get(event.sender);
    forSender?.get(subscription)?.();
    forSender?.delete(subscription);
  });
}
