// The Ctrl+? list of every keyboard shortcut, as the user has them, searchable
// by what it does or by its keys. An action whose shortcut the user took off,
// or a single-key one while those are off, isn't listed.
import { Keyboard } from 'lucide-react';
import { useState } from 'react';
import { SearchDialog } from './SearchDialog';
import { SHORTCUTS, shortcutLabel, useBindings, type Shortcut, type ShortcutEntry, type ShortcutName } from './shortcuts';

/** A shortcut as the list shows it: the user's keys for its action. */
interface Listed {
  entry: ShortcutEntry;
  shortcut: Shortcut;
  keys: string;
}

/** The list's groups, in order. */
const GROUPS = ['Even while typing', 'Outside text fields', 'In the composer'] as const;
const groupOf = ({ entry, shortcut }: Listed): (typeof GROUPS)[number] => (entry.composer ? 'In the composer' : shortcut.ctrl && !entry.outsideTextFields ? 'Even while typing' : 'Outside text fields');

/** Escape or a click on the backdrop closes it; the caller puts focus back. */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const bindings = useBindings();

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const listed = (Object.keys(SHORTCUTS) as ShortcutName[]).flatMap((name): Listed[] => {
    const entry: ShortcutEntry = SHORTCUTS[name];
    const shortcut = bindings[name];
    // Only a shortcut Settings can't remap has a display of its own: Ctrl 1…9 stands for nine.
    return shortcut ? [{ entry, shortcut, keys: entry.display ?? shortcutLabel(shortcut) }] : [];
  });
  const shown = listed.filter(({ entry, keys }) => {
    const text = `${entry.label} ${keys}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  // No shortcut runs while a dialog or menu is open, bar Ctrl+K and Ctrl+?.
  const groups = GROUPS.map((label) => ({ label, entries: shown.filter((e) => groupOf(e) === label) })).filter((group) => group.entries.length);

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
                {group.entries.map(({ entry, keys }) => (
                  <tr key={entry.label}>
                    <td>{entry.label}</td>
                    <td>
                      <kbd>{keys}</kbd>
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
