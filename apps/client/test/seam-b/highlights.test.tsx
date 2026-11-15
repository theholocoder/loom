import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type DiffSummary, type Highlight, type HighlightsSettings, type Project, type Session, type SessionHighlights, type TranscriptItem } from '../../src/shared/api';
import { settingsPage } from './settings-page';
import { FakeMain } from './fake-main';

type Handlers = NonNullable<ConstructorParameters<typeof FakeMain>[1]>;

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'billing-api',
  color: 'blue',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', host: 'github.com', repository: 'acme/billing-api' },
};
const session: Session = {
  id: 7,
  projectId: 1,
  title: 'Move sessions to Redis',
  workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/billing-api/redis' },
  branch: 'loom/redis',
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
  highlights: { count: 4, unseen: 2 },
};
const transcript: TranscriptItem[] = [
  { kind: 'user', id: 0, text: 'Move sessions to Redis' },
  { kind: 'agent', id: 1, text: 'Done.', streaming: false },
  { kind: 'user', id: 2, text: 'Add tests' },
  { kind: 'agent', id: 3, text: 'Added them.', streaming: false },
];
const highlights: Highlight[] = [
  { id: 1, kind: 'risk', text: 'The cache in src/cache.ts:12 is never invalidated.', itemId: 0, createdAt: 1 },
  { id: 2, kind: 'not-done', text: 'The e2e tests were skipped.', itemId: 0, createdAt: 1, resolved: { by: 'model', reason: 'Added in a later turn.', itemId: 2, at: 2 } },
  { id: 3, kind: 'for-you', text: 'Set REDIS_URL before deploying.', itemId: 2, createdAt: 2 },
  { id: 4, kind: 'risk', text: 'Sessions made before the switch are dropped.', itemId: 2, createdAt: 2 },
];
const value: SessionHighlights = { highlights, seenThrough: 2, pending: false, checking: false };
const summary: DiffSummary = { available: true, readOnly: false, base: 'origin/main', files: [{ path: 'src/cache.ts', status: 'committed', added: 1, removed: 0, binary: false }] };

function renderApp({ s = session, h = value, shown = 'highlights' as 'highlights' | 'changes', handlers = {} as Handlers, settings = { on: true, model: 'anthropic/claude-haiku-5-5' } as HighlightsSettings } = {}) {
  const main = new FakeMain({ projects: [project], sessions: [s], settings: { ...DEFAULT_SETTINGS, highlights: settings } }, { 'sessions.diff': () => summary, ...handlers });
  main.publish('panels', { side: { panels: ['changes', 'highlights'], shown, open: true }, dock: { panels: [], shown: null, open: false } }, { sessionId: s.id });
  main.publish('highlights', h, { sessionId: s.id });
  main.publish('transcript', transcript, { sessionId: s.id });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: s.title }));
  return main;
}

const panel = () => within(screen.getByRole('tabpanel', { name: /Highlights/ }));
const calls = (main: FakeMain, command: string) => main.invoked.filter((c) => c.command === command).map((c) => c.params);

