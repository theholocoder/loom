// The open Session's Panels (ADR 0009): each kind of Panel registers once, and
// sits as a labelled tab in one of two Panel areas, the Side area right of
// the conversation and the Dock under it. Which Panels a Session has open,
// the one shown and whether each area is shown are the Session's own, kept
// in the database; each kind's size is the Layout's, the same for every
// Session. An area takes the size of the Panel it shows.
import { ChevronDown, FileDiff, Info, Plus, SquareTerminal, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import type { Session, TerminalInfo } from '../shared/api';
import {
  DEFAULT_LAYOUT,
  DEFAULT_SESSION_PANELS,
  dimensionOf,
  kindOf,
  PANEL_AREAS,
  PANEL_KINDS,
  PANEL_MAX_SIZE,
  PANEL_SPECS,
  panelSize,
  terminalOf,
  terminalPanel,
  type LayoutSettings,
  type PanelArea as PanelAreaName,
  type PanelAreaState,
  type PanelDimension,
  type PanelId,
  type PanelKind,
  type PanelKindSpec,
  type SessionPanels,
} from '../shared/panels';
import { useApi, useTopic } from './api';
import { Popover } from './Popover';

/** What a tab shows beside its label: a count, with what it counts for a screen reader and the tooltip. */
export interface PanelBadge {
  text: string;
  description: string;
}

/** A Panel kind as the renderer shows it: main's spec, with its label, icon and badge. */
export interface PanelKindView extends PanelKindSpec {
  label: string;
  icon: LucideIcon;
  badge?: (session: Session) => PanelBadge | undefined;
}

/** The Panel registry: every kind of Panel, once. */
export const PANELS: Record<PanelKind, PanelKindView> = {
  info: { ...PANEL_SPECS.info, label: 'Session info', icon: Info },
  changes: {
    ...PANEL_SPECS.changes,
    label: 'Changes',
    icon: FileDiff,
    badge: ({ diffStat }) => (diffStat?.files ? { text: String(diffStat.files), description: `${diffStat.files} ${diffStat.files === 1 ? 'file' : 'files'} changed` } : undefined),
  },
  terminal: { ...PANEL_SPECS.terminal, label: 'Terminal', icon: SquareTerminal },
};

/** The Panel areas' names, as the user reads them. */
export const AREA_LABELS: Record<PanelAreaName, string> = { side: 'Side area', dock: 'Dock' };

/** How much of the window an area may take, leaving room for the conversation. */
const WINDOW_SHARE = 0.7;
/** How far one arrow key press moves an area's edge, in pixels. */
const KEY_STEP = 24;
/** The width of a Side area with no Panel in it. */
const EMPTY_WIDTH = 360;
/** The size a Terminal starts at, until it is fitted to its Panel. */
const START_SIZE = { cols: 80, rows: 24 };

/** The open Session's Panels, and what changes them. */
export interface PanelsControl {
  /** Whether main has said what the Session's Panels are; until then none shows. */
  ready: boolean;
  state: SessionPanels;
  /** Why the last Terminal couldn't open, shown in the Dock. */
  error?: string;
  /** The Panel to put the focus in once it shows: a Terminal just opened or asked for. */
  focus?: PanelId;
  onFocused(): void;
  /** The size of a Panel of `kind` across its area, as the Layout has it (or the user is dragging it to). */
  size(kind: PanelKind, dimension: PanelDimension): number;
  /** Shows `panel` in its area, opening it there first if it isn't open. */
  show(panel: PanelId): void;
  /** Closes `panel`; a Terminal ends with it. An area left with no Panel is hidden. */
  close(panel: PanelId): void;
  /** Shows or hides `area`; an empty Dock shown starts a Terminal. */
  toggleArea(area: PanelAreaName): void;
  /** `d` and Ctrl+I: shows `panel`, or hides its area when that is what it shows. */
  toggle(panel: PanelId): void;
  /** Starts a Terminal in the Session and shows it in the Dock, with the focus in it. */
  newTerminal(): void;
  /**
   * Ctrl+`: shows the Dock on a Terminal with the focus in it (starting one
   * when it has none), and hides the Dock when its Terminal has the focus.
   */
  toggleTerminal(): void;
  /** Sets a kind's size while dragging; `done` keeps it in the Layout. */
  resize(kind: PanelKind, dimension: PanelDimension, size: number, done: boolean): void;
}

/**
 * Session `sessionId`'s Panels: main's, or what the user changed them to
 * until main holds the same. A change main refuses is undone, unless a later
 * one has replaced it. A Terminal's Panel goes once `terminals` no longer
 * lists it, and the area it leaves empty is hidden.
 */
export function usePanels(sessionId: number, terminals: TerminalInfo[] | undefined): PanelsControl {
  const api = useApi();
  const stored = useTopic('panels', { sessionId });
  const [local, setLocal] = useState<SessionPanels>();
  useEffect(() => {
    if (stored) setLocal((pending) => (pending && same(pending, stored) ? undefined : pending));
  }, [stored]);
  const layout = useLayout();
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState<PanelId>();
  /** Terminals just opened that `terminals` doesn't list yet. */
  const starting = useRef(new Set<number>());
  const opening = useRef(false);

  useEffect(() => {
    for (const { id } of terminals ?? []) starting.current.delete(id);
  }, [terminals]);
  const base = local ?? stored ?? DEFAULT_SESSION_PANELS;
  const current = terminals ? withTerminals(base, new Set([...terminals.map((t) => t.id), ...starting.current])) : base;
  const latest = useRef(current);
  latest.current = current;

  const save = (next: SessionPanels) => {
    latest.current = next;
    setLocal(next);
    api.invoke('sessions.setPanels', { id: sessionId, panels: next }).catch((e: unknown) => {
      console.error("could not keep the Session's Panels:", e);
      setLocal((pending) => (pending && same(pending, next) ? undefined : pending));
    });
  };
  const loaded = useRef(false);
  loaded.current = !!stored;
  // Not before main has said what they are: the change would replace them with a new Session's.
  const update = (change: (state: SessionPanels) => SessionPanels) => {
    if (loaded.current) save(change(latest.current));
  };
  // Terminals that ended are kept closed.
  const ended = !!stored && !same(current, base);
  useEffect(() => {
    if (ended) save(current);
  }, [ended]);

  const show = (panel: PanelId) => update((state) => showing(state, panel));
  const newTerminal = async () => {
    if (opening.current) return;
    opening.current = true;
    setError(undefined);
    // Shown at once, the terminal coming in once started, or why it couldn't.
    if (!latest.current.dock.open) update((state) => ({ ...state, dock: { ...state.dock, open: true } }));
    try {
      const terminal = await api.invoke('terminals.open', { sessionId, ...START_SIZE });
      starting.current.add(terminal.id);
      show(terminalPanel(terminal.id));
      setFocus(terminalPanel(terminal.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      opening.current = false;
    }
  };
  const toggleArea = (area: PanelAreaName) => {
    const state = latest.current[area];
    if (state.open) return update((all) => ({ ...all, [area]: { ...all[area], open: false } }));
    if (area === 'dock' && !state.panels.length) return void newTerminal();
    update((all) => ({ ...all, [area]: { ...all[area], open: true } }));
  };

  return {
    ready: !!stored,
    state: current,
    error,
    focus,
    onFocused: () => setFocus(undefined),
    size: (kind, dimension) => panelSize(layout.value, kind, dimension),
    show,
    close: (panel) => {
      const terminal = terminalOf(panel);
      // A Terminal ends first: its Panel goes once main no longer lists it.
      if (terminal !== undefined) api.invoke('terminals.close', { id: terminal }).catch((e: unknown) => setError((e as Error).message));
      else update((state) => closing(state, panel));
    },
    toggleArea,
    toggle: (panel) => {
      const area = areaOf(latest.current, panel);
      if (area && latest.current[area].open && latest.current[area].shown === panel) toggleArea(area);
      else show(panel);
    },
    newTerminal: () => void newTerminal(),
    toggleTerminal: () => {
      const { dock } = latest.current;
      if (dock.open && document.activeElement?.closest('.panel-area.dock')) {
        toggleArea('dock');
        // Back to the conversation's composer.
        document.querySelector<HTMLElement>('.main .composer textarea')?.focus();
        return;
      }
      const shown = dock.shown && terminalOf(dock.shown) !== undefined ? dock.shown : dock.panels.findLast((panel) => terminalOf(panel) !== undefined);
      if (!shown) return void newTerminal();
      show(shown);
      setFocus(shown);
    },
    resize: layout.resize,
  };
}

/** The Layout's sizes: settings', or what the user is dragging to until settings hold the same. */
function useLayout(): { value: LayoutSettings; resize: PanelsControl['resize'] } {
  const api = useApi();
  const stored = useTopic('settings')?.layout;
  const [local, setLocal] = useState<LayoutSettings>();
  useEffect(() => {
    if (stored) setLocal((pending) => (pending && same(pending, stored) ? undefined : pending));
  }, [stored]);
  const value = local ?? stored ?? DEFAULT_LAYOUT;
  return {
    value,
    resize: (kind, dimension, size, done) => {
      const next = { ...value, [dimension]: { ...value[dimension], [kind]: size } };
      setLocal(next);
      if (!done) return;
      api.invoke('settings.setPanelSize', { kind, dimension, size }).catch((e: unknown) => {
        console.error('could not keep the Panel size:', e);
        setLocal((pending) => (pending && same(pending, next) ? undefined : pending));
      });
    },
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The area `panel` is open in, if it is. */
function areaOf(state: SessionPanels, panel: PanelId): PanelAreaName | undefined {
  return PANEL_AREAS.find((area) => state[area].panels.includes(panel));
}

/** `state` with `panel` shown in its area, opened at the end of the one its kind opens in if it wasn't open. */
function showing(state: SessionPanels, panel: PanelId): SessionPanels {
  const area = areaOf(state, panel) ?? PANEL_SPECS[kindOf(panel)].area;
  const { panels } = state[area];
  return { ...state, [area]: { panels: panels.includes(panel) ? panels : [...panels, panel], shown: panel, open: true } };
}

/** `state` without `panel`: its neighbour is shown in its place, and an area left empty is hidden. */
function closing(state: SessionPanels, panel: PanelId): SessionPanels {
  const area = areaOf(state, panel);
  if (!area) return state;
  const { panels, shown, open } = state[area];
  const at = panels.indexOf(panel);
  const left = panels.filter((p) => p !== panel);
  return { ...state, [area]: { panels: left, shown: shown === panel ? (left[Math.min(at, left.length - 1)] ?? null) : shown, open: open && left.length > 0 } };
}

/** `state` keeping only the Terminals in `running`. */
function withTerminals(state: SessionPanels, running: Set<number>): SessionPanels {
  let next = state;
  for (const area of PANEL_AREAS) {
    for (const panel of state[area].panels) {
      const terminal = terminalOf(panel);
      if (terminal !== undefined && !running.has(terminal)) next = closing(next, panel);
    }
  }
  return next;
}

/** How large an area can be in the window as it is now, across `dimension`. */
function useLargestFitting(dimension: PanelDimension): number {
  const largest = () => Math.min(PANEL_MAX_SIZE[dimension], Math.floor((dimension === 'width' ? window.innerWidth : window.innerHeight) * WINDOW_SHARE));
  const [size, setSize] = useState(largest);
  useEffect(() => {
    const onResize = () => setSize(largest());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/** A Panel's tab: its label and icon, and its badge. */
interface PanelTab {
  label: string;
  icon: LucideIcon;
  badge?: PanelBadge;
}

/** `panel`'s tab in `session`: a Terminal by its title, the others as the registry has them. */
function tabOf(panel: PanelId, session: Session, terminals: TerminalInfo[] | undefined): PanelTab {
  const kind = PANELS[kindOf(panel)];
  const terminal = terminalOf(panel);
  if (terminal !== undefined) return { label: terminals?.find((t) => t.id === terminal)?.title ?? kind.label, icon: kind.icon };
  return { label: kind.label, icon: kind.icon, badge: kind.badge?.(session) };
}

/** An item of an area's + menu. */
interface PanelChoice {
  label: string;
  icon: LucideIcon;
  run: () => void;
}

/** What the + menu of `area` adds: each kind that opens there, a new Terminal for those a Session has several of. */
function choicesFor(area: PanelAreaName, control: PanelsControl): PanelChoice[] {
  return PANEL_KINDS.filter((kind) => PANELS[kind].area === area).map((kind) => ({
    label: PANELS[kind].label,
    icon: PANELS[kind].icon,
    run: PANELS[kind].several ? control.newTerminal : () => control.show(kind as PanelId),
  }));
}

/**
 * A shown Panel area of `session`: a tab per Panel, the one shown as
 * `render` draws it, a + menu to add one, and the edge facing the conversation to resize the Panel shown.
 * The tabs are one Tab stop, the arrow keys moving between them. When they
 * don't fit, the inactive ones drop to their icon and badge, then those that
 * still don't fit go into a ⌄ menu, last first; the active one keeps its label.
 */
export function PanelArea({
  area,
  session,
  terminals,
  control,
  render,
}: {
  area: PanelAreaName;
  session: Session;
  /** The Session's Terminals, for their tabs' titles. */
  terminals: TerminalInfo[] | undefined;
  control: PanelsControl;
  render: (panel: PanelId) => ReactNode;
}) {
  const state = control.state[area];
  const tab = (panel: PanelId) => tabOf(panel, session, terminals);
  const label = AREA_LABELS[area];
  const dimension = dimensionOf(area);
  const kind = state.shown ? kindOf(state.shown) : undefined;
  const largest = useLargestFitting(dimension);
  const min = kind ? PANEL_SPECS[kind][dimension].min : 0;
  const max = Math.max(min, largest);
  const size = kind ? Math.min(Math.max(control.size(kind, dimension), min), max) : area === 'side' ? EMPTY_WIDTH : undefined;
  const id = `session-${area}`;
  const tabId = (panel: PanelId) => `${area}-tab-${panel.replace(':', '-')}`;
  const tabs = useRef<HTMLDivElement>(null);
  const fit = useTabOverflow(tabs);
  const step = (event: ReactKeyboardEvent) => {
    const { panels, shown } = state;
    if (!shown) return;
    const at = panels.indexOf(shown);
    const to = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const panel = panels[(to + panels.length) % panels.length]!;
    control.show(panel);
    tabs.current?.querySelector<HTMLElement>(`#${tabId(panel)}`)?.focus();
  };
  const Element = area === 'side' ? 'aside' : 'section';
  return (
    <Element className={`panel-area ${area}`} id={id} aria-label={label} style={size === undefined ? undefined : { [dimension]: size }}>
      {kind && size !== undefined && <ResizeEdge area={area} label={label} controls={id} size={size} min={min} max={max} onResize={(to, done) => control.resize(kind, dimension, Math.min(Math.max(to, min), max), done)} />}
      <header className="panel-tabs-bar">
        <div ref={tabs} role="tablist" aria-label={`${label} Panels`} className={fit.compact ? 'panel-tabs compact' : 'panel-tabs'} onKeyDown={step}>
          {state.panels.map((panel) => {
            const { label: tabLabel, icon: Icon, badge } = tab(panel);
            const selected = panel === state.shown;
            return (
              <span key={panel} className={selected ? 'panel-tab on' : 'panel-tab'} data-panel={panel} data-selected={selected} style={fit.hidden.includes(panel) ? { display: 'none' } : undefined}>
                <button
                  type="button"
                  role="tab"
                  id={tabId(panel)}
                  title={badge ? `${tabLabel}: ${badge.description}` : tabLabel}
                  aria-label={tabLabel}
                  aria-description={badge?.description}
                  aria-selected={selected}
                  aria-controls={`${id}-view`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => control.show(panel)}
                >
                  <Icon className="sm" />
                  <span className="label">{tabLabel}</span>
                  {badge && (
                    <span className="badge" aria-hidden="true">
                      {badge.text}
                    </span>
                  )}
                </button>
                <button className="icon-btn xs close" type="button" title={`Close ${tabLabel}`} aria-label={`Close ${tabLabel}`} onClick={() => control.close(panel)}>
                  <X />
                </button>
              </span>
            );
          })}
        </div>
        {fit.hidden.length > 0 && <OverflowMenu hidden={fit.hidden as PanelId[]} tabOf={tab} onShow={control.show} />}
        <AddMenu area={label} choices={choicesFor(area, control)} />
        <span className="grow" />
        <button className="icon-btn sm" type="button" title={`Hide the ${label}`} aria-label={`Hide the ${label}`} aria-controls={id} onClick={() => control.toggleArea(area)}>
          <X />
        </button>
      </header>
      <div className="panel-view" role="tabpanel" id={`${id}-view`} aria-labelledby={state.shown ? tabId(state.shown) : undefined} aria-label={state.shown ? undefined : label}>
        {area === 'dock' && control.error && (
          <p className="panel-error" role="alert">
            {control.error}
          </p>
        )}
        {state.shown ? render(state.shown) : area === 'side' && <div className="panel-empty">No Panels here. Add one with +.</div>}
      </div>
    </Element>
  );
}

/**
 * Which tabs fit the bar: all with their labels, or the inactive ones as
 * icons (`compact`), with those that still don't fit `hidden`, last first.
 * Measured after every render and whenever the bar changes size.
 */
function useTabOverflow(bar: RefObject<HTMLDivElement | null>): { compact: boolean; hidden: string[] } {
  const [fit, setFit] = useState<{ compact: boolean; hidden: string[] }>({ compact: false, hidden: [] });
  const measure = useCallback(() => {
    const el = bar.current;
    if (!el) return;
    const tabs = [...el.querySelectorAll<HTMLElement>('[data-panel]')];
    const was = { compact: el.classList.contains('compact'), display: tabs.map((tab) => tab.style.display) };
    // From scratch: every tab shown, with its label.
    el.classList.remove('compact');
    for (const tab of tabs) tab.style.display = '';
    const fits = () => el.scrollWidth <= el.clientWidth + 1;
    let compact = false;
    const hidden: string[] = [];
    if (!fits()) {
      compact = true;
      el.classList.add('compact');
      const inactive = tabs.filter((tab) => tab.dataset.selected !== 'true');
      while (!fits() && inactive.length) {
        const tab = inactive.pop()!;
        tab.style.display = 'none';
        hidden.unshift(tab.dataset.panel!);
      }
    }
    // As React left it, which then shows what was found.
    el.classList.toggle('compact', was.compact);
    tabs.forEach((tab, i) => (tab.style.display = was.display[i]!));
    setFit((prev) => (prev.compact === compact && prev.hidden.join() === hidden.join() ? prev : { compact, hidden }));
  }, [bar]);
  useLayoutEffect(measure);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !bar.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar.current.parentElement ?? bar.current);
    return () => observer.disconnect();
  }, [bar, measure]);
  return fit;
}

/** The ⌄ menu of the tabs that don't fit. */
function OverflowMenu({ hidden, tabOf, onShow }: { hidden: PanelId[]; tabOf: (panel: PanelId) => PanelTab; onShow: (panel: PanelId) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} className="icon-btn sm overflow" type="button" title="More tabs" aria-label={`${hidden.length} more ${hidden.length === 1 ? 'tab' : 'tabs'}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown />
        <span className="n">{hidden.length}</span>
      </button>
      {open && (
        <Popover anchor={trigger} role="menu" label="More tabs" onClose={() => setOpen(false)}>
          {hidden.map((panel) => {
            const { label, icon: Icon, badge } = tabOf(panel);
            return (
              <button
                key={panel}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onShow(panel);
                }}
              >
                <Icon className="sm" />
                {label}
                {badge && <span className="badge">{badge.text}</span>}
              </button>
            );
          })}
        </Popover>
      )}
    </>
  );
}

/** The + menu: the Panels that can be added to the area. */
function AddMenu({ area, choices }: { area: string; choices: PanelChoice[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!choices.length) return null;
  return (
    <>
      <button ref={trigger} className="icon-btn sm" type="button" title="Add a Panel" aria-label={`Add a Panel to the ${area}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Plus />
      </button>
      {open && (
        <Popover anchor={trigger} role="menu" label={`Add a Panel to the ${area}`} onClose={() => setOpen(false)}>
          {choices.map(({ label, icon: Icon, run }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                run();
              }}
            >
              <Icon className="sm" />
              {label}
            </button>
          ))}
        </Popover>
      )}
    </>
  );
}

/** The edge facing the conversation: dragged, or moved with the arrow keys, it sets the size of the Panel shown, within `min` and `max`. */
function ResizeEdge({ area, label, controls, size, min, max, onResize }: { area: PanelAreaName; label: string; controls: string; size: number; min: number; max: number; onResize: (size: number, done: boolean) => void }) {
  const resize = useRef(onResize);
  resize.current = onResize;
  const side = area === 'side';
  const bodyClass = side ? 'resizing' : 'resizing-rows';
  const start = (event: ReactMouseEvent) => {
    event.preventDefault();
    const from = { at: side ? event.clientX : event.clientY, size };
    // Dragging left widens the Side area; dragging up makes the Dock taller.
    const sizeAt = (e: MouseEvent) => from.size + (from.at - (side ? e.clientX : e.clientY));
    const move = (e: MouseEvent) => resize.current(sizeAt(e), false);
    const up = (e: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove(bodyClass);
      resize.current(sizeAt(e), true);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add(bodyClass);
  };
  const key = (event: ReactKeyboardEvent) => {
    const grow = side ? 'ArrowLeft' : 'ArrowUp';
    const shrink = side ? 'ArrowRight' : 'ArrowDown';
    const by = event.key === grow ? KEY_STEP : event.key === shrink ? -KEY_STEP : 0;
    if (!by) return;
    event.preventDefault();
    onResize(size + by, true);
  };
  return (
    <div
      className="panel-edge"
      role="separator"
      aria-orientation={side ? 'vertical' : 'horizontal'}
      aria-label={`Resize the ${label}`}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={size}
      tabIndex={0}
      onMouseDown={start}
      onKeyDown={key}
    />
  );
}
