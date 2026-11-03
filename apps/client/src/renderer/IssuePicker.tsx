// Picking the open issue a new Session starts from: a searchable list of the
// Project's open issues, listed by main through the Forge's CLI. Only offered
// when the Project's Forge features are on.
import { CircleDot, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FORGE_CLI, type ForgeStatus, type Issue, type Project } from '../shared/api';
import { useApi } from './api';
import { Popover } from './Popover';

const SEARCH_DELAY_MS = 250;

export function IssuePicker({ project, issue, onChange }: { project: Project; issue?: Issue; onChange: (issue: Issue | undefined) => void }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [issues, setIssues] = useState<Issue[]>();
  const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);

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

  if (project.forge.state === 'unknown') return null;
  if (project.forge.state !== 'available') {
    const hint = unavailableHint(project.forge);
    return (
      <>
        <button type="button" className="pick" disabled aria-describedby={`issue-hint-${project.id}`} title={hint}>
          <CircleDot className="sm" />
          Issue
        </button>
        <span id={`issue-hint-${project.id}`} hidden>
          {hint}
        </span>
      </>
    );
  }

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

  const close = () => {
    setOpen(false);
    setSearch('');
  };
  return (
    <>
      <button ref={trigger} type="button" className="pick" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <CircleDot className="sm" />
        Issue
      </button>
      {open && (
        <Popover anchor={trigger} role="dialog" label="Pick an issue" className="issue-popover" onClose={close}>
          <input aria-label="Search issues" placeholder="Search open issues…" data-autofocus value={search} onChange={(event) => setSearch(event.target.value)} />
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
                  close();
                }}
              >
                <span className="tech">#{found.number}</span> {found.title}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Why the Issue button is off, and what to do about it. */
function unavailableHint(forge: ForgeStatus): string {
  const cli = forge.kind ? FORGE_CLI[forge.kind] : 'gh or glab';
  const host = forge.host ?? 'the host';
  switch (forge.state) {
    case 'cli-missing':
      return `Install ${cli} and sign in to ${host} to start from an issue.`;
    case 'signed-out':
      return `Run \`${cli} auth login --hostname ${host}\` to start from an issue.`;
    case 'no-remote':
      return 'Starting from an issue needs an origin remote on GitHub or GitLab.';
    case 'unsupported':
      return `Starting from an issue needs an origin on GitHub or GitLab${forge.host ? `; ${forge.host} isn't one gh or glab is signed in to` : ''}.`;
    default:
      return `Couldn't check the Forge${forge.error ? `: ${forge.error}` : '.'}`;
  }
}
