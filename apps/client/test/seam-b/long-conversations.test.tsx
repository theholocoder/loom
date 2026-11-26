import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session, type SessionHighlights, type TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

const markdownRenders = vi.hoisted(() => ({ count: 0 }));
const conversationRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/renderer/MessageTimes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/MessageTimes')>();
  return {
    ...actual,
    withDays: (...args: Parameters<typeof actual.withDays>) => {
      conversationRenders.count++;
      return actual.withDays(...args);
    },
  };
});
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  const Counted = (props: ComponentProps<typeof actual.default>) => {
    markdownRenders.count++;
    return createElement(actual.default, props);
  };
  return { ...actual, default: Counted };
});

const scrolled: Element[] = [];
beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

const project: Project = {
  id: 1,
  name: 'billing-api',
  color: 'blue',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const session: Session = {
  id: 7,
  projectId: 1,
  title: 'Fix the timeout',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};

function conversationOf(turns: number): TranscriptItem[] {
  return Array.from({ length: turns }, (_, n): TranscriptItem[] => [
    { kind: 'user', id: 2 * n, text: `Question ${n}` },
    { kind: 'agent', id: 2 * n + 1, text: `Answer ${n}`, streaming: false },
  ]).flat();
}

type Handlers = NonNullable<ConstructorParameters<typeof FakeMain>[1]>;

function renderLoom(transcript: TranscriptItem[], { highlights, handlers }: { highlights?: SessionHighlights; handlers?: Handlers } = {}) {
  const main = new FakeMain({ projects: [project], sessions: [session], settings: { ...DEFAULT_SETTINGS, highlights: { on: !!highlights, model: 'anthropic/claude-haiku-5-5' } } }, handlers);
  main.publish('transcript', transcript, { sessionId: session.id });
  if (highlights) {
    main.publish('panels', { side: { panels: ['highlights'], shown: 'highlights', open: true }, dock: { panels: [], shown: null, open: false } }, { sessionId: session.id });
    main.publish('highlights', highlights, { sessionId: session.id });
  }
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

function openSession(transcript: TranscriptItem[], options?: Parameters<typeof renderLoom>[1]) {
  const main = renderLoom(transcript, options);
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  return main;
}


const conversation = () => within(screen.getByRole('log', { name: 'Conversation' }));
const prompt = () => within(screen.getByRole('form', { name: 'Composer' })).getByRole('textbox', { name: 'Prompt' });
const showEarlier = () => fireEvent.click(conversation().getByRole('button', { name: 'Show earlier messages' }));
const showFromHighlight = () => fireEvent.click(within(screen.getByRole('tabpanel', { name: /Highlights/ })).getByRole('button', { name: 'From this turn' }));
const highlightOnTurn2: SessionHighlights = {
  highlights: [{ id: 1, kind: 'for-you', text: 'Set REDIS_URL before deploying.', itemId: 5, createdAt: 1 }],
  seenThrough: 1,
  pending: false,
  checking: false,
};
const questionsShown = () => conversation().queryAllByText(/^Question \d+$/).map((el) => el.textContent);

describe('a long conversation', () => {
  it("doesn't render the Session again while typing in the composer", () => {
    openSession(conversationOf(3));
    fireEvent.change(prompt(), { target: { value: 'h' } });
    const renders = conversationRenders.count;

    for (const text of ['he', 'hel', 'hell', 'hello']) fireEvent.change(prompt(), { target: { value: text } });

    expect(conversationRenders.count).toBe(renders);
  });

  it("doesn't parse its messages again when the Session changes around them", async () => {
    const main = openSession(conversationOf(3));
    const renders = markdownRenders.count;

    main.publish('sessions', [{ ...session, title: 'Fix the export timeout' }]);

    await waitFor(() => expect(screen.getAllByText('Fix the export timeout').length).toBeGreaterThan(0));
    expect(markdownRenders.count).toBe(renders);
  });

  it('shows its last turns, and earlier ones when asked', () => {
    openSession(conversationOf(25));
    expect(questionsShown()).toEqual(Array.from({ length: 10 }, (_, n) => `Question ${n + 15}`));

    fireEvent.click(conversation().getByRole('button', { name: 'Show earlier messages' }));
    expect(questionsShown()).toHaveLength(20);
    expect(questionsShown()[0]).toBe('Question 5');

    fireEvent.click(conversation().getByRole('button', { name: 'Show earlier messages' }));
    expect(questionsShown()).toHaveLength(25);
    expect(conversation().queryByRole('button', { name: 'Show earlier messages' })).toBeNull();
  });

  it('shows the whole of a conversation of a few turns', () => {
    openSession(conversationOf(10));
    expect(questionsShown()).toHaveLength(10);
    expect(conversation().queryByRole('button', { name: 'Show earlier messages' })).toBeNull();
  });

  it('shows a turn no longer shown when a Highlight takes the conversation to it', () => {
    openSession(conversationOf(25), { highlights: highlightOnTurn2 });
    expect(questionsShown()).not.toContain('Question 2');

    showFromHighlight();

    expect(questionsShown()[0]).toBe('Question 2');
    expect(scrolled.at(-1)?.getAttribute('data-item-id')).toBe('4');
  });

  it('keeps a turn it was taken to as the agent goes on', async () => {
    const main = openSession(conversationOf(25), { highlights: highlightOnTurn2 });
    showFromHighlight();

    main.publish('transcript', conversationOf(27), { sessionId: session.id });

    await waitFor(() => expect(questionsShown().at(-1)).toBe('Question 26'));
    expect(questionsShown()[0]).toBe('Question 2');
  });

  it('goes back to its last turns once the user sends a message', async () => {
    const main = openSession(conversationOf(25));
    showEarlier();
    expect(questionsShown()).toHaveLength(20);

    fireEvent.change(prompt(), { target: { value: 'One more thing' } });
    fireEvent.click(within(screen.getByRole('form', { name: 'Composer' })).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(main.invoked.some((c) => c.command === 'sessions.send')).toBe(true));
    await waitFor(() => expect(questionsShown()).toHaveLength(10));
  });

  it('shows the turn a conversation search found in it, from the palette', async () => {
    renderLoom(conversationOf(25), {
      handlers: { 'sessions.searchConversations': () => [{ id: session.id, itemId: 5, words: ['redis'], excerpt: 'Answer 2' }] },
    });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const palette = within(screen.getByRole('dialog', { name: 'Command palette' }));
    fireEvent.change(palette.getByRole('combobox', { name: 'Search Sessions and actions' }), { target: { value: 'redis' } });

    fireEvent.click(await palette.findByRole('option', { name: session.title }));

    await waitFor(() => expect(questionsShown()[0]).toBe('Question 2'));
    expect(scrolled.at(-1)?.getAttribute('data-item-id')).toBe('4');
  });
});
