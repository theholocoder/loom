// The open Session's bottom dock: applets under the conversation, picked by
// the tabs in its header, resized by dragging its top edge. The only applet
// is the terminal, with a tab per terminal the Session has open. Whether the
// dock is open, and its height, are each Session's own, kept while Loom runs:
// its terminals don't outlive Loom either.
import { Plus, SquareTerminal, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { Session, TerminalInfo } from '../shared/api';
import { useApi, useTopic } from './api';
import { fitTerminal, terminalScreen } from './terminals';

/** The dock's applets. */
export const DOCK_APPLETS = { terminal: { label: 'Terminal', icon: SquareTerminal } } satisfies Record<string, { label: string; icon: LucideIcon }>;
export type DockApplet = keyof typeof DOCK_APPLETS;

/** One Session's dock. */
export interface DockState {
  open: boolean;
  applet: DockApplet;
  /** Its height in pixels, within DOCK_MIN_HEIGHT and what the window leaves. */
  height: number;
  /** The terminal it shows, once it has one. */
  terminalId?: number;
  /** Set to put the focus in the terminal shown, once there is one. */
  focusPending: boolean;
}

const DEFAULT_DOCK: DockState = { open: false, applet: 'terminal', height: 280, focusPending: false };
const DOCK_MIN_HEIGHT = 120;
/** How much of the window the dock may take, leaving room for the conversation. */
const WINDOW_SHARE = 0.7;
/** How far one arrow key press moves the edge, in pixels. */
const KEY_STEP = 24;
/** The size a terminal starts at, until it is fitted to the dock. */
const START_SIZE = { cols: 80, rows: 24 };

export interface DockControl {
  /** The dock of Session `sessionId`. */
  of(sessionId: number): DockState;
  change(sessionId: number, change: Partial<DockState>): void;
  /**
   * Ctrl+`: opens the Session's dock on its terminal with the focus in it,
   * focuses the terminal of a dock already open, and hides the dock when its
   * terminal has the focus.
   */
  toggleTerminal(sessionId: number): void;
}

/** Every Session's dock, while Loom runs. */
export function useDocks(): DockControl {
  const [docks, setDocks] = useState<Record<number, DockState>>({});
  const of = (sessionId: number) => docks[sessionId] ?? DEFAULT_DOCK;
  const change = (sessionId: number, change: Partial<DockState>) =>
    setDocks((all) => ({ ...all, [sessionId]: { ...(all[sessionId] ?? DEFAULT_DOCK), ...change } }));
  return {
    of,
    change,
    toggleTerminal: (sessionId) => {
      const dock = of(sessionId);
      const focusedInDock = !!document.activeElement?.closest('.dock');
      if (dock.open && dock.applet === 'terminal' && focusedInDock) {
        change(sessionId, { open: false });
        // Back to the conversation's composer.
        document.querySelector<HTMLElement>('.main .composer textarea')?.focus();
      } else {
        change(sessionId, { open: true, applet: 'terminal', focusPending: true });
      }
    },
  };
}

/** The tallest the dock can be in the window as it is now. */
function useTallestFitting(): number {
  const tallest = () => Math.max(DOCK_MIN_HEIGHT, Math.floor(window.innerHeight * WINDOW_SHARE));
  const [height, setHeight] = useState(tallest);
  useEffect(() => {
    const onResize = () => setHeight(tallest());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return height;
}

/** The open dock of `session`. */
export function Dock({ session, state, onChange }: { session: Session; state: DockState; onChange: (change: Partial<DockState>) => void }) {
  const api = useApi();
  const tallest = useTallestFitting();
  const height = Math.min(Math.max(state.height, DOCK_MIN_HEIGHT), tallest);
  const terminals = useTopic('terminals', { sessionId: session.id });
  const [error, setError] = useState<string>();
  /** Whether the Session has had a terminal since the dock opened, so losing the last one hides it. */
  const hadTerminals = useRef(false);
  const opening = useRef(false);

  const newTerminal = async () => {
    if (opening.current) return;
    opening.current = true;
    setError(undefined);
    try {
      const terminal = await api.invoke('terminals.open', { sessionId: session.id, ...START_SIZE });
      onChange({ terminalId: terminal.id, focusPending: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      opening.current = false;
    }
  };
  useEffect(() => {
    if (!terminals) return;
    if (terminals.length) {
      hadTerminals.current = true;
      return;
    }
    if (hadTerminals.current) onChange({ open: false, terminalId: undefined });
    else if (!error) void newTerminal();
  }, [terminals]);

  const list = terminals ?? [];
  const shown = list.find((t) => t.id === state.terminalId) ?? list.at(-1);
  const close = (terminal: TerminalInfo) => {
    api.invoke('terminals.close', { id: terminal.id }).catch((e: unknown) => setError((e as Error).message));
  };
  const tabs = useRef<HTMLDivElement>(null);
  const step = (event: ReactKeyboardEvent) => {
    if (!shown) return;
    const at = list.indexOf(shown);
    const to = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const terminal = list[(to + list.length) % list.length]!;
    onChange({ terminalId: terminal.id });
    tabs.current?.querySelector<HTMLElement>(`#dock-terminal-tab-${terminal.id}`)?.focus();
  };
  const { label: appletLabel, icon: AppletIcon } = DOCK_APPLETS[state.applet];

  return (
    <section className="dock" id="session-dock" aria-label="Dock" style={{ height }}>
      <DockEdge height={height} tallest={tallest} onResize={(to) => onChange({ height: Math.max(DOCK_MIN_HEIGHT, Math.min(to, tallest)) })} />
      <header>
        <div role="tablist" aria-label="Dock applets" className="sidebar-tabs">
          <button className="icon-btn sm" type="button" role="tab" title={appletLabel} aria-label={appletLabel} aria-selected="true" aria-controls="dock-view">
            <AppletIcon />
          </button>
        </div>
        <div ref={tabs} role="tablist" aria-label="Terminals" className="dock-tabs" onKeyDown={step}>
          {list.map((terminal) => {
            const selected = terminal.id === shown?.id;
            return (
              <span key={terminal.id} className={selected ? 'dock-tab sel' : 'dock-tab'}>
                <button
                  type="button"
                  role="tab"
                  id={`dock-terminal-tab-${terminal.id}`}
                  aria-selected={selected}
                  aria-controls="dock-view"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onChange({ terminalId: terminal.id, focusPending: true })}
                >
                  {terminal.title}
                </button>
                <button className="icon-btn xs" type="button" title={`Close ${terminal.title}`} aria-label={`Close ${terminal.title}`} onClick={() => close(terminal)}>
                  <X />
                </button>
              </span>
            );
          })}
        </div>
        <button className="icon-btn sm" type="button" title="New terminal" aria-label="New terminal" onClick={() => void newTerminal()}>
          <Plus />
        </button>
        <span className="grow" />
        <button className="icon-btn sm" type="button" title="Hide dock" aria-label="Hide dock" onClick={() => onChange({ open: false })}>
          <X />
        </button>
      </header>
      <div className="dock-view" role="tabpanel" id="dock-view" aria-labelledby={shown ? `dock-terminal-tab-${shown.id}` : undefined} aria-label={shown ? undefined : appletLabel}>
        {error && (
          <p className="dock-error" role="alert">
            {error}
          </p>
        )}
        {shown && <TerminalView key={shown.id} terminal={shown} focusPending={state.focusPending} onFocused={() => onChange({ focusPending: false })} />}
      </div>
    </section>
  );
}

/** Where a terminal's kept screen is shown, fitted to it and following the theme. */
function TerminalView({ terminal, focusPending, onFocused }: { terminal: TerminalInfo; focusPending: boolean; onFocused: () => void }) {
  const api = useApi();
  const host = useRef<HTMLDivElement>(null);
  const settings = useTopic('settings');
  useEffect(() => {
    const screen = terminalScreen(api, terminal);
    host.current!.append(screen.element);
    const fit = () => fitTerminal(api, terminal.id);
    fit();
    // The fonts come in late: fit again with the real one.
    void document.fonts?.ready.then(fit);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
    observer?.observe(host.current!);
    return () => {
      observer?.disconnect();
      // Kept, with all it shows, for when it is shown again.
      screen.element.remove();
    };
  }, [api, terminal.id]);
  useEffect(() => {
    if (!focusPending) return;
    terminalScreen(api, terminal).focus();
    onFocused();
  }, [focusPending]);
  useEffect(() => {
    // After the theme's tokens are on the page.
    const frame = requestAnimationFrame(() => terminalScreen(api, terminal).restyle());
    return () => cancelAnimationFrame(frame);
  }, [settings?.theme, settings?.monoFont]);
  return <div ref={host} className="terminal-host" />;
}

/** The top edge: dragged, or moved with the arrow keys, it sets the height, up to `tallest`. */
function DockEdge({ height, tallest, onResize }: { height: number; tallest: number; onResize: (height: number) => void }) {
  const start = (event: ReactMouseEvent) => {
    event.preventDefault();
    const from = { y: event.clientY, height };
    // Dragging up makes it taller.
    const heightAt = (y: number) => from.height + (from.y - y);
    const move = (e: MouseEvent) => onResize(heightAt(e.clientY));
    const up = (e: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-rows');
      onResize(heightAt(e.clientY));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add('resizing-rows');
  };
  const key = (event: ReactKeyboardEvent) => {
    const step = event.key === 'ArrowUp' ? KEY_STEP : event.key === 'ArrowDown' ? -KEY_STEP : 0;
    if (!step) return;
    event.preventDefault();
    onResize(height + step);
  };
  return (
    <div
      className="dock-edge"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize dock"
      aria-controls="session-dock"
      aria-valuemin={DOCK_MIN_HEIGHT}
      aria-valuemax={tallest}
      aria-valuenow={height}
      tabIndex={0}
      onMouseDown={start}
      onKeyDown={key}
    />
  );
}
