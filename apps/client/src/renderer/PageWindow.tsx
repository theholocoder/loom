// Projects, the Dashboard and Settings open in a window of their own over the
// main pane, the open Session left as it was beneath: the Inbox stays beside
// it to go to a Session, which closes it. In a wide window it floats over a
// dimmed Session; in a narrow one it takes all the room beside the Inbox.
// Esc, its close button or a click beside it closes it. What lies beneath
// it is inert meanwhile (the App sees to that), so neither the keyboard nor
// the pointer reaches the Session it covers.
import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useWindowLayout } from './WindowLayout';

/** The pages that open in the window. */
export type Page = 'projects' | 'dashboard' | 'settings';

const PAGE_TITLES: Record<Page, string> = { projects: 'Projects', dashboard: 'Dashboard', settings: 'Settings' };
/** The pages whose content has a width of its own: their window takes no more, so it isn't left empty beside it. The Dashboard's cards take all the room. */
const COMPACT: ReadonlySet<Page> = new Set(['projects', 'settings']);

/** The page window's class, by which views beneath it know it covers them. */
export const PAGE_WINDOW_CLASS = 'page-window';

/** Takes the focus when it opens, unless the page took it; the caller puts focus back once closed. */
export function PageWindow({ page, onClose, children }: { page: Page; onClose: () => void; children: ReactNode }) {
  const { narrow } = useWindowLayout();
  const element = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!element.current?.contains(document.activeElement)) element.current?.focus();
  }, [page]);
  // On the window, not the page: Esc closes it wherever the focus is, but for
  // what a field took, or a dialog or menu open over it when the key went down
  // (looked for before any handler runs, as one may close it without a word).
  useEffect(() => {
    let taken = false;
    const onKeyDownFirst = (event: KeyboardEvent) => {
      taken = !!document.querySelector('[aria-modal="true"], .popover') || (event.target instanceof Element && !!event.target.closest('.terminal-screen'));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || taken) return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', onKeyDownFirst, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDownFirst, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  const title = PAGE_TITLES[page];
  return (
    <div className={narrow ? 'page-window-scrim narrow' : 'page-window-scrim'} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={element} className={COMPACT.has(page) ? `${PAGE_WINDOW_CLASS} compact` : PAGE_WINDOW_CLASS} role="dialog" aria-label={title} tabIndex={-1}>
        <button className="icon-btn page-window-close" type="button" title="Close (Esc)" aria-label={`Close ${title}`} onClick={onClose}>
          <X />
        </button>
        {children}
      </div>
    </div>
  );
}
