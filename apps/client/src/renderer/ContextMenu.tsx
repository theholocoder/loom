// Right-click menus. An element adds its sections of items to the menu a
// right-click on it opens with `addToContextMenu`, from its `onContextMenu`:
// the innermost element's come first, as the event bubbles. Then come what
// any right-click offers: copying a branch name, path or worktree an element
// marks with `copyable`, and copying the text selected. The menu is
// themed like the other popovers; an item can open a popover of its own in
// its place, at the same point (a submenu, a small form).
import { Copy, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Popover } from './Popover';

export interface ContextMenuItem {
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Runs the item, once the menu has closed and focus is back where it was. */
  run?: () => void;
  /**
   * What the item opens in the menu's place, at the same point: a popover
   * against `anchor`, which calls `close` once done.
   */
  open?: (anchor: RefObject<HTMLElement | null>, close: () => void) => ReactNode;
}

/** Items shown together, between separators. */
export type ContextMenuSection = ContextMenuItem[];

/** The sections elements added to a right-click, by its native event. */
const added = new WeakMap<Event, ContextMenuSection[]>();

/** Adds `sections` to the menu this right-click opens, after those of the elements inside this one. */
export function addToContextMenu(event: ReactMouseEvent | MouseEvent, ...sections: ContextMenuSection[]): void {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  added.set(native, [...(added.get(native) ?? []), ...sections.filter((section) => section.length > 0)]);
}

/**
 * The attributes that offer to copy `value` on a right-click of an element,
 * or of anything in it, as "Copy <what>": `copyable('branch name', branch)`.
 */
export function copyable(what: string, value: string | undefined): { 'data-copy'?: string; 'data-copy-what'?: string } {
  return value ? { 'data-copy': value, 'data-copy-what': what } : {};
}

/** A path's last part: a worktree's folder name. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? path;
}

/** Puts `text` on the clipboard; a failure is only logged, as there is nowhere to say it. */
export function copyText(text: string): void {
  navigator.clipboard.writeText(text).catch((error: unknown) => console.error('could not copy:', error));
}

/** The text selected in the window, outside text fields (which offer their own Copy). */
export function selectedText(): string {
  const selection = window.getSelection();
  return selection && !selection.isCollapsed ? selection.toString() : '';
}

/** What every right-click offers: copying what the elements under it mark, and the text selected. */
function commonSections(target: Element | null): ContextMenuSection[] {
  const copies: ContextMenuSection = [];
  const seen = new Set<string>();
  for (let at = target?.closest('[data-copy]'); at; at = at.parentElement?.closest('[data-copy]')) {
    const what = at.getAttribute('data-copy-what') ?? 'text';
    const value = at.getAttribute('data-copy')!;
    if (seen.has(what)) continue;
    seen.add(what);
    copies.push({ label: `Copy ${what}`, icon: Copy, run: () => copyText(value) });
  }
  const inField = !!target?.closest('input, textarea, [contenteditable="true"]');
  const text = inField ? '' : selectedText();
  return [text ? [{ label: 'Copy', icon: Copy, run: () => copyText(text) }] : [], copies].filter((section) => section.length > 0);
}

interface Open {
  x: number;
  y: number;
  sections: ContextMenuSection[];
  /** Where focus was, to go back to. */
  returnFocus: HTMLElement | null;
  /** The item's popover shown in the menu's place, once one is picked. */
  item?: ContextMenuItem;
}

/** Shows the menu of every right-click in the window; render it once, anywhere. */
export function ContextMenuHost() {
  const [open, setOpen] = useState<Open>();
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // A terminal has its own copy and paste.
      if (target?.closest('.terminal-screen')) return;
      if (target?.closest('.context-menu')) {
        event.preventDefault();
        return;
      }
      const sections = [...(added.get(event) ?? []), ...commonSections(target)];
      event.preventDefault();
      if (!sections.length) {
        setOpen(undefined);
        return;
      }
      // From the keyboard (the menu key, Shift+F10), there is no pointer: the menu goes by the element.
      const box = target?.getBoundingClientRect();
      const fromKeyboard = event.clientX === 0 && event.clientY === 0 && box;
      const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen({ x: fromKeyboard ? box.left : event.clientX, y: fromKeyboard ? box.bottom : event.clientY, sections, returnFocus });
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);
  if (!open) return null;
  return createPortal(<OpenMenu key={`${open.x}:${open.y}`} open={open} onPick={(item) => setOpen({ ...open, item })} onClose={() => setOpen(undefined)} />, document.body);
}

function OpenMenu({ open, onPick, onClose }: { open: Open; onPick: (item: ContextMenuItem) => void; onClose: () => void }) {
  const point = useRef<HTMLDivElement>(null);
  const close = () => {
    open.returnFocus?.focus();
    onClose();
  };
  const pick = (item: ContextMenuItem) => {
    if (item.open) {
      onPick(item);
      return;
    }
    close();
    item.run?.();
  };
  return (
    <>
      {/* What the menu is placed against: the point clicked. */}
      <div ref={point} className="context-point" style={{ left: open.x, top: open.y }} />
      {open.item?.open ? (
        open.item.open(point, () => close())
      ) : (
        <Popover anchor={point} role="menu" label="Context menu" className="context-menu" onClose={close}>
          {open.sections.map((section, index) => (
            <Section key={index} first={index === 0} section={section} onPick={pick} />
          ))}
        </Popover>
      )}
    </>
  );
}

function Section({ first, section, onPick }: { first: boolean; section: ContextMenuSection; onPick: (item: ContextMenuItem) => void }) {
  return (
    <>
      {!first && <div role="separator" className="menu-separator" />}
      {section.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.label} type="button" role="menuitem" aria-label={item.label} disabled={item.disabled} onClick={() => onPick(item)}>
            {Icon ? <Icon className="sm" /> : <span className="menu-icon-space" />}
            <span className="grow">{item.label}</span>
          </button>
        );
      })}
    </>
  );
}
