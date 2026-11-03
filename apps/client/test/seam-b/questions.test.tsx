import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, QuestionField, Session, TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const asking: Session = {
  id: 7,
  projectId: 1,
  title: 'Add a button',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'question',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};

const colorFields: QuestionField[] = [
  { type: 'select', key: 'q0', title: 'Color', required: false, options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue', description: 'Like the sky' }] },
  { type: 'text', key: 'q0_custom', title: 'Color (other)', description: 'Type your own answer', required: false },
];
const colorQuestion: TranscriptItem = { kind: 'question', id: 1, message: 'Which color should the button be?', fields: colorFields, state: 'asked' };

/** The app with the Session open on `items` after its first prompt. */
function openSession(items: TranscriptItem[], handlers: ConstructorParameters<typeof FakeMain>[1] = {}, session: Session = asking) {
  const main = new FakeMain({ projects: [project], sessions: [session] }, handlers);
  main.publish('transcript', [{ kind: 'user', id: 0, text: 'Add a button' }, ...items], { sessionId: 7 });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  const card = (name: string | RegExp = /question/i) => within(screen.getByRole('log', { name: 'Conversation' })).getByRole('group', { name });
  const answers = () => main.invoked.filter((i) => i.command === 'sessions.answer').map((i) => i.params);
  return { main, card, answers };
}

describe("the agent's questions", () => {
  it('shows a highlighted question card whose options answer in one click', async () => {
    const { card, answers } = openSession([colorQuestion]);
    expect(card().className).toContain('question');
    expect(within(card()).getByText('Which color should the button be?')).toBeTruthy();
    expect(within(card()).getByText('Like the sky')).toBeTruthy();

    await act(async () => fireEvent.click(within(card()).getByRole('button', { name: /Blue/ })));
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { q0: 'blue' } }]);
  });

  it('takes an answer of your own where the question allows one', async () => {
    const { card, answers } = openSession([colorQuestion]);
    fireEvent.change(within(card()).getByRole('textbox', { name: 'Color (other)' }), { target: { value: 'Green' } });
    await act(async () => fireEvent.click(within(card()).getByRole('button', { name: 'Answer' })));
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { q0_custom: 'Green' } }]);
  });

  it("fills in a plugin's dialog as a form, Answer only once what it needs is given, or dismisses it", async () => {
    const form: TranscriptItem = {
      kind: 'question',
      id: 1,
      message: 'Deploy settings',
      state: 'asked',
      fields: [
        { type: 'select', key: 'target', title: 'Target', required: true, default: 'staging', options: [{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }] },
        { type: 'text', key: 'notes', title: 'Release notes', required: false },
        { type: 'multiselect', key: 'regions', title: 'Regions', required: true, options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'Americas' }] },
        { type: 'number', key: 'replicas', title: 'Replicas', required: false, integer: true },
        { type: 'boolean', key: 'confirm', title: 'Run migrations?', required: true, default: false },
      ],
    };
    const { card, answers } = openSession([form]);
    const submit = () => within(card()).getByRole('button', { name: 'Answer' }) as HTMLButtonElement;
    // The default is chosen; picking an option doesn't send yet, as there is more to fill in.
    expect(within(card()).getByRole('button', { name: 'Staging' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(card()).getByRole('button', { name: 'Production' }));
    expect(within(card()).getByRole('button', { name: 'Production' }).getAttribute('aria-pressed')).toBe('true');
    expect(answers()).toEqual([]);
    expect(submit().disabled).toBe(true);

    fireEvent.change(within(card()).getByRole('textbox', { name: 'Release notes' }), { target: { value: 'Faster invoices' } });
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'Europe' }));
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'Americas' }));
    fireEvent.change(within(card()).getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '3' } });
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'Run migrations?' }));
    expect(submit().disabled).toBe(false);
    await act(async () => fireEvent.click(submit()));
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { target: 'production', notes: 'Faster invoices', regions: ['eu', 'us'], replicas: 3, confirm: true } }]);

    await act(async () => fireEvent.click(within(card()).getByRole('button', { name: 'Dismiss' })));
    expect(answers().at(-1)).toEqual({ id: 7, itemId: 1, answer: null });
  });

  it('shows why main refused an answer', async () => {
    const { card } = openSession([colorQuestion], {
      'sessions.answer': () => {
        throw new Error('The agent is no longer asking this question.');
      },
    });
    await act(async () => fireEvent.click(within(card()).getByRole('button', { name: /Red/ })));
    expect(within(card()).getByRole('alert').textContent).toBe('The agent is no longer asking this question.');
  });

  it('keeps answered, dismissed and expired questions in the conversation, with nothing left to click', () => {
    openSession([
      { ...colorQuestion, state: 'answered', answer: { q0: 'blue' } },
      { ...colorQuestion, id: 2, state: 'dismissed' },
      { ...colorQuestion, id: 3, state: 'expired' },
    ], {}, { ...asking, waitingReason: 'finished' });
    const chat = screen.getByRole('log', { name: 'Conversation' });
    const cards = within(chat).getAllByRole('group', { name: /question/i });
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText('Answered')).toBeTruthy();
    expect(within(cards[0]!).getByText('Blue')).toBeTruthy();
    expect(within(cards[1]!).getByText('Dismissed')).toBeTruthy();
    expect(within(cards[2]!).getByText('No longer asked')).toBeTruthy();
    for (const card of cards) expect(within(card).queryAllByRole('button')).toEqual([]);
  });

  it('points the user at the question instead of the composer while it is asked', () => {
    openSession([colorQuestion]);
    const prompt = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
    expect(prompt.placeholder).toBe('Answer the question above to go on.');
    fireEvent.change(prompt, { target: { value: 'Make it green' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("trusting a Project's local files", () => {
  it("asks with a card of its own, for the Project, and shows the Project's answer after", async () => {
    const trust: TranscriptItem = { kind: 'trust', id: 1, message: 'Trust the plugins in .opencode/?', state: 'asked' };
    const { main, card } = openSession([trust]);
    const asked = card(/trust/i);
    expect(within(asked).getByText('Trust the plugins in .opencode/?')).toBeTruthy();
    expect(within(asked).getByText(/billing-api/)).toBeTruthy();
    await act(async () => fireEvent.click(within(asked).getByRole('button', { name: "Don't trust" })));
    await act(async () => fireEvent.click(within(asked).getByRole('button', { name: 'Trust' })));
    expect(main.invoked.filter((i) => i.command === 'sessions.trust').map((i) => i.params)).toEqual([
      { id: 7, itemId: 1, trusted: false },
      { id: 7, itemId: 1, trusted: true },
    ]);

    act(() => main.publish('transcript', [{ kind: 'user', id: 0, text: 'Add a button' }, { ...trust, state: 'trusted' }], { sessionId: 7 }));
    expect(within(card(/trust/i)).getByText('Trusted')).toBeTruthy();
    expect(within(card(/trust/i)).queryByRole('button')).toBeNull();
  });
});
