// The shell the Ctrl+K palette and the Ctrl+? shortcuts list share: a modal
// over the app's `.scrim` with a search on top, which has the focus.
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';

export interface SearchDialogProps {
  label: string;
  className?: string;
  icon: LucideIcon;
  /** The search's own attributes: its label, value, onChange… */
  search: InputHTMLAttributes<HTMLInputElement>;
  /** Keys the dialog handles besides Escape; call `preventDefault` on those it takes. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Escape or a click on the backdrop; the caller puts focus back. */
  onClose: () => void;
  children: ReactNode;
}

export function SearchDialog({ label, className, icon: Icon, search, onKeyDown, onClose, children }: SearchDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="scrim palette-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={className ? `popover palette ${className}` : 'popover palette'}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else onKeyDown?.(event);
        }}
      >
        <div className="palette-in">
          <Icon className="sm" />
          <input ref={input} {...search} />
          <kbd>Esc</kbd>
        </div>
        {children}
      </div>
    </div>
  );
}
