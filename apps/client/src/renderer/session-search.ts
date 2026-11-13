// Searching Sessions from the Ctrl+K palette: free text, found in what the
// Sessions are or in what was said in them, narrowed by filters.
//   is:waiting | is:snoozed | is:working | is:archived | is:unread
//   project:<name>   Projects whose name starts with it; quote names with spaces
//   has:mr | has:issue   any other has: narrows nothing
import { mergeRequestRef, type ConversationMatch, type Project, type Session } from '../shared/api';
import { isSnoozed } from './Snooze';

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

/** What each `is:` filter keeps; any other narrows to nothing. */
const IS_FILTERS: Record<string, (s: Session) => boolean> = {
  waiting: (s) => s.status === 'waiting',
  snoozed: isSnoozed,
  working: (s) => s.status === 'working',
  archived: (s) => s.status === 'archived',
  unread: (s) => s.unread,
};

/** The filters the palette offers as chips: every status, unread, links, then each Project. */
export function suggestedFilters(projects: Project[]): string[] {
  return [
    ...Object.keys(IS_FILTERS).map((value) => `is:${value}`),
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

/** A Session the search found, with what was said in it that it was found by, if any. */
export interface SessionHit {
  session: Session;
  /** Where the conversation holds words not found in the Session itself. */
  excerpt?: string;
}

/**
 * The Sessions the query finds, each word in its title, branch, Project,
 * issue or Merge request number, or in its conversation as `conversations`
 * say: they may be for other words while their search is under way, a
 * conversation holding `fonts` holding `font` too. Those found in
 * themselves come first, then those found by their conversations, each
 * Waiting, then Working, then Archived, most recently changed first: the
 * conversations' answer adds Sessions after those already shown.
 */
export function searchSessions(sessions: Session[], projects: Project[], { filters, words }: SessionQuery, conversations: ConversationMatch[] = []): SessionHit[] {
  const said = new Map(conversations.map((match) => [match.id, match]));
  const projectOf = (s: Session) => projects.find((p) => p.id === s.projectId);
  const passes = (s: Session, { kind, value }: Filter) => {
    switch (kind) {
      case 'is':
        return Object.hasOwn(IS_FILTERS, value) && IS_FILTERS[value]!(s);
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
    .flatMap((session): SessionHit[] => {
      if (!filters.every((f) => passes(session, f))) return [];
      const found = haystack(session);
      const unfound = words.filter((word) => !found.includes(word));
      if (!unfound.length) return [{ session }];
      const match = said.get(session.id);
      return match && unfound.every((word) => match.words.some((held) => held.includes(word))) ? [{ session, excerpt: match.excerpt }] : [];
    })
    .sort(
      (a, b) =>
        Number(a.excerpt !== undefined) - Number(b.excerpt !== undefined) ||
        STATUS_ORDER[a.session.status] - STATUS_ORDER[b.session.status] ||
        b.session.updatedAt - a.session.updatedAt,
    );
}
