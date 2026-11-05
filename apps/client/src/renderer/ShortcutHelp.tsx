// The Ctrl+? list of every keyboard shortcut, searchable by what it does or
// by its keys. A modal over the app's `.scrim`, themed like the palette.
import { Keyboard } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SHORTCUTS, shortcutLabel, type ShortcutEntry } from './shortcuts';

const keysOf = (entry: ShortcutEntry) => entry.display ?? shortcutLabel(entry.shortcut);

/** Escape or a click on the backdrop closes it; the caller puts focus back. */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => input.current?.focus(), []);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = Object.values(SHORTCUTS as Record<string, ShortcutEntry>).filter((entry) => {
    const text = `${entry.label} ${keysOf(entry)}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const groups = [
    { label: 'Anywhere', entries: shown.filter((e) => e.shortcut.ctrl) },
    { label: 'Outside text fields', entries: shown.filter((e) => !e.shortcut.ctrl) },
  ].filter((group) => group.entries.length);

  return (
    <div className="scrim palette-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="popover palette shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onClose();
        }}
      >
        <div className="palette-in">
          <Keyboard className="sm" />
          <input ref={input} type="search" aria-label="Search shortcuts" placeholder="Search shortcuts by action or key…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results">
          {groups.length ? (
            <table className="shortcut-table">
              {groups.map((group) => (
                <tbody key={group.label}>
                  <tr>
                    <th colSpan={2} scope="rowgroup" className="palette-group">
                      {group.label}
                    </th>
                  </tr>
                  {group.entries.map((entry) => (
                    <tr key={entry.label}>
                      <td>{entry.label}</td>
                      <td>
                        <kbd>{keysOf(entry)}</kbd>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          ) : (
            <div className="muted palette-empty">No matching shortcut.</div>
          )}
        </div>
      </div>
    </div>
  );
}
