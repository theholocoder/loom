// The edge a pane is resized by: the Side area's left edge, the Dock's top
// edge, the Inbox's right edge.
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';

/** Which edge of its pane it is: the pane grows when it is dragged away from the pane. */
export type EdgeSide = 'left' | 'right' | 'top';

/** How far one arrow key press moves an edge, in pixels. */
const KEY_STEP = 24;

/**
 * An edge dragged, or moved with the arrow keys, to set its pane's size
 * within `min` and `max`; a double click puts it back to `preferred`.
 * `onResize` is told each size while dragging, `done` once let go.
 */
export function ResizeEdge({
  side,
  label,
  controls,
  size,
  min,
  max,
  preferred,
  onResize,
}: {
  side: EdgeSide;
  label: string;
  controls: string;
  size: number;
  min: number;
  max: number;
  preferred: number;
  onResize: (size: number, done: boolean) => void;
}) {
  const resize = useRef(onResize);
  resize.current = onResize;
  const across = side !== 'top';
  const bodyClass = across ? 'resizing' : 'resizing-rows';
  const clamp = (to: number) => Math.min(Math.max(to, min), max);
  // Dragging left widens a pane on the right; dragging right, one on the left; dragging up, one below.
  const grows = side === 'right' ? 1 : -1;
  const start = (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const from = { at: across ? event.clientX : event.clientY, size };
    const sizeAt = (e: MouseEvent) => clamp(from.size + grows * ((across ? e.clientX : e.clientY) - from.at));
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
    const grow = side === 'left' ? 'ArrowLeft' : side === 'right' ? 'ArrowRight' : 'ArrowUp';
    const shrink = side === 'left' ? 'ArrowRight' : side === 'right' ? 'ArrowLeft' : 'ArrowDown';
    const by = event.key === grow ? KEY_STEP : event.key === shrink ? -KEY_STEP : 0;
    if (!by) return;
    event.preventDefault();
    onResize(clamp(size + by), true);
  };
  return (
    <div
      className={`resize-edge ${side}`}
      role="separator"
      aria-orientation={across ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={size}
      title="Drag to resize, double-click to reset"
      tabIndex={0}
      onMouseDown={start}
      onDoubleClick={() => onResize(clamp(preferred), true)}
      onKeyDown={key}
    />
  );
}
