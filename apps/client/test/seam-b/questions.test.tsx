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

/** OpenCode's question tool asking three questions, each with room for an answer of one's own but the last. */
const fields: QuestionField[] = [
  { type: 'select', key: 'q0', title: 'Color', description: 'Which color should the button be?', required: false, options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue', description: 'Like the sky' }] },
  { type: 'text', key: 'q0_custom', title: 'Color (other)', description: 'Type your own answer', required: false },
  { type: 'multiselect', key: 'q1', title: 'Sizes', required: false, options: [{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, { value: 'l', label: 'Large' }] },
  { type: 'text', key: 'q1_custom', title: 'Sizes (other)', description: 'Add your own answer', required: false },
  { type: 'select', key: 'q2', title: 'Shipping', required: false, options: [{ value: 'std', label: 'Standard' }, { value: 'exp', label: 'Express' }] },
];
const questions: TranscriptItem = { kind: 'question', id: 1, message: 'A few questions', fields, state: 'asked' };

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
  const composer = () => screen.getByRole('form', { name: 'Composer' });
  const panel = () => within(composer()).getByRole('group', { name: 'Question' });
  const prompt = () => within(composer()).getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
  const step = () => within(panel()).getByRole('heading').textContent;
  const click = (name: string | RegExp) => act(async () => fireEvent.click(within(panel()).getByRole('button', { name })));
  const type = async (text: string) => {
    fireEvent.change(prompt(), { target: { value: text } });
    await act(async () => fireEvent.keyDown(prompt(), { key: 'Enter' }));
  };
  const answers = () => main.invoked.filter((i) => i.command === 'sessions.answer').map((i) => i.params);
  return { main, composer, panel, prompt, step, click, type, answers };
}

describe("the agent's questions", () => {
  it('asks its questions one by one, in order, in a panel on the composer', async () => {
    const { panel, prompt, step, click, answers } = openSession([questions]);
    expect(panel().className).toContain('question');
    expect(within(panel()).getByText('A few questions')).toBeTruthy();
    expect(within(panel()).getByText('Question 1 of 3')).toBeTruthy();
    expect(step()).toBe('Color');
    expect(within(panel()).getByText('Which color should the button be?')).toBeTruthy();
    expect(within(panel()).getByText('Like the sky')).toBeTruthy();
    expect(prompt().placeholder).toBe('Type your own answer…');
    // The conversation keeps a card pointing at the panel.
    expect(within(screen.getByRole('log', { name: 'Conversation' })).getByRole('group', { name: 'Question' }).textContent).toContain('Answer below');

    // One answer only: choosing it goes on to the next question.
    await click(/Blue/);
    expect(step()).toBe('Sizes');
    expect(within(panel()).getByText('Question 2 of 3')).toBeTruthy();
    // Several answers: the user goes on with Next.
    await click('Small');
    await click('Medium');
    expect(step()).toBe('Sizes');
    await click('Next');
    expect(step()).toBe('Shipping');
    // No answer of one's own here: the composer is off.
    expect(prompt().placeholder).toBe('Answer the question above to go on.');
    expect(answers()).toEqual([]);

    // Choosing the last answer sends them all.
    await click('Express');
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { q0: 'blue', q1: ['s', 'm'], q2: 'exp' } }]);
  });

  it("takes an answer of one's own from the composer, going on where the question has only one answer", async () => {
    const { step, type, click, answers, prompt } = openSession([questions]);
    await type('Green');
    expect(prompt().value).toBe('');
    expect(step()).toBe('Sizes');
    // With several answers, one's own joins the choices and the user goes on with Next.
    await click('Large');
    await type('XL');
    expect(step()).toBe('Sizes');
    await click('Next');
    await click('Standard');
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { q0_custom: 'Green', q1: ['l'], q1_custom: 'XL', q2: 'std' } }]);
  });

  it('goes back to an earlier question to change its answer, keeping the others', async () => {
    const { panel, step, click, type, answers } = openSession([questions]);
    await type('Green');
    await click('Medium');
    await click('Next');
    expect(step()).toBe('Shipping');

    await click('Back');
    expect(step()).toBe('Sizes');
    expect(within(panel()).getByRole('button', { name: 'Medium' }).getAttribute('aria-pressed')).toBe('true');
    await click('Question 1: Color');
    expect(step()).toBe('Color');
    expect(within(panel()).getByText('Green')).toBeTruthy();
    // A choice replaces the answer of one's own.
    await click(/Red/);
    expect(step()).toBe('Sizes');
    await click('Next');
    await click('Express');
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { q0: 'red', q1: ['m'], q2: 'exp' } }]);
  });

  it("steps through a plugin's dialog the same way, holding on until what it needs is given, or dismisses it", async () => {
    const form: TranscriptItem = {
      kind: 'question',
      id: 1,
      message: 'Deploy settings',
      state: 'asked',
      fields: [
        { type: 'multiselect', key: 'regions', title: 'Regions', required: true, options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'Americas' }] },
        { type: 'number', key: 'replicas', title: 'Replicas', required: false, integer: true },
        { type: 'text', key: 'notes', title: 'Release notes', description: 'What changed', required: false },
        { type: 'boolean', key: 'confirm', title: 'Run migrations?', required: true },
      ],
    };
    const { panel, step, click, type, answers, prompt } = openSession([form]);
    const next = () => within(panel()).getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(next().disabled).toBe(true);
    await click('Americas');
    expect(next().disabled).toBe(false);
    await click('Next');

    expect(step()).toBe('Replicas');
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '3' } });
    await click('Next');

    // A text answer is typed in the composer.
    expect(step()).toBe('Release notes');
    expect(prompt().placeholder).toBe('What changed…');
    await type('Faster invoices');
    expect(step()).toBe('Run migrations?');
    await click('Yes');
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { regions: ['us'], replicas: 3, notes: 'Faster invoices', confirm: true } }]);

    await click('Dismiss');
    expect(answers().at(-1)).toEqual({ id: 7, itemId: 1, answer: null });
  });

  it('shows why main refused an answer', async () => {
    const one: TranscriptItem = { kind: 'question', id: 1, message: 'Pick one', state: 'asked', fields: [fields[0]!, fields[1]!] };
    const { panel, click } = openSession([one], {
      'sessions.answer': () => {
        throw new Error('The agent is no longer asking this question.');
      },
    });
    await click(/Red/);
    expect(within(panel()).getByRole('alert').textContent).toBe('The agent is no longer asking this question.');
  });

  it('keeps answered, dismissed and expired questions in the conversation, with nothing left to click', () => {
    openSession([
      { ...questions, state: 'answered', answer: { q0: 'blue', q1: ['s', 'm'] } },
      { ...questions, id: 2, state: 'dismissed' },
      { ...questions, id: 3, state: 'expired' },
    ], {}, { ...asking, waitingReason: 'finished' });
    const chat = screen.getByRole('log', { name: 'Conversation' });
    const cards = within(chat).getAllByRole('group', { name: 'Question' });
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText('Answered')).toBeTruthy();
    expect(within(cards[0]!).getByText('Blue')).toBeTruthy();
    expect(within(cards[0]!).getByText('Small, Medium')).toBeTruthy();
    expect(within(cards[1]!).getByText('Dismissed')).toBeTruthy();
    expect(within(cards[2]!).getByText('No longer asked')).toBeTruthy();
    for (const card of cards) expect(within(card).queryAllByRole('button')).toEqual([]);
    expect(within(screen.getByRole('form', { name: 'Composer' })).queryByRole('group', { name: 'Question' })).toBeNull();
  });
});

