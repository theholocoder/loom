// The one popover the renderer opens from a trigger: menus, pickers and
// selects. It is placed against the viewport (fixed), so it never drops off
// the bottom of the window; it is themed by `.popover` in popover.css.
import './popover.css';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

export interface Rect {
  top: number;
  bottom: number;
  left: number;
}

export interface Placement {
  side: 'down' | 'up';
  /** Viewport offset of the popover's top edge (down) or bottom edge (up). */
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
}

const GAP = 4;
const MARGIN = 8;
/** The tallest a popover grows before its list scrolls. */
export const POPOVER_MAX_HEIGHT = 320;

/**
 * Where a popover of the given size goes beside its trigger: below when it
 * fits, otherwise on whichever side has more room, its height capped to that
 * room, and shifted left to stay inside the viewport.
 */
export function placePopover(trigger: Rect, viewport: { width: number; height: number }, size: { width: number; height: number }): Placement {
  const below = viewport.height - trigger.bottom - GAP - MARGIN;
  const above = trigger.top - GAP - MARGIN;
  const wanted = Math.min(size.height, POPOVER_MAX_HEIGHT);
  const side = wanted <= below || below >= above ? 'down' : 'up';
  const room = Math.max(0, side === 'down' ? below : above);
  const left = Math.max(MARGIN, Math.min(trigger.left, viewport.width - MARGIN - size.width));
  return {
    side,
    ...(side === 'down' ? { top: trigger.bottom + GAP } : { bottom: viewport.height - trigger.top + GAP }),
    left,
    maxHeight: Math.min(POPOVER_MAX_HEIGHT, room),
  };
}

const ITEMS = '[role="option"], [role="menuitem"]';

/** Arrow keys, Home/End move between items (and from an input into the list); Enter/Space pick the focused item. */
function navigate(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  const inInput = target.tagName === 'INPUT';
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
  const at = items.indexOf(target);
  const focus = (index: number) => items[Math.max(0, Math.min(items.length - 1, index))]?.focus();
  if (event.key === 'ArrowDown') focus(inInput ? 0 : at + 1);
  else if (event.key === 'ArrowUp') {
    const input = event.currentTarget.querySelector('input');
    if (at === 0 && input) input.focus();
    else focus(at - 1);
  } else if (event.key === 'Home' && !inInput) focus(0);
  else if (event.key === 'End' && !inInput) focus(items.length - 1);
  else if ((event.key === 'Enter' || event.key === ' ') && at >= 0) target.click();
  else return;
  event.preventDefault();
}

/**
 * A popover beside `anchor` (the trigger). Escape closes it and returns focus
 * to the trigger; a mousedown outside both closes it. On open, focus goes to
 * `[data-autofocus]`, else the selected item, else the first item.
 */
export function Popover({
  anchor,
  onClose,
  role,
  label,
  className,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  role: 'menu' | 'listbox' | 'dialog';
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const popover = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>();
  const close = useRef(onClose);
  close.current = onClose;

  const place = useCallback(() => {
    const el = popover.current;
    const trigger = anchor.current;
    if (!el || !trigger) return;
    const box = el.getBoundingClientRect();
    // Unmeasured (no layout yet): assume it is as tall as it may grow.
    const next = placePopover(trigger.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, { width: box.width, height: el.scrollHeight || POPOVER_MAX_HEIGHT });
    setPlacement((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [anchor]);

  // Contents change size as they load: re-place after every render.
  useLayoutEffect(place);

  useEffect(() => {
    const el = popover.current;
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('[aria-selected="true"]') ?? el?.querySelector<HTMLElement>(ITEMS))?.focus();
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !anchor.current?.contains(target)) close.current();
    };
    document.addEventListener('mousedown', closeOutside);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      window.removeEventListener('resize', place);
    };
  }, [anchor, place]);

  const style: CSSProperties = placement
    ? { top: placement.top, bottom: placement.bottom, left: placement.left, maxHeight: placement.maxHeight }
    : { top: 0, left: 0 }; // Placed by the layout effect before the first paint.

  return (
    <div
      ref={popover}
      className={['popover', className].filter(Boolean).join(' ')}
      data-side={placement?.side}
      role={role}
      aria-label={label}
      style={style}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
          anchor.current?.focus();
        } else navigate(event);
      }}
    >
      {children}
    </div>
  );
}

export interface SelectOption<T> {
  value: T;
  label: string;
}

/** A themed single-choice select: a `.pick` trigger opening a listbox popover. */
export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  icon,
  className,
  variant = 'field',
}: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  icon?: ReactNode;
  /** Extra classes for the trigger, and for its popover. */
  className?: string;
  /** `field` (default): a bordered field; `compact`: borderless, for a dense toolbar. */
  variant?: 'field' | 'compact';
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find((option) => option.value === value);
  return (
    <>
      <button ref={trigger} type="button" className={['pick', 'select', `select-${variant}`, className].filter(Boolean).join(' ')} title={label} aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon}
        <b>{current?.label}</b>
        <ChevronDown className="chev" aria-hidden />
      </button>
      {open && (
        <Popover anchor={trigger} role="listbox" label={label} className={className} onClose={() => setOpen(false)}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                if (option.value !== value) onChange(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </Popover>
      )}
    </>
  );
}
