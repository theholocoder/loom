// The open Session's Panels (ADR 0009): each kind of Panel registers once, and
// sits as a labelled tab in one of two Panel areas, the Side area right of
// the conversation and the Dock under it. Which Panels a Session has open,
// the one shown and whether each area is shown are the Session's own, kept
// in the database; each kind's size is the Layout's, the same for every
// Session. An area takes the size of the Panel it shows.
import { ChevronDown, FileDiff, Info, Plus, SquareTerminal, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
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
import { ResizeEdge } from './ResizeEdge';
import { useWindowLayout } from './WindowLayout';

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

/** How much of the window's height the Dock may take, leaving room for the conversation. */
const DOCK_SHARE = 0.7;
/** The width of a Side area with no Panel in it. */
const EMPTY_WIDTH = 360;
/** The size a Terminal starts at, until it is fitted to its Panel. */
const START_SIZE = { cols: 80, rows: 24 };

/** The open Session's Panels, and what changes them. */
export interface PanelsControl {
  /** Whether main has said what the Session's Panels are; until then none shows. */
  ready: boolean;
  state: SessionPanels;
  /** Whether the Side area is a drawer over the conversation, the window being narrow. */
  drawer: boolean;
  /** Whether the Side area shows: beside the conversation, or, as a drawer, open over it. */
  sideShown: boolean;
  /** Closes the drawer, leaving the Session's Panels as they are. */
  closeDrawer(): void;
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
 *
 * In a narrow window the Side area is a drawer, closed until a Panel is
 * shown in it or the area is toggled, and closed again when the window
 * crosses the breakpoint or the area is left with no Panel. Whether it is open is not kept: the Session's
 * Panels say whether the area shows in a wide window.
 */
export function usePanels(sessionId: number, terminals: TerminalInfo[] | undefined): PanelsControl {
  const { narrow } = useWindowLayout();
  const api = useApi();
  const stored = useTopic('panels', { sessionId });
  const [local, setLocal] = useState<SessionPanels>();
  useEffect(() => {
    if (stored) setLocal((pending) => (pending && same(pending, stored) ? undefined : pending));
  }, [stored]);
  const layout = useLayout();
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState<PanelId>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => setDrawerOpen(false), [narrow]);
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
  const update = (change: (state: SessionPanels) => SessionPanels): SessionPanels | undefined => {
    if (!loaded.current) return undefined;
    const next = change(latest.current);
    save(next);
    return next;
  };
  // Terminals that ended are kept closed.
  const ended = !!stored && !same(current, base);
  useEffect(() => {
    if (ended) save(current);
  }, [ended]);

  const show = (panel: PanelId) => {
    const next = update((state) => showing(state, panel));
    if (narrow && next?.side.panels.includes(panel)) setDrawerOpen(true);
  };
  /** Whether the Side area shows in `state`: beside the conversation, or as the open drawer. */
  const sideShownIn = (state: SessionPanels) => state.side.open && (!narrow || drawerOpen);
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
    if (area === 'side' && narrow) {
      if (drawerOpen && state.open) return setDrawerOpen(false);
      setDrawerOpen(true);
      if (!state.open) update((all) => ({ ...all, side: { ...all.side, open: true } }));
      return;
    }
    if (state.open) return update((all) => ({ ...all, [area]: { ...all[area], open: false } }));
    if (area === 'dock' && !state.panels.length) return void newTerminal();
    update((all) => ({ ...all, [area]: { ...all[area], open: true } }));
  };

  const sideShown = sideShownIn(current);
  useEffect(() => {
    if (!current.side.open) setDrawerOpen(false);
  }, [current.side.open]);
  return {
    ready: !!stored,
    state: current,
    drawer: narrow,
    sideShown,
    closeDrawer: () => setDrawerOpen(false),
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
      const shown = area === 'side' ? sideShownIn(latest.current) : area && latest.current[area].open;
      if (area && shown && latest.current[area].shown === panel) toggleArea(area);
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

/** How large `area` can be in the window as it is now: the Side area leaves the conversation its least width. */
function useLargest(area: PanelAreaName): number {
  const { sideMaxWidth, height } = useWindowLayout();
  return area === 'side' ? sideMaxWidth : Math.min(PANEL_MAX_SIZE.height, Math.floor(height * DOCK_SHARE));
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
  const largest = useLargest(area);
  const min = kind ? PANEL_SPECS[kind][dimension].min : 0;
  const max = Math.max(min, largest);
  const size = kind ? Math.min(Math.max(control.size(kind, dimension), min), max) : area === 'side' ? Math.min(EMPTY_WIDTH, largest) : undefined;
  const drawer = area === 'side' && control.drawer;
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
  const element = useRef<HTMLElement>(null);
  useDrawer(drawer, element, control.closeDrawer);
  const Element = area === 'side' ? 'aside' : 'section';
  return (
    <>
    {drawer && <div className="drawer-scrim" aria-hidden="true" />}
    <Element ref={element} className={drawer ? `panel-area ${area} drawer` : `panel-area ${area}`} id={id} aria-label={label} style={size === undefined ? undefined : { [dimension]: size }}>
      {kind && size !== undefined && (
        <ResizeEdge
          side={area === 'side' ? 'left' : 'top'}
          label={`Resize the ${label}`}
          controls={id}
          size={size}
          min={min}
          max={max}
          preferred={PANEL_SPECS[kind][dimension].preferred}
          onResize={(to, done) => control.resize(kind, dimension, to, done)}
        />
      )}
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
    </>
  );
}

/**
 * While the Side area is a drawer over the conversation: the focus goes into
 * it as it opens, and back where it was as it closes. Esc closes it, unless
 * something in it (a menu, a search) took the key first, or a dialog or menu
 * is open over the window. So does a click outside it, on the scrim or the
 * Inbox, but for one in a menu or dialog over it.
 */
function useDrawer(drawer: boolean, element: RefObject<HTMLElement | null>, close: () => void) {
  const closing = useRef(close);
  closing.current = close;
  useEffect(() => {
    if (!drawer) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const area = element.current;
    if (area && !area.contains(document.activeElement)) area.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('.terminal-screen')) return;
      if (document.querySelector('[aria-modal="true"], .popover')) return;
      event.preventDefault();
      closing.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || area?.contains(event.target) || event.target.closest('[aria-modal="true"], .popover')) return;
      closing.current();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
      // Back where it was, unless the focus has gone elsewhere since.
      if (returnFocus?.isConnected && (!document.activeElement || document.activeElement === document.body || area?.contains(document.activeElement))) returnFocus.focus();
    };
  }, [drawer]);
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