describe("trusting a Project's local files", () => {
  it("asks with a card of its own, for the Project, and shows the Project's answer after", async () => {
    const trust: TranscriptItem = { kind: 'trust', id: 1, message: 'Trust the plugins in .opencode/?', state: 'asked' };
    const { main, prompt } = openSession([trust]);
    const card = () => within(screen.getByRole('log', { name: 'Conversation' })).getByRole('group', { name: 'Trust request' });
    const asked = card();
    // Answered on its card: the composer can't answer it.
    expect(prompt().placeholder).toBe('Answer the question above to go on.');
    expect(within(asked).getByText('Trust the plugins in .opencode/?')).toBeTruthy();
    expect(within(asked).getByText(/billing-api/)).toBeTruthy();
    await act(async () => fireEvent.click(within(asked).getByRole('button', { name: "Don't trust" })));
    await act(async () => fireEvent.click(within(asked).getByRole('button', { name: 'Trust' })));
    expect(main.invoked.filter((i) => i.command === 'sessions.trust').map((i) => i.params)).toEqual([
      { id: 7, itemId: 1, trusted: false },
      { id: 7, itemId: 1, trusted: true },
    ]);

    act(() => main.publish('transcript', [{ kind: 'user', id: 0, text: 'Add a button' }, { ...trust, state: 'trusted' }], { sessionId: 7 }));
    expect(within(card()).getByText('Trusted')).toBeTruthy();
    expect(within(card()).queryByRole('button')).toBeNull();
  });
});
