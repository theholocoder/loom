// A searchable single-choice picker: a `.pick` trigger opening a popover with
// a search box over a list main loads, such as the composer's branches and
// worktrees.
import { ChevronDown } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Popover } from './Popover';

/** What main gave for a request, or why it failed; undefined while it runs. */
export type Loaded<T> = { value: T } | { error: string } | undefined;

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
  icon,
  noun,
  loading,
  options,
  selected,
  disabled = false,
  onOpen,
  onChange,
}: {
  /** The trigger's accessible name. */
  label: string;
  /** What the trigger shows while nothing is selected. */
  placeholder: string;
  icon?: ReactNode;
  /** What the options are, plural, for the list and its search box: `branches`. */
  noun: string;
  /** What the list says while the options load. */
  loading: string;
  options: Loaded<PickerOption<T>[]>;
  /** The selected option's key and label; the label shows even before the options are listed. */
  selected?: { key: string; label: string };
  disabled?: boolean;
  /** Called when the list opens, e.g. to load the options again. */
  onOpen?: () => void;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setSearch('');
  };
  const pick = (value: T) => {
    close();
    trigger.current?.focus();
    onChange(value);
  };
  const listed = options && 'value' in options ? options.value : undefined;
  const wanted = search.trim().toLowerCase();
  const shown = (listed ?? []).filter((option) => `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(wanted));
  const title = noun.charAt(0).toUpperCase() + noun.slice(1);

  return (
    <>
      <button ref={trigger} type="button" className="pick" title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => {
          if (open) return close();
          setOpen(true);
          onOpen?.();
        }}
      >
        {icon}
        <b className="tech ellipsis">{selected?.label ?? placeholder}</b>
        <ChevronDown className="chev" aria-hidden />
      </button>
      {open && !disabled && (
        <Popover anchor={trigger} role="dialog" label={label} className="search-popover" onClose={close}>
          <input
            aria-label={`Search ${noun}`}
            placeholder={`Search ${noun}…`}
            data-autofocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // Enter in the search picks the first option shown, with no ↓ first.
              event.preventDefault();
              const first = shown[0];
              if (first) pick(first.value);
            }}
          />
          {options && 'error' in options && (
            <div className="err" role="alert">
              {options.error}
            </div>
          )}
          {!options && <div className="muted">{loading}</div>}
          {listed && shown.length === 0 && <div className="muted">No {noun} found.</div>}
          <div role="listbox" aria-label={title}>
            {shown.map((option) => (
              <button
                key={option.key}
                type="button"
                role="option"
                aria-selected={option.key === selected?.key}
                data-enter={option === shown[0] ? '' : undefined}
                onClick={() => pick(option.value)}
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
