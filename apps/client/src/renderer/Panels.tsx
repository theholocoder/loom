// The open Session's Panels (ADR 0009): each kind of Panel registers once (see
// panel-kinds.tsx), and sits as a labelled tab in one of two Panel areas, the
// Side area right of the conversation and the Dock under it. Which Panels a Session has open,
// the one shown and whether each area is shown are the Session's own, kept
// in the database; each kind's size is the Layout's, the same for every
// Session, and so is the area each kind sits in: a Panel moved to the other
// area takes every Panel of its kind there, in every Session. Either area can
// be split into two Panel stacks, the Side area's one above the other, the
// Dock's side by side: which kinds sit in the second is the Layout's too. Tabs
// are dragged between areas and stacks, or moved from their menu. An area
// takes the size of the Panel it shows (the larger of the two, split), and a
// split area's second stack takes the Panel it shows' size along it. A Panel
// with a large work surface can take the Session's main area instead, in
// Review mode.
import { ChevronDown, Columns2, Ellipsis, Maximize2, Minimize2, PanelBottom, PanelRight, Plus, Rows2, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type { Project, Session, TerminalInfo } from '../shared/api';
import {
  areaOf,
  DEFAULT_LAYOUT,
  DEFAULT_SESSION_PANELS,
  dimensionOf,
  inLayout,
  kindOf,
  otherArea,
  PANEL_AREAS,
  PANEL_KINDS,
  PANEL_MAX_SIZE,
  PANEL_SPECS,
  panelArea,
  panelPlace,
  panelsIn,
  panelSize,
  placeOf,
  splitDimensionOf,
  stackOf,
  stacksShown,
  terminalOf,
  terminalPanel,
  withoutPanel,
  withPanelAt,
  withPanelPlace,
  sameLayout,
  samePlace,
  sameSessionPanels,
  type LayoutSettings,
  type PanelArea as PanelAreaName,
  type PanelAreaState,
  type PanelDimension,
  type PanelId,
  type PanelKind,
  type PanelPlace,
  type PanelStack,
  type SessionPanels,
} from '../shared/panels';
import { ErrorText } from './ErrorText';
import { useApi, useTopic } from './api';
import { addToContextMenu, MenuButtonMenu, type ContextMenuSection } from './ContextMenu';
import { PANELS, type PanelBadge } from './panel-kinds';
import { useSessionPanels } from './panel-context';
import { Popover } from './Popover';
import { ResizeEdge } from './ResizeEdge';
import { shortcutLabel, useBindings } from './shortcuts';
import { useWindowLayout } from './WindowLayout';
import { isFreeEscape } from './escape';

/** The Panel areas' names, as the user reads them. */
export const AREA_LABELS: Record<PanelAreaName, string> = { side: 'Side area', dock: 'Dock' };
/** Where each stack of an area with two sits in it, as the user reads it, and which way a tab goes to split the area into it: the Side area's one above the other, the Dock's side by side. */
const STACK_SIDES: Record<PanelAreaName, Record<PanelStack, { where: string; way: string }>> = {
  side: { first: { where: 'top', way: 'up' }, second: { where: 'bottom', way: 'down' } },
  dock: { first: { where: 'left', way: 'left' }, second: { where: 'right', way: 'right' } },
};
/** The kind of data a dragged tab carries. */
const PANEL_DRAG_TYPE = 'application/x-loom-panel';

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
  /** Whether the Side area shows: beside the conversation, or, as a drawer, open over it. Never in Review mode. */
  sideShown: boolean;
  /** The Panel in Review mode, if any: it takes the Session's main area, beside a narrowed conversation, and the Side area is hidden. */
  review?: PanelId;
  /** Puts `panel` in Review mode, or takes it out when it is in it already. */
  toggleReview(panel: PanelId): void;
  /** Leaves Review mode: the Side area comes back as it was. */
  leaveReview(): void;
  /** Closes the drawer, leaving the Session's Panels as they are. */
  closeDrawer(): void;
  /** Why the last Terminal couldn't open, shown in the area Terminals sit in. */
  error?: string;
  /** The area Panels of `kind` sit in, in the Layout: where a Panel of it opens. */
  areaFor(kind: PanelKind): PanelAreaName;
  /** The area and stack Panels of `kind` sit in, in the Layout. */
  placeFor(kind: PanelKind): PanelPlace;
  /** The Panel to put the focus in once it shows: a Terminal just opened or asked for. */
  focus?: PanelId;
  onFocused(): void;
  /** The Panel whose tab is being dragged, if one is. */
  dragging?: PanelId;
  /** Says which Panel's tab is being dragged, or that none is any more. */
  drag(panel: PanelId | undefined): void;
  /** The Panel just moved, whose tab takes the focus in its new area. */
  moved?: PanelId;
  onMoved(): void;
  /** The size of a Panel of `kind` across its area, as the Layout has it (or the user is dragging it to). */
  size(kind: PanelKind, dimension: PanelDimension): number;
  /** Shows `panel` in its area, opening it there first if it isn't open; one in Review mode stays there. */
  show(panel: PanelId): void;
  /** Closes `panel`; a Terminal ends with it. An area left with no Panel is hidden. */
  close(panel: PanelId): void;
  /**
   * Moves `panel` to the other area, and with it every Panel of its kind,
   * in this Session and in the others as they are next shown: the Layout
   * keeps where the kind sits. It is shown there, and the area it leaves
   * shows its neighbour, or is hidden when left with none.
   */
  move(panel: PanelId): void;
  /**
   * Puts `panel` in `place`, at `at` among its tabs (the end, without), and
   * shows it there: dropped there, or moved to the other stack of its area
   * from its menu. A move to another area or stack takes every Panel of its
   * kind with it, as `move` does; a stack left with none goes, and its area is
   * no longer split.
   */
  place(panel: PanelId, place: PanelPlace, at?: number): void;
  /** Shows or hides `area`; an empty Dock shown starts a Terminal, when Terminals sit there. Showing the Side area leaves Review mode. */
  toggleArea(area: PanelAreaName): void;
  /** `d`: shows `panel`, or hides its area when that is what it shows; leaves Review mode when it is in it. */
  toggle(panel: PanelId): void;
  /** Starts a Terminal in the Session and shows it in the area Terminals sit in, with the focus in it. */
  newTerminal(): void;
  /**
   * The + menu of `to`: shows a Panel of `kind` there, a new one for a kind a
   * Session has several of. A kind sitting elsewhere moves there first, with
   * every Panel of it, as `place` does.
   */
  add(kind: PanelKind, to: PanelPlace): void;
  /**
   * Ctrl+`: shows the area Terminals sit in on a Terminal with the focus in
   * it (starting one when it has none), and hides that area when its
   * Terminal has the focus.
   */
  toggleTerminal(): void;
  /** Sets a kind's size while dragging; `done` keeps it in the Layout. */
  resize(kind: PanelKind, dimension: PanelDimension, size: number, done: boolean): void;
}

