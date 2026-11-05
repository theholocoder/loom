// Searching Sessions from the Ctrl+K palette: free text, narrowed by filters.
//   is:waiting | is:working | is:archived | is:unread
//   project:<name>   Projects whose name starts with it; quote names with spaces
//   has:mr | has:issue   any other has: narrows nothing
import { mergeRequestRef, type Project, type Session } from '../shared/api';

export type Filter = { kind: 'is' | 'project' | 'has'; value: string };

export interface SessionQuery {
  filters: Filter[];
  /** The words left once the filters are taken out, lower-cased. */
  words: string[];
}

const TOKEN = /(is|project|has):(?:"([^"]*)"?|(\S*))|(\S+)/gi;

export function parseQuery(query: string): SessionQuery {
  const filters: Filter[] = [];
  const words: string[] = [];
  for (const [, kind, quoted, plain, word] of query.matchAll(TOKEN)) {
    const value = (quoted ?? plain ?? '').toLowerCase();
    if (word !== undefined) words.push(word.toLowerCase());
    // A filter still being typed (`is:`) narrows nothing yet.
    else if (value) filters.push({ kind: kind!.toLowerCase() as Filter['kind'], value });
  }
  return { filters, words };
}

/** How a filter is written, quoted when it has spaces. */
export function filterToken({ kind, value }: Filter): string {
  return /\s/.test(value) ? `${kind}:"${value}"` : `${kind}:${value}`;
}

/** The filters the palette offers as chips: every status, unread, links, then each Project. */
export function suggestedFilters(projects: Project[]): string[] {
  return [
    ...['waiting', 'working', 'archived', 'unread'].map((value) => `is:${value}`),
    ...['mr', 'issue'].map((value) => `has:${value}`),
    ...projects.map((p) => filterToken({ kind: 'project', value: p.name })),
  ];
}

/** The query with `token` added, or taken out if it is in it already. */
export function toggleFilter(query: string, token: string): string {
  const wanted = token.toLowerCase();
  const tokens = [...query.matchAll(TOKEN)].map((match) => match[0]);
  const next = tokens.some((t) => t.toLowerCase() === wanted) ? tokens.filter((t) => t.toLowerCase() !== wanted) : [...tokens, token];
  return next.length ? `${next.join(' ')} ` : '';
}

const STATUS_ORDER: Record<Session['status'], number> = { waiting: 0, working: 1, archived: 2 };

/** The Sessions the query finds, each word in its title, branch, Project, issue or Merge request number: Waiting, then Working, then Archived, most recently changed first in each. */
export function searchSessions(sessions: Session[], projects: Project[], { filters, words }: SessionQuery): Session[] {
  const projectOf = (s: Session) => projects.find((p) => p.id === s.projectId);
  const passes = (s: Session, { kind, value }: Filter) => {
    switch (kind) {
      case 'is':
        return value === 'unread' ? s.unread : s.status === value;
      case 'has':
        return value === 'mr' ? !!s.mergeRequest : value === 'issue' ? !!s.issue : true;
      case 'project':
        return !!projectOf(s)?.name.toLowerCase().startsWith(value);
    }
  };
  const haystack = (s: Session) => {
    const project = projectOf(s);
    return [s.title, s.branch, project?.name, s.issue && `#${s.issue.number}`, s.mergeRequest && mergeRequestRef(project?.forge.kind, s.mergeRequest.number)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  };
  return sessions
    .filter((s) => {
      if (!filters.every((f) => passes(s, f))) return false;
      const found = haystack(s);
      return words.every((word) => found.includes(word));
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt);
}
