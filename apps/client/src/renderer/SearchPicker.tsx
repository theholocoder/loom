// A searchable picker for a new worktree Session: the `origin` branch to
// branch from, or the existing worktree (or branch, in a new worktree) to work
// in. Lists what main listed with `projects.branches`.
import { ChevronDown, GitBranch } from 'lucide-react';
import { useRef, useState } from 'react';
import { Popover } from './Popover';

/** What `projects.branches` gave, or why it failed; undefined while it runs. */
export type Listed<T> = { branches: T } | { error: string } | undefined;

export interface PickerOption<T> {
  key: string;
  label: string;
  /** Shown muted after the label, and searched too. */
  detail?: string;
  value: T;
}

/** A `.pick` trigger opening a searchable list of `options`, once listed. */
export function SearchPicker<T>({
  label,
  placeholder,
  noun,
  options,
  selected,
  onChange,
}: {
  /** The trigger's accessible name. */
  label: string;
  /** What the trigger shows while nothing is selected. */
  placeholder: string;
  /** What the options are, plural, for the list and its search box: `branches`. */
  noun: string;
  options: Listed<PickerOption<T>[]>;
  /** The selected option's key and label; the label shows even before the options are listed. */
  selected?: { key: string; label: string };
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setSearch('');
  };
  const listed = options && 'branches' in options ? options.branches : undefined;
  const wanted = search.trim().toLowerCase();
  const shown = (listed ?? []).filter((option) => `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(wanted));
  const title = noun.charAt(0).toUpperCase() + noun.slice(1);

  return (
    <>
      <button ref={trigger} type="button" className="pick" title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <GitBranch className="sm" />
        <b className="tech ellipsis">{selected?.label ?? placeholder}</b>
        <ChevronDown className="chev" aria-hidden />
      </button>
      {open && (
        <Popover anchor={trigger} role="dialog" label={label} className="search-popover" onClose={close}>
          <input aria-label={`Search ${noun}`} placeholder={`Search ${noun}…`} data-autofocus value={search} onChange={(event) => setSearch(event.target.value)} />
          {options && 'error' in options && (
            <div className="err" role="alert">
              {options.error}
            </div>
          )}
          {!options && <div className="muted">Fetching origin…</div>}
          {listed && shown.length === 0 && <div className="muted">No {noun} found.</div>}
          <div role="listbox" aria-label={title}>
            {shown.map((option) => (
              <button
                key={option.key}
                type="button"
                role="option"
                aria-selected={option.key === selected?.key}
                onClick={() => {
                  close();
                  trigger.current?.focus();
                  onChange(option.value);
                }}
              >
                <span className="tech ellipsis">{option.label}</span>
                {option.detail && <span className="muted ellipsis">{option.detail}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
