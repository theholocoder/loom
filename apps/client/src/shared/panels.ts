// The Panel model (ADR 0009): Panels sit as tabs in two Panel areas, the Side
// area and the Dock. What main keeps of them is split by who it belongs to:
// the Layout (the area each Panel kind sits in, and its size) is app-wide, in settings; which Panels
// are open, the one shown and whether each area is shown belong to each
// Session, in the database.

/** The two Panel areas: the Side area, right of the conversation, and the Dock, under it. */
export const PANEL_AREAS = ['side', 'dock'] as const;
/** One of the two Panel areas. */
export type PanelArea = (typeof PANEL_AREAS)[number];

/** The kinds of Panel Loom has. */
export const PANEL_KINDS = ['changes', 'merge-request', 'terminal'] as const;
/** One kind of Panel. */
export type PanelKind = (typeof PANEL_KINDS)[number];

/** A Panel's size across its area: its width in the Side area, its height in the Dock. */
export const PANEL_DIMENSIONS = ['width', 'height'] as const;
export type PanelDimension = (typeof PANEL_DIMENSIONS)[number];

/** Whether `value` is a width or a height. */
export function isPanelDimension(value: unknown): value is PanelDimension {
  return typeof value === 'string' && (PANEL_DIMENSIONS as readonly string[]).includes(value);
}

/** The size a Panel kind takes, in pixels, until the user drags it, and the least it can be dragged to. */
export interface PanelSizeBounds {
  min: number;
  preferred: number;
}

/** What main knows of a Panel kind: the area it opens in and its sizes. The renderer adds its label, icon and badge. */
export interface PanelKindSpec {
  area: PanelArea;
  width: PanelSizeBounds;
  height: PanelSizeBounds;
  /** Whether a Session can have several open (a Terminal each), rather than one. */
  several: boolean;
}

/** Each Panel kind's area and sizes: Changes and the Merge request open in the Side area, Terminals in the Dock. */
export const PANEL_SPECS: Record<PanelKind, PanelKindSpec> = {
  changes: { area: 'side', width: { min: 280, preferred: 640 }, height: { min: 120, preferred: 340 }, several: false },
  'merge-request': { area: 'side', width: { min: 320, preferred: 400 }, height: { min: 160, preferred: 320 }, several: false },
  terminal: { area: 'dock', width: { min: 320, preferred: 520 }, height: { min: 120, preferred: 280 }, several: true },
};

/** How large any Panel can be dragged, in pixels; a smaller window caps it lower still (see the renderer's PanelArea). */
export const PANEL_MAX_SIZE: Record<PanelDimension, number> = { width: 1200, height: 1200 };

/** The size a Panel takes across `area`. */
export function dimensionOf(area: PanelArea): PanelDimension {
  return area === 'side' ? 'width' : 'height';
}

/** A size for a Panel of `kind`, rounded and kept within its minimum and the maximum. */
export function clampPanelSize(kind: PanelKind, dimension: PanelDimension, size: number): number {
  return Math.min(PANEL_MAX_SIZE[dimension], Math.max(PANEL_SPECS[kind][dimension].min, Math.round(size)));
}

/** The Panel area that isn't `area`: where a Panel in it is moved to. */
export function otherArea(area: PanelArea): PanelArea {
  return area === 'side' ? 'dock' : 'side';
}

/** Whether `value` names one of the two Panel areas. */
export function isPanelArea(value: unknown): value is PanelArea {
  return typeof value === 'string' && (PANEL_AREAS as readonly string[]).includes(value);
}

/** Whether `value` names a Panel kind Loom has. */
export function isPanelKind(value: unknown): value is PanelKind {
  return typeof value === 'string' && (PANEL_KINDS as readonly string[]).includes(value);
}

/** The Layout: the area each Panel kind sits in and its size, as the user left them, the same for every Session. */
export interface LayoutSettings {
  /** The area each kind sits in, for those the user moved; the others sit in the one their kind opens in. */
  area: Partial<Record<PanelKind, PanelArea>>;
  /** Each kind's width in the Side area, for those the user resized. */
  width: Partial<Record<PanelKind, number>>;
  /** Each kind's height in the Dock, for those the user resized. */
  height: Partial<Record<PanelKind, number>>;
}

/** The Layout until the user moves or resizes a Panel: each kind in the area it opens in, at its preferred size. */
export const DEFAULT_LAYOUT: LayoutSettings = { area: {}, width: {}, height: {} };

/** The area Panels of `kind` sit in, in the Layout: where the user moved them, or the one the kind opens in. */
export function panelArea(layout: LayoutSettings, kind: PanelKind): PanelArea {
  return layout.area[kind] ?? PANEL_SPECS[kind].area;
}

/** The size of a Panel of `kind` in the Layout: the user's, or the kind's preferred one. */
export function panelSize(layout: LayoutSettings, kind: PanelKind, dimension: PanelDimension): number {
  return layout[dimension][kind] ?? PANEL_SPECS[kind][dimension].preferred;
}

/** What of `stored` Loom still takes: an area it has for a kind it has, and a number for a kind's size, kept within bounds. */
export function readLayout(stored: unknown): LayoutSettings {
  const layout: LayoutSettings = { area: {}, width: {}, height: {} };
  if (typeof stored !== 'object' || stored === null) return layout;
  const areas = (stored as Record<string, unknown>).area;
  if (typeof areas === 'object' && areas !== null) {
    for (const [kind, area] of Object.entries(areas)) if (isPanelKind(kind) && isPanelArea(area)) layout.area[kind] = area;
  }
  for (const dimension of PANEL_DIMENSIONS) {
    const sizes = (stored as Record<string, unknown>)[dimension];
    if (typeof sizes !== 'object' || sizes === null) continue;
    for (const [kind, size] of Object.entries(sizes)) {
      if (isPanelKind(kind) && typeof size === 'number' && Number.isFinite(size)) layout[dimension][kind] = clampPanelSize(kind, dimension, size);
    }
  }
  return layout;
}