/**
 * Session `sessionId`'s Panels: main's, or what the user changed them to
 * until main has kept it. A change main refuses is undone, unless a later
 * one has replaced it. Main is the one that applies the Layout and the
 * Terminals that run (ADR 0009): it serves each Panel where its kind sits,
 * without those of Terminals that ended, so they are shown as it serves them
 * and only the user's own changes are sent back.
 *
 * In a narrow window the Side area is a drawer, closed until a Panel is
 * shown in it or the area is toggled, and closed again when the window
 * crosses the breakpoint or the area is left with no Panel. Whether it is open is not kept: the Session's
 * Panels say whether the area shows in a wide window.
 *
 * Review mode isn't kept either: it lasts while the Session stays open. It
 * hides the Side area without changing the Session's Panels, so leaving it
 * brings the area back as it was. Showing another Panel of the Side area, or
 * the area itself, leaves it.
 */
export function usePanels(sessionId: number): PanelsControl {
  const { narrow } = useWindowLayout();
  const api = useApi();
  const stored = useTopic('panels', { sessionId });
  const [local, setLocal] = useState<SessionPanels>();
  useEffect(() => {
    if (stored) setLocal((pending) => (pending && sameSessionPanels(pending, stored) ? undefined : pending));
  }, [stored]);
  const layout = useLayout();
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState<PanelId>();
  const [moved, setMoved] = useState<PanelId>();
  const [dragging, setDragging] = useState<PanelId>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => setDrawerOpen(false), [narrow]);
  const [review, setReview] = useState<PanelId>();
  const reviewing = useRef(review);
  reviewing.current = review;
  useEffect(() => setReview(undefined), [sessionId]);
  const opening = useRef(false);

  const current = local ?? stored ?? DEFAULT_SESSION_PANELS;
  const latest = useRef(current);
  latest.current = current;

  const save = (next: SessionPanels) => {
    latest.current = next;
    setLocal(next);
    // Main serves what it kept before it answers: its Panels take over then, as it may have kept them otherwise.
    api
      .invoke('sessions.setPanels', { id: sessionId, panels: next })
      .catch((e: unknown) => console.error("could not keep the Session's Panels:", e))
      .finally(() => setLocal((pending) => (pending === next ? undefined : pending)));
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
  // `layoutNow`: the Layout as just changed, before this render has it.
  const show = (panel: PanelId, layoutNow = layout.value) => {
    if (reviewing.current === panel) return;
    // Another of the Side area's Panels brings the area back.
    if (reviewing.current && (areaOf(latest.current, panel) ?? panelArea(layoutNow, kindOf(panel))) === 'side') setReview(undefined);
    const next = update((state) => showing(inLayout(state, layoutNow), panel, layoutNow));
    if (narrow && next && panelsIn(next.side).includes(panel)) setDrawerOpen(true);
  };
  /** Whether the Side area shows in `state`: beside the conversation, or as the open drawer. */
  const sideShownIn = (state: SessionPanels) => state.side.open && (!narrow || drawerOpen);
  const newTerminal = async (layoutNow = layout.value) => {
    if (opening.current) return;
    opening.current = true;
    setError(undefined);
    // Shown at once, the terminal coming in once started, or why it couldn't.
    const area = panelArea(layoutNow, 'terminal');
    if (!latest.current[area].open) update((state) => ({ ...state, [area]: { ...state[area], open: true } }));
    if (area === 'side') {
      setReview(undefined);
      if (narrow) setDrawerOpen(true);
    }
    try {
      const terminal = await api.invoke('terminals.open', { sessionId, ...START_SIZE });
      show(terminalPanel(terminal.id), layoutNow);
      setFocus(terminalPanel(terminal.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      opening.current = false;
    }
  };
  const toggleArea = (area: PanelAreaName) => {
    const state = latest.current[area];
    if (area === 'side' && reviewing.current) {
      setReview(undefined);
      if (narrow) setDrawerOpen(true);
      if (!state.open) update((all) => ({ ...all, side: { ...all.side, open: true } }));
      return;
    }
    if (area === 'side' && narrow) {
      if (drawerOpen && state.open) return setDrawerOpen(false);
      setDrawerOpen(true);
      if (!state.open) update((all) => ({ ...all, side: { ...all.side, open: true } }));
      return;
    }
    if (state.open) return update((all) => ({ ...all, [area]: { ...all[area], open: false } }));
    if (area === 'dock' && !panelsIn(state).length && panelArea(layout.value, 'terminal') === 'dock') return void newTerminal();
    update((all) => ({ ...all, [area]: { ...all[area], open: true } }));
  };

  /** See PanelsControl's `place`. */
  function place(panel: PanelId, to: PanelPlace, at?: number) {
    const from = placeOf(latest.current, panel);
    if (!loaded.current || !from) return;
    const kind = kindOf(panel);
    const was = panelPlace(layout.value, kind);
    const next = samePlace(was, to) ? layout.value : layout.setPlace(kind, to);
    // The Side area comes back for the Panel brought into it; the one in Review mode leaves it for the Dock.
    if (reviewing.current && ((to.area === 'side' && from.area !== 'side') || reviewing.current === panel)) setReview(undefined);
    // Shown last: the others of its kind follow it, and one of them shown where it was would be shown in its place.
    update((state) => showing(inLayout(withPanelAt(state, panel, to, { at, shown: true }), next), panel, next));
    // In a narrow window, the drawer opens on the Panel brought in, and closes on one taken out to the Dock, which it would cover.
    if (narrow && from.area !== to.area) setDrawerOpen(to.area === 'side');
    setMoved(panel);
  }

  /** See PanelsControl's `add`. */
  function add(kind: PanelKind, to: PanelPlace) {
    if (!loaded.current) return;
    const open = PANELS[kind].several ? undefined : placeOf(latest.current, kind as PanelId);
    // One open elsewhere moves here as its tab would.
    if (open && !samePlace(open, to)) return place(kind as PanelId, to);
    const next = samePlace(panelPlace(layout.value, kind), to) ? layout.value : layout.setPlace(kind, to);
    // Panels of a kind brought from elsewhere (Terminals) come along at once.
    if (next !== layout.value) update((state) => inLayout(state, next));
    if (PANELS[kind].several) return void newTerminal(next);
    show(kind as PanelId, next);
  }

  const sideShown = !review && sideShownIn(current);
  useEffect(() => {
    if (!current.side.open) setDrawerOpen(false);
  }, [current.side.open]);
  return {
    ready: !!stored,
    state: current,
    drawer: narrow,
    sideShown,
    closeDrawer: () => setDrawerOpen(false),
    review,
    toggleReview: (panel) => {
      // It takes the Side area's place: not a Panel the Dock shows.
      if (areaOf(latest.current, panel) === 'dock') return;
      setDrawerOpen(false);
      setReview(reviewing.current === panel ? undefined : panel);
    },
    leaveReview: () => setReview(undefined),
    error,
    focus,
    onFocused: () => setFocus(undefined),
    moved,
    onMoved: () => setMoved(undefined),
    areaFor: (kind) => panelArea(layout.value, kind),
    placeFor: (kind) => panelPlace(layout.value, kind),
    // A tab gone mid-drag (its Terminal ended) never says the drag ended.
    dragging: dragging && placeOf(current, dragging) ? dragging : undefined,
    drag: setDragging,
    size: (kind, dimension) => panelSize(layout.value, kind, dimension),
    show,
    move: (panel) => {
      const from = areaOf(latest.current, panel);
      if (!loaded.current || !from) return;
      place(panel, { area: otherArea(from), stack: 'first' });
    },
    place,
    close: (panel) => {
      const terminal = terminalOf(panel);
      // A Terminal ends first: its Panel goes once main no longer lists it.
      if (terminal !== undefined) api.invoke('terminals.close', { id: terminal }).catch((e: unknown) => setError((e as Error).message));
      else update((state) => withoutPanel(state, panel));
      if (reviewing.current === panel) setReview(undefined);
    },
    toggleArea,
    toggle: (panel) => {
      if (reviewing.current === panel) return setReview(undefined);
      const at = placeOf(latest.current, panel);
      const shown = at && (at.area === 'side' ? sideShownIn(latest.current) : latest.current[at.area].open);
      if (at && shown && stackOf(latest.current[at.area], at.stack).shown === panel) toggleArea(at.area);
      else show(panel);
    },
    newTerminal: () => void newTerminal(),
    add,
    toggleTerminal: () => {
      const area = panelArea(layout.value, 'terminal');
      const state = latest.current[area];
      const areaShown = area === 'side' ? !reviewing.current && sideShownIn(latest.current) : state.open;
      if (areaShown && document.activeElement?.closest(`.panel-area.${area} .terminal-host`)) {
        toggleArea(area);
        // Back to the conversation's composer.
        document.querySelector<HTMLElement>('.main .composer textarea')?.focus();
        return;
      }
      const shownTerminal = stacksShown(state)
        .map((stack) => stackOf(state, stack).shown)
        .find((panel) => panel && terminalOf(panel) !== undefined);
      const shown = shownTerminal ?? panelsIn(state).findLast((panel) => terminalOf(panel) !== undefined);
      if (!shown) return void newTerminal();
      show(shown);
      setFocus(shown);
    },
    resize: layout.resize,
  };
}

/**
 * The Layout: settings', or what the user is dragging a Panel to, or moved
 * one to, until settings hold the same. A change settings refuse is undone,
 * unless a later one has replaced it.
 */
function useLayout(): {
  value: LayoutSettings;
  resize: PanelsControl['resize'];
  /** Puts Panels of `kind` in `place`, and gives the Layout that has them there. */
  setPlace(kind: PanelKind, place: PanelPlace): LayoutSettings;
} {
  const api = useApi();
  const stored = useTopic('settings')?.layout;
  const [local, setLocal] = useState<LayoutSettings>();
  useEffect(() => {
    if (stored) setLocal((pending) => (pending && sameLayout(pending, stored) ? undefined : pending));
  }, [stored]);
  const value = local ?? stored ?? DEFAULT_LAYOUT;
  const latest = useRef(value);
  latest.current = value;
  const keep = (next: LayoutSettings, saving: Promise<unknown> | undefined, what: string) => {
    latest.current = next;
    setLocal(next);
    saving?.catch((e: unknown) => {
      console.error(`could not keep the Panel ${what}:`, e);
      setLocal((pending) => (pending && sameLayout(pending, next) ? undefined : pending));
    });
  };
  return {
    value,
    resize: (kind, dimension, size, done) => {
      const next = { ...latest.current, [dimension]: { ...latest.current[dimension], [kind]: size } };
      keep(next, done ? api.invoke('settings.setPanelSize', { kind, dimension, size }) : undefined, 'size');
    },
    setPlace: (kind, place) => {
      const next = withPanelPlace(latest.current, kind, place);
      keep(next, api.invoke('settings.setPanelPlace', { kind, ...place }), 'place');
      return next;
    },
  };
}

/** `state` with `panel` shown in its stack, opened at the end of the place its kind sits in, in `layout`, if it wasn't open. */
function showing(state: SessionPanels, panel: PanelId, layout: LayoutSettings): SessionPanels {
  const at = placeOf(state, panel);
  if (!at) return withPanelAt(state, panel, panelPlace(layout, kindOf(panel)), { shown: true });
  const area = state[at.area];
  const stack = stackOf(area, at.stack);
  return { ...state, [at.area]: at.stack === 'first' ? { ...area, shown: panel, open: true } : { ...area, open: true, second: { ...stack, shown: panel } } };
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

/**
 * What the + menu of `area`'s stack `stack` (the area, unsplit) adds for
 * `session`: each kind it offers, wherever the kind sits, a new Terminal for
 * those a Session has several of. One sitting elsewhere is brought there.
 */
function choicesFor(area: PanelAreaName, stack: PanelStack | undefined, session: Session, control: PanelsControl): PanelChoice[] {
  return PANEL_KINDS.filter((kind) => PANELS[kind].offered?.(session) ?? true).map((kind) => {
    const place = control.placeFor(kind);
    // An unsplit area is one stack: a kind already in it stays in the stack it has.
    const to: PanelPlace = place.area === area && (!stack || place.stack === stack) ? place : { area, stack: stack ?? 'first' };
    return { label: PANELS[kind].label, icon: PANELS[kind].icon, run: () => control.add(kind, to) };
  });
}

/**
 * A shown Panel area of `session`: its one or two Panel stacks, each a tab
 * per Panel, the one shown as `render` draws it, and a + menu to add one, and
 * the edge facing the conversation to resize the Panels shown. A split area's
 * second stack has an edge of its own, between the two.
 * A tab's right-click menu, and a stack's ⋯ menu for the Panel shown, move
 * it to the other area or stack, split the area with it, put it in Review
 * mode, or close it. A tab can be dragged too: onto a tab bar, to sit there
 * among its tabs, or onto a Panel, to join its stack or, on the far half of
 * an unsplit area, to split it.
 * The tabs are one Tab stop, the arrow keys moving between them. When they
 * don't fit, the inactive ones drop to their icon and badge, then those that
 * still don't fit go into a ⌄ menu, last first; the active one keeps its label.
 *
 * In Review mode, the Side area's place holds the Panel in review instead,
 * under a head that leaves it: the same element, so that the Panel isn't
 * drawn anew, and keeps its state, going in and out.
 */
export function PanelArea({
  area,
  session,
  project,
  terminals,
  control,
  onError,
}: {
  area: PanelAreaName;
  session: Session;
  project: Project | undefined;
  /** The Session's Terminals, for their tabs' titles and their Panels. */
  terminals: TerminalInfo[] | undefined;
  control: PanelsControl;
  /** Shows why an action in a Panel failed. */
  onError: (message: string | undefined) => void;
}) {
  const state = control.state[area];
  const label = AREA_LABELS[area];
  const dimension = dimensionOf(area);
  const along = splitDimensionOf(area);
  const reviewing = area === 'side' ? control.review : undefined;
  // In Review mode, only the stack of the Panel in review, which holds it.
  const stacks = reviewing ? [placeOf(control.state, reviewing)?.stack ?? 'first'] : stacksShown(state);
  const twoStacks = stacks.length > 1;
  const kinds = stacks.flatMap((stack) => {
    const { shown } = stackOf(state, stack);
    return shown ? [kindOf(shown)] : [];
  });
  const largest = useLargest(area);
  // The area takes the largest of the Panels it shows, none taken below its least.
  const min = kinds.length ? Math.max(...kinds.map((kind) => PANEL_SPECS[kind][dimension].min)) : 0;
  const max = Math.max(min, largest);
  const size = kinds.length
    ? Math.max(...kinds.map((kind) => Math.min(Math.max(control.size(kind, dimension), min), max)))
    : area === 'side'
      ? Math.min(EMPTY_WIDTH, largest)
      : undefined;
  const drawer = area === 'side' && control.drawer && !reviewing;
  const id = `session-${area}`;
  const element = useRef<HTMLElement>(null);
  // The second stack takes the size of the Panel it shows along the area, leaving the first its least.
  const extent = useExtent(element, along, twoStacks);
  const second = twoStacks && !reviewing ? stackOf(state, 'second').shown : null;
  const secondKind = second ? kindOf(second) : undefined;
  const firstShown = stackOf(state, 'first').shown;
  const firstMin = firstShown ? PANEL_SPECS[kindOf(firstShown)][along].min : 0;
  const secondEdge = secondKind && {
    kind: secondKind,
    min: PANEL_SPECS[secondKind][along].min,
    max: Math.max(PANEL_SPECS[secondKind][along].min, extent ? extent - firstMin : PANEL_MAX_SIZE[along]),
    preferred: PANEL_SPECS[secondKind][along].preferred,
  };
  const secondSize = secondEdge && Math.min(Math.max(control.size(secondEdge.kind, along), secondEdge.min), secondEdge.max);
  // The tab of the Panel just moved here takes the focus, its old one gone with the menu, or the drag, that moved it.
  const { moved, onMoved } = control;
  const open = panelsIn(state);
  useEffect(() => {
    if (!moved || !open.includes(moved)) return;
    element.current?.querySelector<HTMLElement>(`#${tabIdOf(area, moved)}`)?.focus();
    onMoved();
  }, [moved, open.join()]);
  useDrawer(drawer, element, control.closeDrawer);
  useReview(!!reviewing, element, control.leaveReview);
  const Element = area === 'side' ? 'aside' : 'section';
  return (
    <>
    {drawer && <div className="drawer-scrim" aria-hidden="true" />}
    <Element
      ref={element}
      className={['panel-area', area, reviewing ? 'review' : drawer ? 'drawer' : '', twoStacks ? 'two-stacks' : ''].filter(Boolean).join(' ')}
      id={id}
      role={reviewing ? 'region' : undefined}
      aria-label={reviewing ? 'Review mode' : label}
      style={size === undefined || reviewing ? undefined : { [dimension]: size }}
    >
      {kinds.length > 0 && size !== undefined && !reviewing && (
        <ResizeEdge
          side={area === 'side' ? 'left' : 'top'}
          label={`Resize the ${label}`}
          controls={id}
          size={size}
          min={min}
          max={max}
          preferred={Math.max(...kinds.map((kind) => PANEL_SPECS[kind][dimension].preferred))}
          // Split, both Panels shown take the area's size.
          onResize={(to, done) => kinds.forEach((kind) => control.resize(kind, dimension, to, done))}
        />
      )}
      {stacks.map((stack, i) => (
        <PanelStackView
          key={stack}
          area={area}
          stack={stack}
          twoStacks={twoStacks}
          session={session}
          project={project}
          terminals={terminals}
          control={control}
          onError={onError}
          reviewing={reviewing}
          // The area's own buttons go in the bar at its top right corner.
          corner={area === 'side' ? i === 0 : i === stacks.length - 1}
          edge={stack === 'second' && secondEdge && secondSize !== undefined ? { ...secondEdge, size: secondSize } : undefined}
        />
      ))}
    </Element>
    </>
  );
}

/** The id of `panel`'s tab, in `area`. */
function tabIdOf(area: PanelAreaName, panel: PanelId): string {
  return `${area}-tab-${panel.replace(':', '-')}`;
}

/** Where a tab dragged over a stack would go: among its tabs, at `at`; or into a stack, the whole Panel or half of it lit. */
type DropTarget = { at: number } | { stack: PanelStack; half: boolean };

function sameDrop(a: DropTarget | undefined, b: DropTarget): boolean {
  if (!a) return false;
  if ('at' in a) return 'at' in b && a.at === b.at;
  return 'stack' in b && a.stack === b.stack && a.half === b.half;
}

/** One Panel stack of a shown area: see PanelArea. */
function PanelStackView({
  area,
  stack,
  twoStacks,
  session,
  project,
  terminals,
  control,
  onError,
  reviewing,
  corner,
  edge,
}: {
  area: PanelAreaName;
  stack: PanelStack;
  /** Whether the area shows both its stacks. */
  twoStacks: boolean;
  session: Session;
  project: Project | undefined;
  terminals: TerminalInfo[] | undefined;
  control: PanelsControl;
  onError: (message: string | undefined) => void;
  /** The Panel in Review mode, which this stack holds, if any. */
  reviewing: PanelId | undefined;
  /** Whether its bar holds the area's own buttons: the one that hides it. */
  corner: boolean;
  /** The edge between a split area's stacks, which this, the second, is sized by. */
  edge?: { kind: PanelKind; size: number; min: number; max: number; preferred: number };
}) {
  const areaState = control.state[area];
  const state = stackOf(areaState, stack);
  const tab = (panel: PanelId) => tabOf(panel, session, terminals);
  const { stateOf } = useSessionPanels();
  /** Whether `panel` can take Review mode, as it is now. */
  const canReview = (panel: PanelId) => {
    const kind = PANELS[kindOf(panel)];
    return !!kind.reviewable && (kind.canReview?.(stateOf(panel)) ?? true);
  };
  const render = (panel: PanelId) => PANELS[kindOf(panel)].render({ panel, session, project, terminals, control, onError });
  const areaLabel = AREA_LABELS[area];
  const sides = STACK_SIDES[area];
  const label = twoStacks ? `${areaLabel} Panels, ${sides[stack].where}` : `${areaLabel} Panels`;
  const areaId = `session-${area}`;
  const id = stack === 'first' ? areaId : `${areaId}-second`;
  const viewId = `${id}-view`;
  const tabId = (panel: PanelId) => tabIdOf(area, panel);
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
  const other = otherArea(area);
  const otherStack: PanelStack = stack === 'first' ? 'second' : 'first';
  const SplitIcon = area === 'side' ? Rows2 : Columns2;
  /** Whether `panel` can split the area, on its own: its stack has Panels of another kind to leave behind. */
  const splits = (panel: PanelId) => !stackOf(areaState, otherStack).panels.length && state.panels.some((p) => kindOf(p) !== kindOf(panel));
  /** What a tab's right-click menu, and the ⋯ menu for the Panel shown, offer for `panel`. */
  const menuFor = (panel: PanelId): ContextMenuSection[] => [
    [
      { label: `Move to the ${AREA_LABELS[other]}`, icon: other === 'dock' ? PanelBottom : PanelRight, run: () => control.move(panel) },
      ...(stackOf(areaState, otherStack).panels.length
        ? [{ label: `Move to the ${sides[otherStack].where} stack`, icon: SplitIcon, run: () => control.place(panel, { area, stack: otherStack }) }]
        : splits(panel)
          ? [{ label: `Split ${sides[otherStack].way}`, icon: SplitIcon, run: () => control.place(panel, { area, stack: otherStack }) }]
          : []),
      ...(area === 'side' && canReview(panel)
        ? [
            {
              label: 'Review mode',
              icon: Maximize2,
              run: () => {
                control.show(panel);
                control.toggleReview(panel);
              },
            },
          ]
        : []),
    ],
    [{ label: 'Close', icon: X, run: () => control.close(panel) }],
  ];
  // Review mode takes the Side area's place: a Panel in the Dock stays there.
  const reviewable = area === 'side' && !reviewing && state.shown && canReview(state.shown) ? state.shown : undefined;
  const reviewBinding = useBindings().reviewChanges;
  const reviewShortcut = reviewBinding && shortcutLabel(reviewBinding);

  const [drop, setDrop] = useState<DropTarget>();
  const dragging = control.dragging;
  // A drag that ended elsewhere, or was given up, leaves no hint for the next.
  useEffect(() => {
    if (!dragging) setDrop(undefined);
  }, [dragging]);
  const target = dragging && drop;
  const over = (event: ReactDragEvent, to: DropTarget) => {
    takeDrop(event);
    setDrop((was) => (sameDrop(was, to) ? was : to));
  };
  const leave = (event: ReactDragEvent) => {
    if (leftFor(event)) setDrop(undefined);
  };
  const dropped = (event: ReactDragEvent, to: DropTarget) => {
    takeDrop(event);
    setDrop(undefined);
    control.drag(undefined);
    if (!dragging) return;
    if ('at' in to) control.place(dragging, { area, stack }, to.at);
    else control.place(dragging, { area, stack: to.stack });
  };
  /** Where among the tabs one dropped at `x` goes: before the first whose middle is past it. */
  const tabAt = (x: number) => {
    const shown = state.panels.filter((panel) => !fit.hidden.includes(panel));
    const before = shown.find((panel) => {
      const rect = tabs.current?.querySelector<HTMLElement>(`[data-panel="${panel}"]`)?.getBoundingClientRect();
      return rect && x < rect.left + rect.width / 2;
    });
    return before ? state.panels.indexOf(before) : state.panels.length;
  };
  /** Where a tab dragged over the Panel shown goes: its stack, or, on the far half of an unsplit area, a new stack splitting it. */
  const intoView = (event: ReactDragEvent): DropTarget => {
    if (twoStacks || !dragging || !state.panels.some((p) => kindOf(p) !== kindOf(dragging))) return { stack, half: false };
    const rect = event.currentTarget.getBoundingClientRect();
    const far = area === 'side' ? event.clientY > rect.top + rect.height / 2 : event.clientX > rect.left + rect.width / 2;
    const to: PanelStack = far ? 'second' : 'first';
    return { stack: to, half: to !== stack };
  };
  const dropBefore = target && 'at' in target ? state.panels[target.at] : undefined;
  const zone = target && 'stack' in target ? (target.half ? target.stack : 'whole') : undefined;

  return (
    <div
      className={['panel-stack', stack].join(' ')}
      id={stack === 'second' ? id : undefined}
      style={edge && !reviewing ? { [splitDimensionOf(area)]: edge.size } : undefined}
    >
      {edge && !reviewing && (
        <ResizeEdge
          side={area === 'side' ? 'top' : 'left'}
          label={`Resize the ${areaLabel}'s ${sides.second.where} stack`}
          controls={id}
          size={edge.size}
          min={edge.min}
          max={edge.max}
          preferred={edge.preferred}
          onResize={(to, done) => control.resize(edge.kind, splitDimensionOf(area), to, done)}
        />
      )}
      {reviewing ? (
        <ReviewHead tab={tab(reviewing)} onLeave={control.leaveReview} />
      ) : (
      <header
        className={target && 'at' in target ? 'panel-tabs-bar drop-target' : 'panel-tabs-bar'}
        onDragOver={dragging ? (event) => over(event, { at: tabAt(event.clientX) }) : undefined}
        onDragLeave={leave}
        onDrop={dragging ? (event) => dropped(event, { at: tabAt(event.clientX) }) : undefined}
      >
        <div ref={tabs} role="tablist" aria-label={label} className={fit.compact ? 'panel-tabs compact' : 'panel-tabs'} onKeyDown={step}>
          {state.panels.map((panel) => {
            const { label: tabLabel, icon: Icon, badge } = tab(panel);
            const selected = panel === state.shown;
            return (
              <span
                key={panel}
                className={['panel-tab', selected ? 'on' : '', panel === dropBefore ? 'drop-before' : '', panel === dragging ? 'dragged' : ''].filter(Boolean).join(' ')}
                data-panel={panel}
                data-selected={selected}
                style={fit.hidden.includes(panel) ? { display: 'none' } : undefined}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer?.setData(PANEL_DRAG_TYPE, panel);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                  control.drag(panel);
                }}
                onDragEnd={() => control.drag(undefined)}
                onContextMenu={(event) => addToContextMenu(event, ...menuFor(panel))}
              >
                <button
                  type="button"
                  role="tab"
                  id={tabId(panel)}
                  title={badge ? `${tabLabel}: ${badge.description}` : tabLabel}
                  aria-label={tabLabel}
                  aria-description={badge?.description}
                  aria-selected={selected}
                  aria-controls={viewId}
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
          {target && 'at' in target && target.at === state.panels.length && <span className="panel-tab-drop-end" aria-hidden="true" />}
        </div>
        {fit.hidden.length > 0 && <OverflowMenu hidden={fit.hidden as PanelId[]} tabOf={tab} onShow={control.show} />}
        <AddMenu area={areaLabel} choices={choicesFor(area, twoStacks ? stack : undefined, session, control)} />
        <span className="grow" />
        {reviewable && (
          <button
            className="icon-btn sm"
            type="button"
            data-review-toggle
            title={`Review mode: give ${tab(reviewable).label} the main area (${reviewShortcut ? `${reviewShortcut}, ` : ''}Esc to come back)`}
            aria-label={`Review ${tab(reviewable).label}`}
            aria-keyshortcuts={reviewShortcut?.replaceAll(' ', '+')}
            onClick={() => control.toggleReview(reviewable)}
          >
            <Maximize2 />
          </button>
        )}
        {state.shown && <PanelMenu label={tab(state.shown).label} sections={menuFor(state.shown)} />}
        {corner && (
          <button className="icon-btn sm" type="button" title={`Hide the ${areaLabel}`} aria-label={`Hide the ${areaLabel}`} aria-controls={areaId} onClick={() => control.toggleArea(area)}>
            <X />
          </button>
        )}
      </header>
      )}
      <div
        className="panel-view"
        role={reviewing ? undefined : 'tabpanel'}
        id={viewId}
        aria-labelledby={!reviewing && state.shown ? tabId(state.shown) : undefined}
        aria-label={reviewing || state.shown ? undefined : areaLabel}
        onDragOver={dragging && !reviewing ? (event) => over(event, intoView(event)) : undefined}
        onDragLeave={leave}
        onDrop={dragging && !reviewing ? (event) => dropped(event, intoView(event)) : undefined}
      >
        {area === control.areaFor('terminal') && (!twoStacks || stack === control.placeFor('terminal').stack) && control.error && (
          <div className="panel-error" role="alert">
            <ErrorText text={control.error} />
          </div>
        )}
        {reviewing ? render(reviewing) : state.shown ? render(state.shown) : <div className="panel-empty">No Panels here. Add one with +, or drag a tab here.</div>}
        {zone && <div className={`panel-drop-zone ${zone}`} aria-hidden="true" />}
      </div>
    </div>
  );
}

/**
 * While a tab is dragged, a strip for each Panel area `shown` says isn't:
 * dropped there, the Panel goes to that area, which is shown.
 */
export function PanelDropStrips({ control, shown }: { control: PanelsControl; shown: Record<PanelAreaName, boolean> }) {
  const [over, setOver] = useState<PanelAreaName>();
  const { dragging } = control;
  if (!dragging) return null;
  return (
    <>
      {PANEL_AREAS.filter((area) => !shown[area]).map((area) => (
        <div
          key={area}
          className={over === area ? `panel-drop-strip ${area} over` : `panel-drop-strip ${area}`}
          onDragOver={(event) => {
            takeDrop(event);
            setOver(area);
          }}
          onDragLeave={(event) => {
            if (leftFor(event)) setOver(undefined);
          }}
          onDrop={(event) => {
            takeDrop(event);
            setOver(undefined);
            control.drag(undefined);
            control.place(dragging, { area, stack: 'first' });
          }}
        >
          {area === 'side' ? <PanelRight className="sm" /> : <PanelBottom className="sm" />}
          <span>Move to the {AREA_LABELS[area]}</span>
        </div>
      ))}
    </>
  );
}

/** Takes a dragged tab over, or dropped on, an element: it moves there. */
function takeDrop(event: ReactDragEvent) {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}

/** Whether a drag leaving an element left it for good, rather than for something in it. */
function leftFor(event: ReactDragEvent): boolean {
  return !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget));
}

/** The size of `element` across `dimension`, kept as it changes, while `on`; unknown without a way to watch it. */
function useExtent(element: RefObject<HTMLElement | null>, dimension: PanelDimension, on: boolean): number | undefined {
  const [extent, setExtent] = useState<number>();
  useLayoutEffect(() => {
    const el = element.current;
    if (!on || !el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setExtent((dimension === 'width' ? el.clientWidth : el.clientHeight) || undefined);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [element, dimension, on]);
  return extent;
}

/** The head of the Panel in Review mode: what it is, and the way out. */
function ReviewHead({ tab: { label, icon: Icon, badge }, onLeave }: { tab: PanelTab; onLeave: () => void }) {
  return (
    <header className="panel-tabs-bar review-head">
      <button className="icon-btn sm" type="button" data-review-toggle title="Leave Review mode (Esc)" aria-label="Leave Review mode" aria-keyshortcuts="Escape" onClick={onLeave}>
        <Minimize2 />
      </button>
      <Icon className="sm" />
      <b>{label}</b>
      {badge && (
        <span className="badge" title={badge.description}>
          {badge.text}
        </span>
      )}
      <span className="muted">in Review mode</span>
      <span className="grow" />
      <span className="muted review-hint">
        <kbd>Esc</kbd> to leave
      </span>
    </header>
  );
}

/**
 * In Review mode: Esc leaves it, unless something took the key first (a
 * comment being written, a filter, a menu), a Terminal has the focus, or a
 * dialog or menu is open over the window. Going in or out, the focus lost
 * with the button pressed goes to the one that undoes it; leaving for a
 * hidden Side area, to the composer.
 */
function useReview(reviewing: boolean, element: RefObject<HTMLElement | null>, leave: () => void) {
  const leaving = useRef(leave);
  leaving.current = leave;
  const first = useRef(true);
  const wasReviewing = useRef(reviewing);
  wasReviewing.current = reviewing;
  useEffect(
    () => () => {
      if (wasReviewing.current && (!document.activeElement || document.activeElement === document.body)) document.querySelector<HTMLElement>('.main .composer textarea')?.focus();
    },
    [],
  );
  useEffect(() => {
    if (first.current) first.current = false;
    else if (!document.activeElement || document.activeElement === document.body) element.current?.querySelector<HTMLElement>('[data-review-toggle]')?.focus();
    if (!reviewing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isFreeEscape(event)) return;
      event.preventDefault();
      leaving.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [reviewing]);
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
      if (!isFreeEscape(event)) return;
      event.preventDefault();
      closing.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || area?.contains(event.target) || event.target.closest('[aria-modal="true"], .popover, .page-window-scrim')) return;
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

/** The ⋯ menu of the Panel an area shows, `label`: what its tab's right-click menu offers. */
function PanelMenu({ label, sections }: { label: string; sections: ContextMenuSection[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} className="icon-btn sm" type="button" title={`${label}: more`} aria-label={`More for ${label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Ellipsis />
      </button>
      {open && <MenuButtonMenu anchor={trigger} label={`More for ${label}`} sections={sections} onClose={() => setOpen(false)} />}
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
