import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session, type SessionHighlights, type TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

const markdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  const Counted = (props: ComponentProps<typeof actual.default>) => {
    markdownRenders.count++;
    return createElement(actual.default, props);
  };
  return { ...actual, default: Counted };
});

afterEach(cleanup);

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

function openSession(transcript: TranscriptItem[], highlights?: SessionHighlights) {
  const main = new FakeMain({ projects: [project], sessions: [session], settings: { ...DEFAULT_SETTINGS, highlights: { on: !!highlights, model: 'anthropic/claude-haiku-5-5' } } });
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
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
}

const conversation = () => within(screen.getByRole('log', { name: 'Conversation' }));
const questionsShown = () => conversation().queryAllByText(/^Question \d+$/).map((el) => el.textContent);

describe('a long conversation', () => {
  it("doesn't render its messages again while typing in the composer", () => {
    openSession(conversationOf(3));
    const prompt = within(screen.getByRole('form', { name: 'Composer' })).getByRole('textbox', { name: 'Prompt' });
    const before = markdownRenders.count;

    for (const text of ['h', 'he', 'hel', 'hell', 'hello']) fireEvent.change(prompt, { target: { value: text } });

    expect(markdownRenders.count).toBe(before);
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
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      openSession(conversationOf(25), {
        highlights: [{ id: 1, kind: 'for-you', text: 'Set REDIS_URL before deploying.', itemId: 5, createdAt: 1 }],
        seenThrough: 1,
        pending: false,
        checking: false,
      });
      expect(questionsShown()).not.toContain('Question 2');

      fireEvent.click(within(screen.getByRole('tabpanel', { name: /Highlights/ })).getByRole('button', { name: 'From this turn' }));

      expect(questionsShown()[0]).toBe('Question 2');
      expect(scrolled.at(-1)?.getAttribute('data-item-id')).toBe('4');
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});
