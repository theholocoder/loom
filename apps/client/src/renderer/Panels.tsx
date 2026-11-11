// The open Session's Panels (ADR 0009): each kind of Panel registers once, and
// sits as a labelled tab in one of two Panel areas, the Side area right of
// the conversation and the Dock under it. Which Panels a Session has open,
// the one shown and whether each area is shown are the Session's own, kept
// in the database; each kind's size is the Layout's, the same for every
// Session, and so is the area each kind sits in: a Panel moved to the other
// area takes every Panel of its kind there, in every Session. An area takes
// the size of the Panel it shows. A Panel with a large work surface can take
// the Session's main area instead, in Review mode.
import { ChevronDown, Ellipsis, FileDiff, GitPullRequest, Maximize2, Minimize2, PanelBottom, PanelRight, Plus, SquareTerminal, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { Session, TerminalInfo } from '../shared/api';
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
import { addToContextMenu, MenuButtonMenu, type ContextMenuSection } from './ContextMenu';
import { countText } from './MergeRequestLooks';
import { Popover } from './Popover';
import { ResizeEdge } from './ResizeEdge';
import { SHORTCUTS, shortcutLabel } from './shortcuts';
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
  /** Whether it can take the Session's main area, in Review mode: a large work surface. */
  reviewable?: boolean;
  /** Whether the + menu offers it for `session`; always, without. */
  offered?: (session: Session) => boolean;
}

/** The Panel registry: every kind of Panel, once. */
export const PANELS: Record<PanelKind, PanelKindView> = {
  changes: {
    ...PANEL_SPECS.changes,
    label: 'Changes',
    icon: FileDiff,
    reviewable: true,
    badge: ({ diffStat }) => (diffStat?.files ? { text: String(diffStat.files), description: `${diffStat.files} ${diffStat.files === 1 ? 'file' : 'files'} changed` } : undefined),
  },
  'merge-request': {
    ...PANEL_SPECS['merge-request'],
    label: 'Merge request',
    icon: GitPullRequest,
    // It means nothing on a Session without one (ADR 0009); one open when it goes says so.
    offered: (session) => !!session.mergeRequest,
    badge: ({ babysit }) => {
      const reviews = babysit?.reviews?.reviews;
      if (!reviews) return undefined;
      return { text: String(reviews), description: `${countText(reviews, 'review')}${babysit.reviews!.changesRequested ? ', changes requested' : ''}` };
    },
  },
  terminal: { ...PANEL_SPECS.terminal, label: 'Terminal', icon: SquareTerminal, offered: (session) => canRunTerminals(session) },
};

