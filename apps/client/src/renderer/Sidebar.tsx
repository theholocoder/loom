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
 * The sidebar's state: the settings', or what the user just changed it to
 * (or is dragging it to) until settings catch up. A change settings refuse
 * is undone.
 */
export function useSidebar(): SidebarControl {
  const api = useApi();
  const stored = useTopic('settings')?.sidebar;
  const [local, setLocal] = useState<SidebarSettings>();
  useEffect(() => setLocal(undefined), [stored]);
  const current = local ?? stored ?? DEFAULT_SIDEBAR;
  const set = (change: Partial<SidebarSettings>, keep = true) => {
    setLocal({ ...current, ...change });
    if (!keep) return;
    api.invoke('settings.setSidebar', change).catch((error: unknown) => {
      console.error('could not keep the sidebar settings:', error);
      setLocal(undefined);
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

const VIEWS: Record<SidebarView, { label: string; icon: LucideIcon }> = {
  info: { label: 'Session info', icon: Info },
  changes: { label: 'Changes', icon: FileDiff },
};

/** How far one arrow key press moves the edge, in pixels. */
const KEY_STEP = 24;

/** The open sidebar, showing `children` as its `control.view`. */
export function Sidebar({ control, children }: { control: SidebarControl; children: ReactNode }) {
  const { label } = VIEWS[control.view];
  return (
    <aside className="sidebar" id="session-sidebar" aria-label="Session sidebar" style={{ width: control.width }}>
      <ResizeEdge control={control} />
      <header>
        <div role="tablist" aria-label="Sidebar views" className="sidebar-tabs">
          {(Object.keys(VIEWS) as SidebarView[]).map((view) => {
            const { label, icon: Icon } = VIEWS[view];
            return (
              <button
                key={view}
                className="icon-btn sm"
                type="button"
                role="tab"
                id={`sidebar-tab-${view}`}
                title={label}
                aria-label={label}
                aria-selected={control.view === view}
                aria-controls="sidebar-view"
                onClick={() => control.reveal(view)}
              >
                <Icon />
              </button>
            );
          })}
        </div>
        <b>{label}</b>
      </header>
      <div className="sidebar-view" role="tabpanel" id="sidebar-view" aria-label={label} aria-labelledby={`sidebar-tab-${control.view}`}>
        {children}
      </div>
    </aside>
  );
}

/** The left edge: dragged, or moved with the arrow keys, it sets the width. */
function ResizeEdge({ control }: { control: SidebarControl }) {
  const latest = useRef(control);
  latest.current = control;
  const start = (event: ReactMouseEvent) => {
    event.preventDefault();
    const from = { x: event.clientX, width: control.width };
    // Dragging left widens it.
    const widthAt = (x: number) => from.width + (from.x - x);
    const move = (e: MouseEvent) => latest.current.resize(widthAt(e.clientX), false);
    const up = (e: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      latest.current.resize(widthAt(e.clientX), true);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add('resizing');
  };
  const key = (event: ReactKeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? KEY_STEP : event.key === 'ArrowRight' ? -KEY_STEP : 0;
    if (!step) return;
    event.preventDefault();
    control.resize(control.width + step, true);
  };
  return (
    <div
      className="sidebar-edge"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-controls="session-sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={control.width}
      tabIndex={0}
      onMouseDown={start}
      onKeyDown={key}
    />
  );
}
