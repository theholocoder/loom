// The Panel model (ADR 0009): Panels sit as tabs in two Panel areas, the Side
// area and the Dock, each of which can be split into two Panel stacks. What
// main keeps of them is split by who it belongs to: the Layout (the area and
// stack each Panel kind sits in, and its size) is app-wide, in settings; which Panels
// are open, the one shown and whether each area is shown belong to each
// Session, in the database.

/** The two Panel areas: the Side area, right of the conversation, and the Dock, under it. */
export const PANEL_AREAS = ['side', 'dock'] as const;
/** One of the two Panel areas. */
export type PanelArea = (typeof PANEL_AREAS)[number];

/**
 * The two Panel stacks an area can be split into: the first, and the second
 * below it in the Side area, right of it in the Dock. An area with Panels in
 * one stack only shows that one, unsplit.
 */
export const PANEL_STACKS = ['first', 'second'] as const;
/** One of an area's two Panel stacks. */
export type PanelStack = (typeof PANEL_STACKS)[number];

/** Whether `value` names one of an area's two Panel stacks. */
export function isPanelStack(value: unknown): value is PanelStack {
  return typeof value === 'string' && (PANEL_STACKS as readonly string[]).includes(value);
}

/** Where a Panel sits: an area, and a stack of it. */
export interface PanelPlace {
  area: PanelArea;
  stack: PanelStack;
}

/** Whether `a` and `b` are the same area and stack. */
export function samePlace(a: PanelPlace, b: PanelPlace): boolean {
  return a.area === b.area && a.stack === b.stack;
}

/** The kinds of Panel Loom has. */
export const PANEL_KINDS = ['changes', 'merge-request', 'issue', 'highlights', 'terminal'] as const;
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

/** Each Panel kind's area and sizes: Changes, the Merge request, the issue and Highlights open in the Side area, Terminals in the Dock. */
export const PANEL_SPECS: Record<PanelKind, PanelKindSpec> = {
  changes: { area: 'side', width: { min: 280, preferred: 640 }, height: { min: 120, preferred: 340 }, several: false },
  'merge-request': { area: 'side', width: { min: 320, preferred: 400 }, height: { min: 160, preferred: 320 }, several: false },
  issue: { area: 'side', width: { min: 300, preferred: 380 }, height: { min: 120, preferred: 260 }, several: false },
  highlights: { area: 'side', width: { min: 280, preferred: 380 }, height: { min: 120, preferred: 280 }, several: false },
  terminal: { area: 'dock', width: { min: 320, preferred: 520 }, height: { min: 120, preferred: 280 }, several: true },
};

/** How large any Panel can be dragged, in pixels; a smaller window caps it lower still (see the renderer's PanelArea). */
export const PANEL_MAX_SIZE: Record<PanelDimension, number> = { width: 1200, height: 1200 };

/** The size a Panel takes across `area`. */
export function dimensionOf(area: PanelArea): PanelDimension {
  return area === 'side' ? 'width' : 'height';
}

