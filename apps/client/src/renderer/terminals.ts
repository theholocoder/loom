// The screens of the open terminals, kept for as long as their terminals
// run: the dock shows one at a time, and a Session not shown keeps its
// terminals going, still taking in what they print.
import type { LoomApi, TerminalInfo } from '../shared/api';
import { createTerminalScreen, type TerminalScreen } from './terminal-screen';

interface Kept {
  screen: TerminalScreen;
  sessionId: number;
  /** The size main last heard of. */
  size?: { cols: number; rows: number };
  stop: () => void;
}

/** Each main's terminals' screens, by terminal id. */
const kept = new WeakMap<LoomApi, Map<number, Kept>>();
/** Each main's subscriptions to a Session's terminals, while it has screens. */
const watching = new WeakMap<LoomApi, Map<number, () => void>>();

/** The screen of `terminal`, made the first time it is asked for. */
export function terminalScreen(api: LoomApi, terminal: TerminalInfo): TerminalScreen {
  let screens = kept.get(api);
  if (!screens) kept.set(api, (screens = new Map()));
  const existing = screens.get(terminal.id);
  if (existing) return existing.screen;

  const { id, sessionId } = terminal;
  const screen = createTerminalScreen({
    openLink: (url) => void api.invoke('links.open', { url }).catch((error: unknown) => console.error('could not open the link:', error)),
  });
  screen.onInput((data) => void api.invoke('terminals.write', { id, data }).catch(() => {}));
  const stop = api.subscribe(
    'terminalOutput',
    ({ data }) => {
      if (!data.length) return;
      const bytes = data.length;
      // Main holds the shell back until the screen keeps up.
      screen.write(data, () => void api.invoke('terminals.ack', { id, bytes }).catch(() => {}));
    },
    { id },
  );
  screens.set(id, { screen, sessionId, stop });
  watch(api, sessionId);
  return screen;
}

/** Fits the terminal's screen to where it is shown, telling main its new size. */
export function fitTerminal(api: LoomApi, id: number): void {
  const entry = kept.get(api)?.get(id);
  const size = entry?.screen.fit();
  if (!entry || !size || (entry.size?.cols === size.cols && entry.size.rows === size.rows)) return;
  entry.size = size;
  api.invoke('terminals.resize', { id, ...size }).catch(() => {});
}

/** Drops the screens of a Session's terminals once they are gone from its list. */
function watch(api: LoomApi, sessionId: number): void {
  let sessions = watching.get(api);
  if (!sessions) watching.set(api, (sessions = new Map()));
  if (sessions.has(sessionId)) return;
  const watched = sessions;
  const stop = api.subscribe(
    'terminals',
    (list) => {
      const screens = kept.get(api)!;
      for (const [id, entry] of [...screens]) {
        if (entry.sessionId !== sessionId || list.some((t) => t.id === id)) continue;
        entry.stop();
        entry.screen.dispose();
        screens.delete(id);
      }
      if (![...screens.values()].some((e) => e.sessionId === sessionId)) {
        // Called during subscribe when the list is already empty: stop once it has returned.
        queueMicrotask(() => {
          if (watched.get(sessionId) !== stop) return;
          if ([...screens.values()].some((e) => e.sessionId === sessionId)) return;
          stop();
          watched.delete(sessionId);
        });
      }
    },
    { sessionId },
  );
  watched.set(sessionId, stop);
}
