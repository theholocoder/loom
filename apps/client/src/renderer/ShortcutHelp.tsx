// The Ctrl+? list of every keyboard shortcut, searchable by what it does or
// by its keys.
import { Keyboard } from 'lucide-react';
import { useState } from 'react';
import { SearchDialog } from './SearchDialog';
import { SHORTCUTS, shortcutLabel, type ShortcutEntry } from './shortcuts';

const keysOf = (entry: ShortcutEntry) => entry.display ?? shortcutLabel(entry.shortcut);

/** Escape or a click on the backdrop closes it; the caller puts focus back. */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = Object.values(SHORTCUTS as Record<string, ShortcutEntry>).filter((entry) => {
    const text = `${entry.label} ${keysOf(entry)}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  // No shortcut runs while a dialog or menu is open, bar Ctrl+K and Ctrl+?.
  const groups = [
    {
      label: 'Even while typing',
      entries: shown.filter((e) => e.shortcut.ctrl),
    },
    {
      label: 'Outside text fields',
      entries: shown.filter((e) => !e.shortcut.ctrl),
    },
  ].filter((group) => group.entries.length);

  return (
    <SearchDialog
      label="Keyboard shortcuts"
      className="shortcut-help"
      icon={Keyboard}
      search={{
        type: 'search',
        'aria-label': 'Search shortcuts',
        placeholder: 'Search shortcuts by action or key…',
        value: query,
        onChange: (event) => setQuery(event.target.value),
      }}
      onClose={onClose}
    >
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
    </SearchDialog>
  );
}