/** The size a Panel takes along `area`, which a split area's second stack takes from the Panel it shows: its height in the Side area, its width in the Dock. */
export function splitDimensionOf(area: PanelArea): PanelDimension {
  return area === 'side' ? 'height' : 'width';
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

/** The Layout: the area and stack each Panel kind sits in and its size, as the user left them, the same for every Session. */
export interface LayoutSettings {
  /** The area each kind sits in, for those the user moved; the others sit in the one their kind opens in. */
  area: Partial<Record<PanelKind, PanelArea>>;
  /** The kinds that sit in their area's second stack, splitting it; the others sit in its first. */
  stack: Partial<Record<PanelKind, 'second'>>;
  /** Each kind's width in the Side area, for those the user resized. */
  width: Partial<Record<PanelKind, number>>;
  /** Each kind's height in the Dock, for those the user resized. */
  height: Partial<Record<PanelKind, number>>;
}

/** The Layout until the user moves or resizes a Panel: each kind in the first stack of the area it opens in, at its preferred size. */
export const DEFAULT_LAYOUT: LayoutSettings = { area: {}, stack: {}, width: {}, height: {} };

/** The area Panels of `kind` sit in, in the Layout: where the user moved them, or the one the kind opens in. */
export function panelArea(layout: LayoutSettings, kind: PanelKind): PanelArea {
  return layout.area[kind] ?? PANEL_SPECS[kind].area;
}

/** The place Panels of `kind` sit in, in the Layout: their area, and the stack of it. */
export function panelPlace(layout: LayoutSettings, kind: PanelKind): PanelPlace {
  return { area: panelArea(layout, kind), stack: layout.stack[kind] ?? 'first' };
}

/** `layout` with Panels of `kind` in `place`. */
export function withPanelPlace(layout: LayoutSettings, kind: PanelKind, { area, stack }: PanelPlace): LayoutSettings {
  const { [kind]: _, ...stacks } = layout.stack;
  return { ...layout, area: { ...layout.area, [kind]: area }, stack: stack === 'second' ? { ...stacks, [kind]: 'second' } : stacks };
}

/** The size of a Panel of `kind` in the Layout: the user's, or the kind's preferred one. */
export function panelSize(layout: LayoutSettings, kind: PanelKind, dimension: PanelDimension): number {
  return layout[dimension][kind] ?? PANEL_SPECS[kind][dimension].preferred;
}

/** What of `stored` Loom still takes: an area it has for a kind it has, the second stack for one, and a number for a kind's size, kept within bounds. */
export function readLayout(stored: unknown): LayoutSettings {
  const layout: LayoutSettings = { area: {}, stack: {}, width: {}, height: {} };
  if (typeof stored !== 'object' || stored === null) return layout;
  const areas = (stored as Record<string, unknown>).area;
  if (typeof areas === 'object' && areas !== null) {
    for (const [kind, area] of Object.entries(areas)) if (isPanelKind(kind) && isPanelArea(area)) layout.area[kind] = area;
  }
  const stacks = (stored as Record<string, unknown>).stack;
  if (typeof stacks === 'object' && stacks !== null) {
    for (const [kind, stack] of Object.entries(stacks)) if (isPanelKind(kind) && stack === 'second') layout.stack[kind] = stack;
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

/** One Panel stack of a Session's area: its Panels, in tab order, and the one shown. */
export interface PanelStackState {
  panels: PanelId[];
  /** One of `panels`; null with none. */
  shown: PanelId | null;
}

/**
 * One Panel area of a Session: the Panels of its first stack, in tab order,
 * the one shown, and whether the area is shown; with those of its second
 * stack, when it is split.
 */
export interface PanelAreaState extends PanelStackState {
  open: boolean;
  /** The second stack, present only with Panels in it. */
  second?: PanelStackState;
}

/** A Session's Panels, in each area. */
export type SessionPanels = Record<PanelArea, PanelAreaState>;

/** A new Session's Panels: Changes, in the Side area, shown. */
export const DEFAULT_SESSION_PANELS: SessionPanels = {
  side: { panels: ['changes'], shown: 'changes', open: true },
  dock: { panels: [], shown: null, open: false },
};

/** A stack with no Panel: an area's second, until it is split. */
const NO_STACK: PanelStackState = { panels: [], shown: null };

/** Stack `stack` of `area`. */
export function stackOf(area: PanelAreaState, stack: PanelStack): PanelStackState {
  return stack === 'first' ? { panels: area.panels, shown: area.shown } : (area.second ?? NO_STACK);
}

/** `area` with `state` as its stack `stack`: a second stack left with no Panel goes. */
function withStack(area: PanelAreaState, stack: PanelStack, state: PanelStackState): PanelAreaState {
  if (stack === 'first') return { ...area, panels: state.panels, shown: state.shown };
  const { second: _, ...rest } = area;
  return state.panels.length ? { ...rest, second: state } : rest;
}

/** Every Panel open in `area`, its first stack's then its second's. */
export function panelsIn(area: PanelAreaState): PanelId[] {
  return area.second ? [...area.panels, ...area.second.panels] : area.panels;
}

/** The stacks of `area` with Panels in them, in order; the first, empty, for an area with none. */
export function stacksShown(area: PanelAreaState): PanelStack[] {
  const shown = PANEL_STACKS.filter((stack) => stackOf(area, stack).panels.length > 0);
  return shown.length ? shown : ['first'];
}

/** The stack `panels` of `area` as a Session's: each a Panel, open once, the one shown among them (or the first). */
function checkStack(value: Record<string, unknown>, area: PanelArea, seen: Set<PanelId>): PanelStackState {
  const { panels, shown } = value;
  if (!Array.isArray(panels)) throw new Error(`The ${area} area's Panels must be a list.`);
  for (const panel of panels) {
    if (!isPanelId(panel)) throw new Error(`"${String(panel)}" is not a Panel.`);
    if (seen.has(panel)) throw new Error(`Panel "${panel}" is open twice.`);
    seen.add(panel);
  }
  const list = panels as PanelId[];
  return { panels: list, shown: list.includes(shown as PanelId) ? (shown as PanelId) : (list[0] ?? null) };
}

/**
 * `value` as a Session's Panels, or why it can't be: each area with its
 * Panels (each in one area and stack only), the one shown among them, and whether it
 * is shown, with its second stack when split. One shown that isn't open falls back to the stack's first.
 */
export function checkSessionPanels(value: unknown): SessionPanels {
  if (typeof value !== 'object' || value === null) throw new Error("A Session's Panels must be an object with a side and a dock area.");
  const seen = new Set<PanelId>();
  const areas = {} as SessionPanels;
  for (const area of PANEL_AREAS) {
    const state = (value as Record<string, unknown>)[area];
    if (typeof state !== 'object' || state === null) throw new Error(`The ${area} area is missing from the Session's Panels.`);
    const { open, second } = state as Record<string, unknown>;
    const first = checkStack(state as Record<string, unknown>, area, seen);
    if (typeof open !== 'boolean') throw new Error(`Whether the ${area} area is shown must be true or false.`);
    if (second !== undefined && (typeof second !== 'object' || second === null)) throw new Error(`The ${area} area's second stack must be an object.`);
    areas[area] = withStack({ ...first, open }, 'second', second ? checkStack(second as Record<string, unknown>, area, seen) : NO_STACK);
  }
  return areas;
}

/**
 * `panels` without the Terminals that `ended` says have, every one without
 * it, as all end when Loom quits: an area left with none is hidden.
 */
export function withoutTerminals(panels: SessionPanels, ended: (terminal: number) => boolean = () => true): SessionPanels {
  let next = panels;
  for (const area of PANEL_AREAS) {
    for (const panel of panelsIn(panels[area])) {
      const terminal = terminalOf(panel);
      if (terminal !== undefined && ended(terminal)) next = withoutPanel(next, panel);
    }
  }
  return next;
}

/** Whether `a` and `b` are the same Panels, shown the same way, however their objects were built. */
export function sameSessionPanels(a: SessionPanels, b: SessionPanels): boolean {
  return PANEL_AREAS.every((area) => a[area].open === b[area].open && PANEL_STACKS.every((stack) => sameStack(stackOf(a[area], stack), stackOf(b[area], stack))));
}

function sameStack(a: PanelStackState, b: PanelStackState): boolean {
  return a.shown === b.shown && a.panels.length === b.panels.length && a.panels.every((panel, i) => panel === b.panels[i]);
}

/** Whether `a` and `b` are the same Layout, however their objects were built. */
export function sameLayout(a: LayoutSettings, b: LayoutSettings): boolean {
  return (['area', 'stack', ...PANEL_DIMENSIONS] as const).every((part) => PANEL_KINDS.every((kind) => a[part][kind] === b[part][kind]));
}

/** The place `panel` is open in, if it is. */
export function placeOf(panels: SessionPanels, panel: PanelId): PanelPlace | undefined {
  for (const area of PANEL_AREAS) for (const stack of PANEL_STACKS) if (stackOf(panels[area], stack).panels.includes(panel)) return { area, stack };
  return undefined;
}

/** The area `panel` is open in, if it is. */
export function areaOf(panels: SessionPanels, panel: PanelId): PanelArea | undefined {
  return placeOf(panels, panel)?.area;
}

/** `panels` without `panel`: its neighbour is shown in its place, and an area left with none is hidden. */
export function withoutPanel(panels: SessionPanels, panel: PanelId): SessionPanels {
  const place = placeOf(panels, panel);
  if (!place) return panels;
  const area = panels[place.area];
  const { panels: list, shown } = stackOf(area, place.stack);
  const at = list.indexOf(panel);
  const left = list.filter((p) => p !== panel);
  const next = withStack(area, place.stack, { panels: left, shown: shown === panel ? (left[Math.min(at, left.length - 1)] ?? null) : shown });
  return { ...panels, [place.area]: { ...next, open: next.open && panelsIn(next).length > 0 } };
}

/**
 * `panels` with `panel` put in `place`, at `at` among its tabs (the end,
 * without): taken from where it was, whose stack shows its neighbour in its
 * place, and its area is hidden when left with none. `shown`, it is shown in
 * its stack and its area is shown; otherwise its stack shows what it showed,
 * or it when it showed none.
 */
export function withPanelAt(panels: SessionPanels, panel: PanelId, place: PanelPlace, { at, shown }: { at?: number; shown: boolean }): SessionPanels {
  const from = placeOf(panels, panel);
  // Its place among the tabs it stays among, once it is out of them.
  const before = from && samePlace(from, place) ? stackOf(panels[from.area], from.stack).panels.indexOf(panel) : -1;
  const index = at !== undefined && before !== -1 && before < at ? at - 1 : at;
  const next = withoutPanel(panels, panel);
  const area = next[place.area];
  const stack = stackOf(area, place.stack);
  const list = [...stack.panels];
  list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, panel);
  return { ...next, [place.area]: { ...withStack(area, place.stack, { panels: list, shown: shown ? panel : (stack.shown ?? panel) }), open: area.open || shown } };
}

/**
 * `panels` with each Panel in the area and stack its kind sits in, in
 * `layout`: one elsewhere goes to the end of its own, its old stack showing
 * its neighbour in its place, and its old area hidden when left with none.
 * One that was shown in a shown area is shown in its new place, and its new
 * area is shown.
 */
export function inLayout(panels: SessionPanels, layout: LayoutSettings): SessionPanels {
  let next = panels;
  for (const from of PANEL_AREAS) {
    for (const stack of PANEL_STACKS) {
      for (const panel of stackOf(panels[from], stack).panels) {
        const to = panelPlace(layout, kindOf(panel));
        if (samePlace(to, { area: from, stack })) continue;
        const source = next[from];
        next = withPanelAt(next, panel, to, { shown: source.open && stackOf(source, stack).shown === panel });
      }
    }
  }
  return next;
}
