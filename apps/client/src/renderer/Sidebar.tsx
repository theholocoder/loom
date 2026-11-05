// The open Session's right sidebar: one view at a time, Session info or
// Changes, picked by the tab icons in its header, resized by dragging its
// left edge. Whether it is open, its last view and its width are settings,
// the same for every Session.
import { FileDiff, Info, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { clampSidebarWidth, DEFAULT_SIDEBAR, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, type SidebarSettings, type SidebarView } from '../shared/api';
import { useApi, useTopic } from './api';

/** The sidebar's state, and what changes it. */
export interface SidebarControl extends SidebarSettings {
  /** Opens it on its last view, or closes it. */
  toggle(): void;
  /** Opens it on `view`; closes it when it is already open on `view`. */
  toggleView(view: SidebarView): void;
  /** Opens it on `view`, whatever it showed. */
  reveal(view: SidebarView): void;
  /** Sets its width while dragging; `done` keeps it in settings. */
  resize(width: number, done: boolean): void;
}

/**
 * The sidebar's state: the settings', or what the user changed it to (or is
 * dragging it to) until settings hold the same. A change settings refuse is
 * undone, unless a later one has replaced it.
 */
export function useSidebar(): SidebarControl {
  const api = useApi();
  const stored = useTopic('settings')?.sidebar;
  const [local, setLocal] = useState<SidebarSettings>();
  useEffect(() => {
    if (stored) setLocal((pending) => (pending && sameSidebar(pending, stored) ? undefined : pending));
  }, [stored]);
  const current = local ?? stored ?? DEFAULT_SIDEBAR;
  const set = (change: Partial<SidebarSettings>, keep = true) => {
    const next = { ...current, ...change };
    setLocal(next);
    if (!keep) return;
    api.invoke('settings.setSidebar', change).catch((error: unknown) => {
      console.error('could not keep the sidebar settings:', error);
      setLocal((pending) => (pending && sameSidebar(pending, next) ? undefined : pending));
    });
  };
  return {
    ...current,
    toggle: () => set({ open: !current.open }),
    toggleView: (view) => set(current.open && current.view === view ? { open: false } : { open: true, view }),
    reveal: (view) => {
      if (!current.open || current.view !== view) set({ open: true, view });
    },
    resize: (width, done) => set({ width: clampSidebarWidth(width) }, done),
  };
}

function sameSidebar(a: SidebarSettings, b: SidebarSettings): boolean {
  return a.open === b.open && a.view === b.view && a.width === b.width;
}

const VIEWS: Record<SidebarView, { label: string; icon: LucideIcon }> = {
  info: { label: 'Session info', icon: Info },
  changes: { label: 'Changes', icon: FileDiff },
};

/** How far one arrow key press moves the edge, in pixels. */
const KEY_STEP = 24;

/** How much of the window the sidebar may take, leaving room for the conversation. */
const WINDOW_SHARE = 0.7;

/** The widest the sidebar can be in the window as it is now: SIDEBAR_MAX_WIDTH, or less in a narrow window. */
function useWidestFitting(): number {
  const widest = () => Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(window.innerWidth * WINDOW_SHARE)));
  const [width, setWidth] = useState(widest);
  useEffect(() => {
    const onResize = () => setWidth(widest());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/**
 * The open sidebar, showing `children` as its `control.view`, at its width
 * or the widest that fits the window. Its tabs are one Tab stop, the arrow
 * keys moving between them.
 */
export function Sidebar({ control, children }: { control: SidebarControl; children: ReactNode }) {
  const { label } = VIEWS[control.view];
  const widest = useWidestFitting();
  const width = Math.min(control.width, widest);
  const views = Object.keys(VIEWS) as SidebarView[];
  const tabs = useRef<HTMLDivElement>(null);
  const step = (event: ReactKeyboardEvent) => {
    const at = views.indexOf(control.view);
    const to = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const view = views[(to + views.length) % views.length]!;
    control.reveal(view);
    tabs.current?.querySelector<HTMLElement>(`#sidebar-tab-${view}`)?.focus();
  };
  return (
    <aside className="sidebar" id="session-sidebar" aria-label="Session sidebar" style={{ width }}>
      <ResizeEdge control={control} width={width} widest={widest} />
      <header>
        <div ref={tabs} role="tablist" aria-label="Sidebar views" className="sidebar-tabs" onKeyDown={step}>
          {views.map((view) => {
            const { label, icon: Icon } = VIEWS[view];
            const selected = control.view === view;
            return (
              <button
                key={view}
                className="icon-btn sm"
                type="button"
                role="tab"
                id={`sidebar-tab-${view}`}
                title={label}
                aria-label={label}
                aria-selected={selected}
                aria-controls="sidebar-view"
                tabIndex={selected ? 0 : -1}
                onClick={() => control.reveal(view)}
              >
                <Icon />
              </button>
            );
          })}
        </div>
        <b>{label}</b>
      </header>
      <div className="sidebar-view" role="tabpanel" id="sidebar-view" aria-labelledby={`sidebar-tab-${control.view}`}>
        {children}
      </div>
    </aside>
  );
}

/** The left edge: dragged, or moved with the arrow keys, it sets the width, from the one shown up to `widest`. */
function ResizeEdge({ control, width, widest }: { control: SidebarControl; width: number; widest: number }) {
  const controlNow = useRef(control);
  controlNow.current = control;
  const resize = (to: number, done: boolean) => controlNow.current.resize(Math.min(to, widest), done);
  const start = (event: ReactMouseEvent) => {
    event.preventDefault();
    const from = { x: event.clientX, width };
    // Dragging left widens it.
    const widthAt = (x: number) => from.width + (from.x - x);
    const move = (e: MouseEvent) => resize(widthAt(e.clientX), false);
    const up = (e: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      resize(widthAt(e.clientX), true);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add('resizing');
  };
  const key = (event: ReactKeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? KEY_STEP : event.key === 'ArrowRight' ? -KEY_STEP : 0;
    if (!step) return;
    event.preventDefault();
    resize(width + step, true);
  };
  return (
    <div
      className="sidebar-edge"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-controls="session-sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={widest}
      aria-valuenow={width}
      tabIndex={0}
      onMouseDown={start}
      onKeyDown={key}
    />
  );
}
