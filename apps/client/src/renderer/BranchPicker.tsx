// Picking a branch for a new worktree Session: the `origin` branch to branch
// from, or an existing branch (local or on `origin`) to check out. A
// searchable list of what main listed with `projects.branches`.
import { ChevronDown, GitBranch } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ExistingBranch } from '../shared/api';
import { Popover } from './Popover';

/** How a branch reads: `origin/<name>` for one on `origin`. */
export function branchLabel(branch: ExistingBranch): string {
  return branch.remote ? `origin/${branch.name}` : branch.name;
}

/** What `projects.branches` gave, or why it failed; undefined while it runs. */
export type Listed<T> = { branches: T } | { error: string } | undefined;

/** A `.pick` trigger opening a searchable list of branches, as `listed` has them. */
export function BranchPicker({
  label,
  placeholder,
  listed,
  selected,
  onChange,
}: {
  /** The trigger's accessible name. */
  label: string;
  /** What the trigger shows while nothing is selected. */
  placeholder: string;
  listed: Listed<ExistingBranch[]>;
  selected?: ExistingBranch;
  onChange: (branch: ExistingBranch) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setSearch('');
  };
  const branches = listed && 'branches' in listed ? listed.branches : undefined;
  const wanted = search.trim().toLowerCase();
  const shown = (branches ?? []).filter((branch) => branchLabel(branch).toLowerCase().includes(wanted));
  const isSelected = (branch: ExistingBranch) => !!selected && selected.name === branch.name && selected.remote === branch.remote;

  return (
    <>
      <button ref={trigger} type="button" className="pick" title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <GitBranch className="sm" />
        <b className="tech ellipsis">{selected ? branchLabel(selected) : placeholder}</b>
        <ChevronDown className="chev" aria-hidden />
      </button>
      {open && (
        <Popover anchor={trigger} role="dialog" label={label} className="branch-popover" onClose={close}>
          <input aria-label="Search branches" placeholder="Search branches…" data-autofocus value={search} onChange={(event) => setSearch(event.target.value)} />
          {listed && 'error' in listed && (
            <div className="err" role="alert">
              {listed.error}
            </div>
          )}
          {!listed && <div className="muted">Fetching origin…</div>}
          {branches && shown.length === 0 && <div className="muted">No branches found.</div>}
          <div role="listbox" aria-label="Branches">
            {shown.map((branch) => (
              <button
                key={`${branch.remote}:${branch.name}`}
                type="button"
                role="option"
                className="tech"
                aria-selected={isSelected(branch)}
                onClick={() => {
                  close();
                  trigger.current?.focus();
                  onChange(branch);
                }}
              >
                {branchLabel(branch)}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