/** A Panel open in a Session: its kind for those a Session has one of, `terminal:<id>` for a Terminal. */
export type PanelId = Exclude<PanelKind, 'terminal'> | `terminal:${number}`;

/** The Panel showing Terminal `id`. */
export function terminalPanel(id: number): PanelId {
  return `terminal:${id}`;
}

/** The Terminal a Panel shows, if it is a Terminal's. */
export function terminalOf(panel: PanelId): number | undefined {
  return panel.startsWith('terminal:') ? Number(panel.slice('terminal:'.length)) : undefined;
}

/** The kind of Panel `panel` is. */
export function kindOf(panel: PanelId): PanelKind {
  return terminalOf(panel) === undefined ? (panel as PanelKind) : 'terminal';
}

/** Whether `value` is a Panel id: a kind a Session has one of, or a Terminal's. */
export function isPanelId(value: unknown): value is PanelId {
  if (typeof value !== 'string') return false;
  const terminal = /^terminal:(\d+)$/.exec(value);
  if (terminal) return Number.isSafeInteger(Number(terminal[1]));
  return isPanelKind(value) && !PANEL_SPECS[value].several;
}

/** One Panel area of a Session: its Panels, in tab order, the one shown, and whether the area is shown. */
export interface PanelAreaState {
  panels: PanelId[];
  /** One of `panels`; null with none. */
  shown: PanelId | null;
  open: boolean;
}

/** A Session's Panels, in each area. */
export type SessionPanels = Record<PanelArea, PanelAreaState>;

/** A new Session's Panels: Changes, in the Side area, shown. */
export const DEFAULT_SESSION_PANELS: SessionPanels = {
  side: { panels: ['changes'], shown: 'changes', open: true },
  dock: { panels: [], shown: null, open: false },
};

/**
 * `value` as a Session's Panels, or why it can't be: each area with its
 * Panels (each in one area only), the one shown among them, and whether it
 * is shown. One shown that isn't open falls back to the area's first.
 */
export function checkSessionPanels(value: unknown): SessionPanels {
  if (typeof value !== 'object' || value === null) throw new Error("A Session's Panels must be an object with a side and a dock area.");
  const seen = new Set<PanelId>();
  const areas = {} as SessionPanels;
  for (const area of PANEL_AREAS) {
    const state = (value as Record<string, unknown>)[area];
    if (typeof state !== 'object' || state === null) throw new Error(`The ${area} area is missing from the Session's Panels.`);
    const { panels, shown, open } = state as Record<string, unknown>;
    if (!Array.isArray(panels)) throw new Error(`The ${area} area's Panels must be a list.`);
    for (const panel of panels) {
      if (!isPanelId(panel)) throw new Error(`"${String(panel)}" is not a Panel.`);
      if (seen.has(panel)) throw new Error(`Panel "${panel}" is open twice.`);
      seen.add(panel);
    }
    if (typeof open !== 'boolean') throw new Error(`Whether the ${area} area is shown must be true or false.`);
    const list = panels as PanelId[];
    areas[area] = { panels: list, shown: list.includes(shown as PanelId) ? (shown as PanelId) : (list[0] ?? null), open };
  }
  return areas;
}

/** `panels` without its Terminals, which end when Loom quits: an area left with none is hidden. */
export function withoutTerminals(panels: SessionPanels): SessionPanels {
  const areas = {} as SessionPanels;
  for (const area of PANEL_AREAS) {
    const state = panels[area];
    const kept = state.panels.filter((panel) => terminalOf(panel) === undefined);
    const emptied = kept.length === 0 && state.panels.length > 0;
    areas[area] = { panels: kept, shown: state.shown && kept.includes(state.shown) ? state.shown : (kept[0] ?? null), open: state.open && !emptied };
  }
  return areas;
}

/** The area `panel` is open in, if it is. */
export function areaOf(panels: SessionPanels, panel: PanelId): PanelArea | undefined {
  return PANEL_AREAS.find((area) => panels[area].panels.includes(panel));
}

/**
 * `panels` with each Panel in the area its kind sits in, in `layout`: one in
 * another area goes to the end of its own, its old area showing its
 * neighbour in its place, or hidden when left with none. One that was shown
 * in a shown area is shown in its new one, and the new one is shown.
 */
export function inLayout(panels: SessionPanels, layout: LayoutSettings): SessionPanels {
  let next = panels;
  for (const from of PANEL_AREAS) {
    for (const panel of panels[from].panels) {
      const to = panelArea(layout, kindOf(panel));
      if (to === from) continue;
      const source = next[from];
      const shown = source.open && source.shown === panel;
      const at = source.panels.indexOf(panel);
      const left = source.panels.filter((p) => p !== panel);
      const target = next[to];
      next = {
        ...next,
        [from]: { panels: left, shown: source.shown === panel ? (left[Math.min(at, left.length - 1)] ?? null) : source.shown, open: source.open && left.length > 0 },
        [to]: { panels: [...target.panels, panel], shown: shown ? panel : (target.shown ?? panel), open: target.open || shown },
      };
    }
  }
  return next;
}
