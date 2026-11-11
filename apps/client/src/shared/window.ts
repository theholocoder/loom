// How Loom's window is shared out: the Inbox on the left, the conversation,
// and the Side area on the right, which slides over the conversation as a
// drawer in a narrow window (ADR 0009). The conversation always keeps its
// least width: the Side area and then the Inbox give way first, so the window
// never scrolls sideways, down to its smallest size.
import { PANEL_KINDS, PANEL_MAX_SIZE, PANEL_SPECS } from './panels';

/** The smallest Loom's window can be made, in pixels. */
export const MIN_WINDOW = { width: 720, height: 480 };

/** Below this window width the Side area is a drawer over the conversation rather than a column beside it. */
export const NARROW_WINDOW_WIDTH = 1100;

/** The least width the conversation (and its composer) is kept to. */
export const CONVERSATION_MIN_WIDTH = 360;

/** How much of the conversation's width the drawer may cover. */
const DRAWER_SHARE = 0.94;

/** The least width any Panel kind takes, which the Side area needs beside the conversation in a wide window. */
const PANEL_MIN_WIDTH = Math.max(...PANEL_KINDS.map((kind) => PANEL_SPECS[kind].width.min));

/** The Inbox's width, in pixels: until the user drags it, the least and the most it can be dragged to. */
export const INBOX_WIDTH = { min: 240, preferred: 360, max: 560 };

/** The width of the collapsed Inbox: a rail of icons. */
export const INBOX_RAIL_WIDTH = 48;

/** The Inbox as the user left it, the same across restarts. */
export interface InboxSettings {
  /** Its width when shown, within INBOX_WIDTH. */
  width: number;
  /** Whether it is shown, rather than collapsed to a rail. */
  open: boolean;
}

/** The Inbox until the user changes it: shown, at its preferred width. */
export const DEFAULT_INBOX: InboxSettings = { width: INBOX_WIDTH.preferred, open: true };

/** A width for the Inbox, rounded and kept within its least and most. */
export function clampInboxWidth(width: number): number {
  return Math.min(INBOX_WIDTH.max, Math.max(INBOX_WIDTH.min, Math.round(width)));
}

/** What Loom still takes of the Inbox `stored`: each part alone, the default for one it doesn't. */
export function readInbox(stored: unknown): InboxSettings {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_INBOX;
  const { width, open } = stored as Record<string, unknown>;
  return {
    width: typeof width === 'number' && Number.isFinite(width) ? clampInboxWidth(width) : DEFAULT_INBOX.width,
    open: typeof open === 'boolean' ? open : DEFAULT_INBOX.open,
  };
}

/** Whether a window `width` wide is narrow: its Side area a drawer. */
export function isNarrow(width: number): boolean {
  return width < NARROW_WINDOW_WIDTH;
}

/** How a window `width` wide is shared out, with the Inbox as `inbox` has it. */
export interface WindowLayout {
  width: number;
  narrow: boolean;
  /** The width the Inbox shows at: the rail's when collapsed. */
  inboxWidth: number;
  /** The least and most the Inbox can be dragged to in this window. */
  inboxBounds: { min: number; max: number };
  /** The most the Side area can be, beside the conversation or, narrow, over it. */
  sideMaxWidth: number;
}

/**
 * How a window `width` wide is shared out. The Inbox can't take the room the
 * conversation needs, nor, in a wide window, the room the Side area needs
 * beside it; the Side area then takes at most what the conversation leaves.
 */
export function windowLayout(width: number, inbox: InboxSettings): WindowLayout {
  const narrow = isNarrow(width);
  const room = width - CONVERSATION_MIN_WIDTH - (narrow ? 0 : PANEL_MIN_WIDTH);
  const inboxBounds = { min: INBOX_WIDTH.min, max: Math.max(INBOX_WIDTH.min, Math.min(INBOX_WIDTH.max, room)) };
  const inboxWidth = inbox.open ? Math.min(Math.max(inbox.width, inboxBounds.min), inboxBounds.max) : INBOX_RAIL_WIDTH;
  const beside = width - inboxWidth;
  const sideMaxWidth = Math.min(PANEL_MAX_SIZE.width, narrow ? Math.floor(beside * DRAWER_SHARE) : beside - CONVERSATION_MIN_WIDTH);
  return { width, narrow, inboxWidth, inboxBounds, sideMaxWidth };
}
