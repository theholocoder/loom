// Escape for a whole view or area, such as leaving Review mode: only the
// press nothing else took.

/**
 * Whether `event` is an Escape left for the view: no menu, search or dialog
 * took it (they prevent its default), none is open over the window, and it
 * wasn't pressed in a terminal, which has keys of its own.
 */
export function isFreeEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  if (event.target instanceof Element && event.target.closest('.terminal-screen')) return false;
  return !document.querySelector('[aria-modal="true"], .popover');
}
