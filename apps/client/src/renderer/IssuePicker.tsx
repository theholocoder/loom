// Picking an open issue, for a new Session to start from or for a Session to
// link: a searchable list of the Project's open issues, listed by main through
// the Forge's CLI. Only offered when the Project's Forge features are on.
// Pasting an issue's number or URL finds that issue (main does: searchIssues).
import { ChevronDown, CircleDot, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { FORGE_CLI, type ForgeStatus, type Issue, type Project } from '../shared/api';
import { splitDetails } from '../shared/errors';
import { ErrorText } from './ErrorText';
import { useApi } from './api';
import { Popover } from './Popover';

const SEARCH_DELAY_MS = 250;

/** `defaultOpen` shows the list from the start. */
export function IssuePicker({ project, issue, defaultOpen = false, onChange }: { project: Project; issue?: Issue; defaultOpen?: boolean; onChange: (issue: Issue | undefined) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const trigger = useRef<HTMLButtonElement>(null);

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

  return (
    <>
      <button ref={trigger} type="button" className="pick" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <CircleDot className="sm" />
        Issue
        <ChevronDown className="chev" aria-hidden />
      </button>
      {open && <IssueSearch project={project} anchor={trigger} onPick={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The Project's open issues beside `anchor`, searched as the user types; picking one closes it. */
export function IssueSearch({ project, anchor, onPick, onClose }: { project: Project; anchor: RefObject<HTMLElement | null>; onPick: (issue: Issue) => void; onClose: () => void }) {
  const api = useApi();
  const [search, setSearch] = useState('');
  // The issues found, and the search they were found for.
  const [found, setFound] = useState<{ search: string; issues: Issue[] }>();
  const issues = found?.issues;
  const [error, setError] = useState<string>();
  // Enter, pressed before the search's own issues came: the first of them is picked once they do.
  const [picking, setPicking] = useState(false);
  const pick = (issue: Issue) => {
    onClose();
    onPick(issue);
  };

  useEffect(() => {
    let current = true;
    const timer = setTimeout(
      () => {
        api
          .invoke('projects.issues', { id: project.id, ...(search.trim() ? { search: search.trim() } : {}) })
          .then((listed) => current && (setFound({ search, issues: listed }), setError(undefined)))
          .catch((e: unknown) => current && (setFound(undefined), setError((e as Error).message), setPicking(false)));
      },
      search ? SEARCH_DELAY_MS : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, project.id, search]);

  const listedForSearch = found?.search === search;
  useEffect(() => {
    if (!picking || !found || found.search !== search) return;
    setPicking(false);
    if (found.issues[0]) pick(found.issues[0]);
  }, [picking, found, search]);

  return (
    <Popover anchor={anchor} role="dialog" label="Pick an issue" className="issue-popover" onClose={onClose}>
      <input
        aria-label="Search issues"
        placeholder="Search open issues, or paste a number or URL…"
        data-autofocus
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          // Enter in the search picks the first issue it finds, with no ↓ first.
          event.preventDefault();
          if (!listedForSearch) setPicking(true);
          else if (issues?.[0]) pick(issues[0]);
        }}
      />
      {error && (
        <div className="err" role="alert">
          <ErrorText text={error} />
        </div>
      )}
      {issues?.length === 0 && <div className="muted">No open issues found.</div>}
      <div role="listbox" aria-label="Open issues">
        {issues?.map((issue, index) => (
          <button key={issue.number} type="button" role="option" aria-selected={false} data-enter={index === 0 && listedForSearch ? '' : undefined} onClick={() => pick(issue)}>
            <span className="tech">#{issue.number}</span> {issue.title}
          </button>
        ))}
      </div>
    </Popover>
  );
}

/** Why the Issue button is off, and what to do about it. */
function unavailableHint(forge: ForgeStatus): string {
  const said = forge.error && splitDetails(forge.error).message;
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
      return `Starting from an issue needs an origin on GitHub or GitLab${forge.host ? `; ${forge.host} isn't one gh or glab is signed in to` : ''}${said ? `. glab said: ${said}` : '.'}`;
    default:
      return `Couldn't check the Forge${said ? `: ${said}` : '.'}`;
  }
}
