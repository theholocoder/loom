// Picking the open issue a new Session starts from: a searchable list of the
// Project's open issues, listed by main through the Forge's CLI. Only offered
// when the Project's Forge features are on.
import { CircleDot, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Issue, Project } from '../shared/api';
import { useApi } from './api';

const SEARCH_DELAY_MS = 250;

export function IssuePicker({ project, issue, onChange }: { project: Project; issue?: Issue; onChange: (issue: Issue | undefined) => void }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [issues, setIssues] = useState<Issue[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = setTimeout(
      () => {
        api
          .invoke('projects.issues', { id: project.id, ...(search.trim() ? { search: search.trim() } : {}) })
          .then((found) => current && (setIssues(found), setError(undefined)))
          .catch((e: unknown) => current && (setIssues(undefined), setError((e as Error).message)));
      },
      search ? SEARCH_DELAY_MS : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, open, project.id, search]);

  if (project.forge.state !== 'available') return null;

  if (issue) {
    return (
      <span className="pick" title={issue.url}>
        <CircleDot className="sm" />
        <b className="ellipsis issue-title">
          #{issue.number} {issue.title}
        </b>
        <button type="button" className="icon-btn sm" aria-label="Unlink issue" onClick={() => onChange(undefined)}>
          <X className="sm" />
        </button>
      </span>
    );
  }

  return (
    <span className="menu-anchor">
      <button type="button" className="pick" aria-expanded={open} onClick={() => setOpen(!open)}>
        <CircleDot className="sm" />
        Issue
      </button>
      {open && (
        <div className="menu issue-menu" role="dialog" aria-label="Pick an issue">
          <input aria-label="Search issues" placeholder="Search open issues…" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} />
          {error && (
            <div className="err" role="alert">
              {error}
            </div>
          )}
          {issues?.length === 0 && <div className="muted">No open issues found.</div>}
          <div role="listbox" aria-label="Open issues">
            {issues?.map((found) => (
              <button
                key={found.number}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onChange(found);
                  setOpen(false);
                  setSearch('');
                }}
              >
                <span className="tech">#{found.number}</span> {found.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
