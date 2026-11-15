// The Ctrl+K palette, following docs/prototypes/ui-layout.html: the Sessions
// the search finds (see session-search.ts) and the main actions, the
// Sessions first until something is typed. The search keeps the focus while
// the arrow keys move the highlight (aria-activedescendant).
import { CircleDot, GitPullRequest, Search, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { mergeRequestRef, type ConversationMatch, type Project, type Session } from '../shared/api';
import { useApi } from './api';
import { ProjectRemoved, useRemovedProjectIds } from './Archive';
import { stepIndex } from './Popover';
import { ProjectAvatar } from './ProjectAvatar';
import { SearchDialog } from './SearchDialog';
import { filterToken, parseQuery, searchSessions, suggestedFilters, toggleFilter } from './session-search';
import { shortcutLabel, type Shortcut } from './shortcuts';
import { StatusIcon } from './Sessions';

export interface PaletteAction {
  label: string;
  icon: LucideIcon;
  /** What runs it outside the palette. */
  shortcut?: Shortcut;
  /** `returnFocus` is where focus was before the palette, for an action opening a dialog of its own. */
  run: (returnFocus: HTMLElement | null) => void;
}

export interface CommandPaletteProps {
  actions: PaletteAction[];
  sessions: Session[];
  projects: Project[];
  onRun: (action: PaletteAction) => void;
  onOpenSession: (session: Session) => void;
  /** Closed without running anything. */
  onClose: () => void;
}

/** How long typing pauses before the conversations are searched, in ms. */
const CONVERSATION_SEARCH_DELAY_MS = 150;

/** Filters hide the actions: they are a Session search. */
export function CommandPalette({ actions, sessions, projects, onRun, onOpenSession, onClose }: CommandPaletteProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const parsed = parseQuery(query);
  const text = parsed.words.join(' ');
  const shownActions = parsed.filters.length ? [] : actions.filter((action) => action.label.toLowerCase().includes(text));
  const found = searchSessions(sessions, projects, parsed, useConversationSearch(parsed.words));
  const removed = useRemovedProjectIds();
  const results = shownActions.length + found.length;
  const highlighted = results ? stepIndex(active, results) : -1;
  // Until something is typed, the Sessions come first: there are many actions.
  const sessionsFirst = query.trim() === '';
  const sessionsAt = sessionsFirst ? 0 : shownActions.length;
  const actionsAt = sessionsFirst ? found.length : 0;
  const optionId = (index: number) => `${id}-option-${index}`;
  useEffect(() => {
    if (highlighted < 0) return;
    document.getElementById(optionId(highlighted))?.scrollIntoView?.({ block: 'nearest' });
  });
  const run = (index: number) => {
    const inActions = index >= actionsAt && index < actionsAt + shownActions.length;
    if (inActions) onRun(shownActions[index - actionsAt]!);
    else onOpenSession(found[index - sessionsAt]!.session);
  };
  const changeQuery = (next: string) => {
    setQuery(next);
    setActive(0);
  };
  const activeFilters = new Set(parsed.filters.map(filterToken));
  const option = (index: number, label: string, children: ReactNode, description?: string) => (
    <div
      key={index}
      id={optionId(index)}
      role="option"
      aria-label={label}
      aria-description={description}
      aria-selected={index === highlighted}
      onMouseMove={() => index !== highlighted && setActive(index)}
      // Keep the focus in the search.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => run(index)}
    >
      {children}
    </div>
  );

  const actionGroup = shownActions.length > 0 && (
    <Group id={`${id}-actions`} label="Actions">
      {shownActions.map((action, index) =>
        option(
          actionsAt + index,
          action.label,
          <>
            <action.icon className="sm" />
            <span className="grow ellipsis">{action.label}</span>
            {action.shortcut && <kbd>{shortcutLabel(action.shortcut)}</kbd>}
          </>,
        ),
      )}
    </Group>
  );
  const sessionGroup = found.length > 0 && (
    <Group id={`${id}-sessions`} label="Sessions" count={found.length}>
      {found.map(({ session, excerpt }, at) => {
        const project = projects.find((p) => p.id === session.projectId);
        return option(
          sessionsAt + at,
          session.title,
          <>
            <StatusIcon session={session} />
            {project && <ProjectAvatar project={project} size={18} />}
            <span className="grow palette-session">
              <span className="ellipsis">{session.title}</span>
              {excerpt && (
                <span className="muted ellipsis palette-excerpt" title={excerpt}>
                  {excerpt}
                </span>
              )}
            </span>
            {session.issue && (
              <span className="row muted tech" title="Issue">
                <CircleDot className="sm" />#{session.issue.number}
              </span>
            )}
            {session.mergeRequest && (
              <span className="row muted tech" title="Merge request">
                <GitPullRequest className="sm" />
                {mergeRequestRef(project?.forge.kind, session.mergeRequest.number)}
              </span>
            )}
            {project && <span className="muted ellipsis palette-project">{project.name}</span>}
            {!project && removed.has(session.projectId) && <ProjectRemoved />}
          </>,
          excerpt,
        );
      })}
    </Group>
  );

  return (
    <SearchDialog
      label="Command palette"
      icon={Search}
      search={{
        role: 'combobox',
        'aria-label': 'Search Sessions and actions',
        'aria-expanded': true,
        'aria-controls': `${id}-list`,
        'aria-autocomplete': 'list',
        'aria-activedescendant': highlighted >= 0 ? optionId(highlighted) : undefined,
        placeholder: 'Type a command, or search Sessions…',
        value: query,
        onChange: (event) => changeQuery(event.target.value),
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') setActive(stepIndex(highlighted + 1, results));
        else if (event.key === 'ArrowUp') setActive(stepIndex(highlighted - 1, results));
        else if (event.key === 'Enter') {
          if (highlighted >= 0) run(highlighted);
        } else return;
        event.preventDefault();
      }}
      onClose={onClose}
    >
      <div className="palette-filters" role="toolbar" aria-label="Filters">
        {suggestedFilters(projects).map((token) => (
          <button
            key={token}
            type="button"
            className="tech"
            aria-pressed={activeFilters.has(token.toLowerCase())}
            // Keep the focus in the search.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => changeQuery(toggleFilter(query, token))}
          >
            {token}
          </button>
        ))}
      </div>
      <div id={`${id}-list`} role="listbox" aria-label="Results" className="palette-results">
        {sessionsFirst ? (
          <>
            {sessionGroup}
            {actionGroup}
          </>
        ) : (
          <>
            {actionGroup}
            {sessionGroup}
          </>
        )}
        {results === 0 && <div className="muted palette-empty">No match.</div>}
      </div>
      <footer className="palette-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>Enter</kbd> run / open
        </span>
        <span>
          filters: <code>is:</code> <code>project:</code> <code>has:</code>
        </span>
      </footer>
    </SearchDialog>
  );
}

/**
 * What the conversations say of `words`, searched once typing pauses: the
 * last answer had, which may be for other words until the next comes. None
 * while no word is typed, or if the search failed.
 */
function useConversationSearch(words: string[]): ConversationMatch[] {
  const api = useApi();
  const [matches, setMatches] = useState<ConversationMatch[]>([]);
  const key = words.join(' ');
  useEffect(() => {
    if (!words.length) {
      setMatches([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api.invoke('sessions.searchConversations', { words }).then(
        (found) => current && setMatches(found),
        (error: unknown) => {
          console.error('conversation search failed:', error);
          if (current) setMatches([]);
        },
      );
    }, CONVERSATION_SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key]);
  return matches;
}

function Group({ id, label, count, children }: { id: string; label: string; count?: number; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <div id={id} className="palette-group" role="presentation">
        {label}
        {count !== undefined && ` · ${count}`}
      </div>
      {children}
    </div>
  );
}