/** Whether `session` can have Terminals: it can still work, so it is not archived, and its worktree is there. */
export function canRunTerminals(session: Session): boolean {
  return session.status !== 'archived' && !session.worktreeMissing;
}

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
  /** The Panel to put the focus in once it shows: a Terminal just opened or asked for. */
  focus?: PanelId;
  onFocused(): void;
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
  /** Shows or hides `area`; an empty Dock shown starts a Terminal, when Terminals sit there. Showing the Side area leaves Review mode. */
  toggleArea(area: PanelAreaName): void;
  /** `d`: shows `panel`, or hides its area when that is what it shows; leaves Review mode when it is in it. */
  toggle(panel: PanelId): void;
  /** Starts a Terminal in the Session and shows it in the Dock, with the focus in it. */
  newTerminal(): void;
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
 * until main holds the same. A change main refuses is undone, unless a later
 * one has replaced it. A Terminal's Panel goes once `terminals` no longer
 * lists it, and the area it leaves empty is hidden.
 *
 * In a narrow window the Side area is a drawer, closed until a Panel is
 * shown in it or the area is toggled, and closed again when the window
 * crosses the breakpoint or the area is left with no Panel. Whether it is open is not kept: the Session's
 * Panels say whether the area shows in a wide window.
 *
 * Each Panel sits in the area the Layout has for its kind, once settings
 * say what that is: one the Session left in the other is moved there, and
 * kept so.
 *
 * Review mode isn't kept either: it lasts while the Session stays open. It
 * hides the Side area without changing the Session's Panels, so leaving it
 * brings the area back as it was. Showing another Panel of the Side area, or
 * the area itself, leaves it.
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
  const [moved, setMoved] = useState<PanelId>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => setDrawerOpen(false), [narrow]);
  const [review, setReview] = useState<PanelId>();
  const reviewing = useRef(review);
  reviewing.current = review;
  useEffect(() => setReview(undefined), [sessionId]);
  /** Terminals just opened that `terminals` doesn't list yet. */
  const starting = useRef(new Set<number>());
  const opening = useRef(false);

  useEffect(() => {
    for (const { id } of terminals ?? []) starting.current.delete(id);
  }, [terminals]);
  const base = local ?? stored ?? DEFAULT_SESSION_PANELS;
  const running = terminals ? withTerminals(base, new Set([...terminals.map((t) => t.id), ...starting.current])) : base;
  // Not before settings say where each kind sits: it would move them back to where their kinds open.
  const current = layout.loaded ? inLayout(running, layout.value) : running;
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
  // Terminals that ended are kept closed, and Panels the Layout moved are kept where it has them.
  // Keyed on what to keep, so that a change coming before main holds the last one is kept too.
  const unkept = stored && !same(current, base) ? JSON.stringify(current) : undefined;
  useEffect(() => {
    if (unkept) save(current);
  }, [unkept]);

  const show = (panel: PanelId) => {
    if (reviewing.current === panel) return;
    // Another of the Side area's Panels brings the area back.
    if (reviewing.current && (areaOf(latest.current, panel) ?? panelArea(layout.value, kindOf(panel))) === 'side') setReview(undefined);
    const next = update((state) => showing(state, panel, layout.value));
    if (narrow && next?.side.panels.includes(panel)) setDrawerOpen(true);
  };
  /** Whether the Side area shows in `state`: beside the conversation, or as the open drawer. */
  const sideShownIn = (state: SessionPanels) => state.side.open && (!narrow || drawerOpen);
  const newTerminal = async () => {
    if (opening.current) return;
    opening.current = true;
    setError(undefined);
    // Shown at once, the terminal coming in once started, or why it couldn't.
    const area = panelArea(layout.value, 'terminal');
    if (!latest.current[area].open) update((state) => ({ ...state, [area]: { ...state[area], open: true } }));
    if (area === 'side') {
      setReview(undefined);
      if (narrow) setDrawerOpen(true);
    }
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
    if (area === 'dock' && !state.panels.length && panelArea(layout.value, 'terminal') === 'dock') return void newTerminal();
    update((all) => ({ ...all, [area]: { ...all[area], open: true } }));
  };

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
    size: (kind, dimension) => panelSize(layout.value, kind, dimension),
    show,
    move: (panel) => {
      const from = areaOf(latest.current, panel);
      if (!loaded.current || !from) return;
      const to = otherArea(from);
      const next = layout.setArea(kindOf(panel), to);
      // The Side area comes back for the Panel brought into it; the one in Review mode leaves it for the Dock.
      if (reviewing.current && (to === 'side' || reviewing.current === panel)) setReview(undefined);
      update((state) => showing(inLayout(state, next), panel, next));
      // In a narrow window, the drawer opens on the Panel brought in, and closes on one taken out to the Dock, which it would cover.
      if (narrow) setDrawerOpen(to === 'side');
      setMoved(panel);
    },
    close: (panel) => {
      const terminal = terminalOf(panel);
      // A Terminal ends first: its Panel goes once main no longer lists it.
      if (terminal !== undefined) api.invoke('terminals.close', { id: terminal }).catch((e: unknown) => setError((e as Error).message));
      else update((state) => closing(state, panel));
      if (reviewing.current === panel) setReview(undefined);
    },
    toggleArea,
    toggle: (panel) => {
      if (reviewing.current === panel) return setReview(undefined);
      const area = areaOf(latest.current, panel);
      const shown = area === 'side' ? sideShownIn(latest.current) : area && latest.current[area].open;
      if (area && shown && latest.current[area].shown === panel) toggleArea(area);
      else show(panel);
    },
    newTerminal: () => void newTerminal(),
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
      const shown = state.shown && terminalOf(state.shown) !== undefined ? state.shown : state.panels.findLast((panel) => terminalOf(panel) !== undefined);
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
  /** Whether settings have said what the Layout is. */
  loaded: boolean;
  value: LayoutSettings;
  resize: PanelsControl['resize'];
  /** Puts Panels of `kind` in `area`, and gives the Layout that has them there. */
  setArea(kind: PanelKind, area: PanelAreaName): LayoutSettings;
} {
  const api = useApi();
  const stored = useTopic('settings')?.layout;
  const [local, setLocal] = useState<LayoutSettings>();
  useEffect(() => {
    if (stored) setLocal((pending) => (pending && same(pending, stored) ? undefined : pending));
  }, [stored]);
  const value = local ?? stored ?? DEFAULT_LAYOUT;
  const latest = useRef(value);
  latest.current = value;
  const keep = (next: LayoutSettings, saving: Promise<unknown> | undefined, what: string) => {
    latest.current = next;
    setLocal(next);
    saving?.catch((e: unknown) => {
      console.error(`could not keep the Panel ${what}:`, e);
      setLocal((pending) => (pending && same(pending, next) ? undefined : pending));
    });
  };
  return {
    loaded: !!stored,
    value,
    resize: (kind, dimension, size, done) => {
      const next = { ...latest.current, [dimension]: { ...latest.current[dimension], [kind]: size } };
      keep(next, done ? api.invoke('settings.setPanelSize', { kind, dimension, size }) : undefined, 'size');
    },
    setArea: (kind, area) => {
      const next = { ...latest.current, area: { ...latest.current.area, [kind]: area } };
      keep(next, api.invoke('settings.setPanelArea', { kind, area }), 'area');
      return next;
    },
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `state` with `panel` shown in its area, opened at the end of the one its kind sits in, in `layout`, if it wasn't open. */
function showing(state: SessionPanels, panel: PanelId, layout: LayoutSettings): SessionPanels {
  const area = areaOf(state, panel) ?? panelArea(layout, kindOf(panel));
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

/** What the + menu of `area` adds for `session`: each kind that sits there and it offers, a new Terminal for those a Session has several of. */
function choicesFor(area: PanelAreaName, session: Session, control: PanelsControl): PanelChoice[] {
  return PANEL_KINDS.filter((kind) => control.areaFor(kind) === area && (PANELS[kind].offered?.(session) ?? true)).map((kind) => ({
    label: PANELS[kind].label,
    icon: PANELS[kind].icon,
    run: PANELS[kind].several ? control.newTerminal : () => control.show(kind as PanelId),
  }));
}

/**
 * A shown Panel area of `session`: a tab per Panel, the one shown as
 * `render` draws it, a + menu to add one, and the edge facing the conversation to resize the Panel shown.
 * A tab's right-click menu, and the area's ⋯ menu for the Panel shown, move
 * it to the other area, put it in Review mode, or close it.
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
  const reviewing = area === 'side' ? control.review : undefined;
  const kind = state.shown ? kindOf(state.shown) : undefined;
  const largest = useLargest(area);
  const min = kind ? PANEL_SPECS[kind][dimension].min : 0;
  const max = Math.max(min, largest);
  const size = kind ? Math.min(Math.max(control.size(kind, dimension), min), max) : area === 'side' ? Math.min(EMPTY_WIDTH, largest) : undefined;
  const drawer = area === 'side' && control.drawer && !reviewing;
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
  // The tab of the Panel just moved here takes the focus, its old one gone with the menu that moved it.
  const { moved, onMoved } = control;
  useEffect(() => {
    if (!moved || !state.panels.includes(moved)) return;
    tabs.current?.querySelector<HTMLElement>(`#${tabId(moved)}`)?.focus();
    onMoved();
  }, [moved, state.panels]);
  const other = otherArea(area);
  /** What a tab's right-click menu, and the ⋯ menu for the Panel shown, offer for `panel`. */
  const menuFor = (panel: PanelId): ContextMenuSection[] => [
    [
      { label: `Move to the ${AREA_LABELS[other]}`, icon: other === 'dock' ? PanelBottom : PanelRight, run: () => control.move(panel) },
      ...(area === 'side' && PANELS[kindOf(panel)].reviewable
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
  const element = useRef<HTMLElement>(null);
  useDrawer(drawer, element, control.closeDrawer);
  useReview(!!reviewing, element, control.leaveReview);
  const Element = area === 'side' ? 'aside' : 'section';
  // Review mode takes the Side area's place: a Panel in the Dock stays there.
  const reviewable = area === 'side' && !reviewing && state.shown && PANELS[kindOf(state.shown)].reviewable ? state.shown : undefined;
  const reviewShortcut = shortcutLabel(SHORTCUTS.reviewChanges.shortcut);
  return (
    <>
    {drawer && <div className="drawer-scrim" aria-hidden="true" />}
    <Element
      ref={element}
      className={reviewing ? `panel-area ${area} review` : drawer ? `panel-area ${area} drawer` : `panel-area ${area}`}
      id={id}
      role={reviewing ? 'region' : undefined}
      aria-label={reviewing ? 'Review mode' : label}
      style={size === undefined || reviewing ? undefined : { [dimension]: size }}
    >
      {kind && size !== undefined && !reviewing && (
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
      {reviewing ? (
        <ReviewHead tab={tab(reviewing)} onLeave={control.leaveReview} />
      ) : (
      <header className="panel-tabs-bar">
        <div ref={tabs} role="tablist" aria-label={`${label} Panels`} className={fit.compact ? 'panel-tabs compact' : 'panel-tabs'} onKeyDown={step}>
          {state.panels.map((panel) => {
            const { label: tabLabel, icon: Icon, badge } = tab(panel);
            const selected = panel === state.shown;
            return (
              <span
                key={panel}
                className={selected ? 'panel-tab on' : 'panel-tab'}
                data-panel={panel}
                data-selected={selected}
                style={fit.hidden.includes(panel) ? { display: 'none' } : undefined}
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
        <AddMenu area={label} choices={choicesFor(area, session, control)} />
        <span className="grow" />
        {reviewable && (
          <button
            className="icon-btn sm"
            type="button"
            data-review-toggle
            title={`Review mode: give ${tab(reviewable).label} the main area (${reviewShortcut}, Esc to come back)`}
            aria-label={`Review ${tab(reviewable).label}`}
            aria-keyshortcuts={reviewShortcut.replaceAll(' ', '+')}
            onClick={() => control.toggleReview(reviewable)}
          >
            <Maximize2 />
          </button>
        )}
        {state.shown && <PanelMenu label={tab(state.shown).label} sections={menuFor(state.shown)} />}
        <button className="icon-btn sm" type="button" title={`Hide the ${label}`} aria-label={`Hide the ${label}`} aria-controls={id} onClick={() => control.toggleArea(area)}>
          <X />
        </button>
      </header>
      )}
      <div
        className="panel-view"
        role={reviewing ? undefined : 'tabpanel'}
        id={`${id}-view`}
        aria-labelledby={!reviewing && state.shown ? tabId(state.shown) : undefined}
        aria-label={reviewing || state.shown ? undefined : label}
      >
        {area === control.areaFor('terminal') && control.error && (
          <p className="panel-error" role="alert">
            {control.error}
          </p>
        )}
        {reviewing ? render(reviewing) : state.shown ? render(state.shown) : <div className="panel-empty">No Panels here. Add one with +, or move a tab here from its menu.</div>}
      </div>
    </Element>
    </>
  );
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
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('.terminal-screen')) return;
      if (document.querySelector('[aria-modal="true"], .popover')) return;
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