describe('the Highlights Panel', () => {
  it('lists open Highlights by kind, For you first and newest first, the resolved ones folded', () => {
    renderApp();
    const groups = panel().getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(groups).toEqual(['For you', 'Risk', 'Resolved']);
    const risks = within(panel().getByRole('region', { name: 'Risk' })).getAllByRole('listitem').map((li) => li.querySelector('.hl-text')!.textContent);
    expect(risks).toEqual(['Sessions made before the switch are dropped.', 'The cache in src/cache.ts:12 is never invalidated.']);

    const resolved = within(panel().getByRole('region', { name: 'Resolved' }));
    expect(resolved.queryByText('The e2e tests were skipped.', { exact: false })).toBeNull();
    fireEvent.click(resolved.getByRole('button', { name: 'Resolved (1)' }));
    expect(resolved.getByText('Resolved: Added in a later turn.', { exact: false })).toBeTruthy();
  });

  it("badges its tab with what's new, and marks it seen once shown", async () => {
    const main = renderApp({ shown: 'changes' });
    const tab = screen.getByRole('tab', { name: /Highlights/ });
    expect(tab.getAttribute('aria-description')).toBe('2 new highlights');
    expect(calls(main, 'sessions.seeHighlights')).toEqual([]);

    fireEvent.click(tab);
    await waitFor(() => expect(calls(main, 'sessions.seeHighlights')).toEqual([{ id: 7 }]));
  });

  it('resolves and reopens a Highlight by hand', () => {
    const main = renderApp();
    const forYou = within(panel().getByRole('region', { name: 'For you' }));
    fireEvent.click(forYou.getByRole('button', { name: 'Resolve' }));
    fireEvent.click(within(panel().getByRole('region', { name: 'Resolved' })).getByRole('button', { name: 'Resolved (1)' }));
    fireEvent.click(within(panel().getByRole('region', { name: 'Resolved' })).getByRole('button', { name: 'Reopen' }));
    expect(calls(main, 'sessions.resolveHighlight')).toEqual([
      { id: 7, highlightId: 3, resolved: true },
      { id: 7, highlightId: 2, resolved: false },
    ]);
  });

  it('puts a Highlight to the agent as a comment in the composer', async () => {
    const main = renderApp();
    fireEvent.click(within(panel().getByRole('region', { name: 'For you' })).getByRole('button', { name: 'Ask the agent' }));
    const composer = within(screen.getByRole('form', { name: 'Composer' }));
    expect(composer.getByRole('button', { name: /^Edit comment on “For you: Set REDIS_URL/ })).toBeTruthy();

    fireEvent.click(composer.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls(main, 'sessions.send')).toHaveLength(1));
    expect(calls(main, 'sessions.send')[0]).toEqual({ id: 7, prompt: '', comments: [{ quote: 'For you: Set REDIS_URL before deploying.', note: 'Can you look into this?' }] });
  });

  it('takes the conversation to the turn a Highlight came from, and Changes to the file it names', async () => {
    const scrolled: Element[] = [];
    // jsdom has no scrolling: what is scrolled to is recorded instead.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      renderApp();
      fireEvent.click(within(panel().getByRole('region', { name: 'For you' })).getByRole('button', { name: 'From this turn' }));
      expect(scrolled.at(-1)?.getAttribute('data-item-id')).toBe('2');
      expect(scrolled.at(-1)?.textContent).toContain('Add tests');

      fireEvent.click(panel().getByRole('button', { name: 'src/cache.ts:12' }));
      expect(screen.getByRole('tab', { name: /Changes/ }).getAttribute('aria-selected')).toBe('true');
      await waitFor(() => expect(scrolled.some((el) => el.id.includes(encodeURIComponent('src/cache.ts')))).toBe(true));
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it('says when a check runs, and why the last one failed', () => {
    renderApp({ h: { ...value, checking: true } });
    expect(panel().getByRole('status').textContent).toContain('Checking the last turn with anthropic/claude-haiku-5-5');
    cleanup();
    renderApp({ h: { ...value, pending: true } });
    expect(panel().getByRole('status').textContent).toContain('Waiting for other checks to end before checking the last turn');
    cleanup();
    renderApp({ h: { ...value, error: "Session highlights' model didn't answer as asked." } });
    expect(panel().getByRole('alert').textContent).toContain("Last check failed: Session highlights' model didn't answer as asked.");
  });

  it('says what it is for before the first Highlight, and when the setting is off', () => {
    renderApp({ h: { highlights: [], seenThrough: 0, pending: false, checking: false } });
    expect(panel().getByText(/No highlights yet\. After each turn, anthropic\/claude-haiku-5-5 notes here/)).toBeTruthy();
    cleanup();
    renderApp({ h: { highlights: [], seenThrough: 0, pending: false, checking: false }, settings: { on: false } });
    expect(panel().getByText(/Turn Session highlights on in Settings/)).toBeTruthy();
  });

  it('is offered by the + menu even with Session highlights off, saying so once open', () => {
    renderApp({ s: { ...session, highlights: undefined }, h: { highlights: [], seenThrough: 0, pending: false, checking: false }, settings: { on: false }, shown: 'changes' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Highlights' }));
    fireEvent.click(screen.getByRole('button', { name: /Add a Panel/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Highlights/ }));
    expect(panel().getByText(/Turn Session highlights on in Settings/)).toBeTruthy();
  });
});

describe('the Session highlights setting', () => {
  it('turns on only once a model is picked', async () => {
    const main = new FakeMain({ projects: [project], settings: { ...DEFAULT_SETTINGS } }, { 'projects.models': () => [{ id: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: [] }] });
    render(
      <ApiProvider api={main}>
        <App />
      </ApiProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    settingsPage('Sessions');
    const box = screen.getByRole('checkbox', { name: 'Note highlights after each turn' }) as HTMLInputElement;
    expect(box.disabled).toBe(true);

    main.publish('settings', { ...DEFAULT_SETTINGS, highlights: { on: false, model: 'anthropic/claude-haiku-5-5' } });
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    expect(calls(main, 'settings.setHighlights')).toEqual([{ on: true, model: 'anthropic/claude-haiku-5-5' }]);
  });
});
