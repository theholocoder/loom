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
  color: 'blue',
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
  /** Picks a choice with the mouse. */
  const pick = (name: string | RegExp, role: 'radio' | 'checkbox' = 'radio') =>
    act(async () => {
      const input = within(panel()).getByRole(role, { name });
      fireEvent.pointerDown(input);
      fireEvent.click(input);
    });
  const choice = (name: string | RegExp, role: 'radio' | 'checkbox' = 'radio') => within(panel()).getByRole(role, { name }) as HTMLInputElement;
  const type = async (text: string) => {
    fireEvent.change(prompt(), { target: { value: text } });
    await act(async () => fireEvent.keyDown(prompt(), { key: 'Enter' }));
  };
  const answers = () => main.invoked.filter((i) => i.command === 'sessions.answer').map((i) => i.params);
  return { main, composer, panel, prompt, step, click, pick, choice, type, answers };
}

describe("the agent's questions", () => {
  it('asks its questions one by one, in order, in a panel on the composer', async () => {
    const { composer, panel, prompt, step, click, pick, answers } = openSession([questions]);
    expect(within(panel()).getByText('A few questions')).toBeTruthy();
    expect(within(panel()).getByText('Question 1 of 3')).toBeTruthy();
    expect(step()).toBe('Color');
    expect(within(panel()).getByText('Which color should the button be?')).toBeTruthy();
    // Choices are a list, each with its description under it.
    expect(within(panel()).getAllByRole('radio').map((r) => r.getAttribute('aria-describedby') && document.getElementById(r.getAttribute('aria-describedby')!)?.textContent)).toEqual([null, 'Like the sky']);
    expect(prompt().placeholder).toBe('Type your own answer…');
    // No question numbers: Dismiss on one side, Back and Next on the other.
    expect(within(panel()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss', 'Next']);
    // Asked once, in the panel: the conversation has no card for it until it is answered.
    expect(within(screen.getByRole('log', { name: 'Conversation' })).queryByRole('group', { name: 'Question' })).toBeNull();
    // The composer gives the answer of one's own: it has no Send of its own, nor the reply's tools, the panel's Next going on.
    expect(within(composer()).queryByRole('button', { name: 'Send' })).toBeNull();
    expect(within(composer()).queryByRole('button', { name: 'Attach' })).toBeNull();

    // One answer only: choosing it goes on to the next question.
    await pick('Blue');
    expect(step()).toBe('Sizes');
    expect(within(panel()).getByText('Question 2 of 3')).toBeTruthy();
    // Several answers: the user goes on with Next.
    expect(within(panel()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dismiss', 'Back', 'Next']);
    await pick('Small', 'checkbox');
    await pick('Medium', 'checkbox');
    expect(step()).toBe('Sizes');
    await click('Next');
    expect(step()).toBe('Shipping');
    // No answer of one's own here: the composer is off.
    expect(prompt().placeholder).toBe('Answer the question above to go on.');
    expect(answers()).toEqual([]);

    // Choosing the last answer sends them all.
    await pick('Express');
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { q0: 'blue', q1: ['s', 'm'], q2: 'exp' } }]);
  });

  it("takes an answer of one's own from the composer, which goes on to the next question", async () => {
    const { step, type, pick, answers, prompt } = openSession([questions]);
    await type('Green');
    expect(prompt().value).toBe('');
    expect(step()).toBe('Sizes');
    // With several answers, one's own joins the choices, and sending it goes on too.
    await pick('Large', 'checkbox');
    await type('XL');
    expect(step()).toBe('Shipping');
    await pick('Standard');
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { q0_custom: 'Green', q1: ['l'], q1_custom: 'XL', q2: 'std' } }]);
  });

  it('goes back to an earlier question to change its answer, keeping the others', async () => {
    const { panel, step, click, pick, choice, type, answers } = openSession([questions]);
    await type('Green');
    await pick('Medium', 'checkbox');
    await click('Next');
    expect(step()).toBe('Shipping');

    await click('Back');
    expect(step()).toBe('Sizes');
    expect(choice('Medium', 'checkbox').checked).toBe(true);
    await click('Back');
    expect(step()).toBe('Color');
    expect(within(panel()).getByText('Green')).toBeTruthy();
    // A choice replaces the answer of one's own.
    await pick('Red');
    expect(step()).toBe('Sizes');
    await click('Next');
    await pick('Express');
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
    const { panel, step, click, pick, type, answers, prompt } = openSession([form]);
    const next = () => within(panel()).getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(next().disabled).toBe(true);
    await pick('Americas', 'checkbox');
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
    await pick('Yes');
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { regions: ['us'], replicas: 3, notes: 'Faster invoices', confirm: true } }]);

    await click('Dismiss');
    expect(answers().at(-1)).toEqual({ id: 7, itemId: 1, answer: null });
  });

  it('shows why main refused an answer', async () => {
    const one: TranscriptItem = { kind: 'question', id: 1, message: 'Pick one', state: 'asked', fields: [fields[0]!, fields[1]!] };
    const { panel, pick } = openSession([one], {
      'sessions.answer': () => {
        throw new Error('The agent is no longer asking this question.');
      },
    });
    await pick('Red');
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

describe('choosing with the keyboard', () => {
  it('selects with the arrow keys without going on, and goes on with Next', async () => {
    const { step, click, choice, answers } = openSession([questions]);
    // An arrow key moves the selection, which clicks the radio it lands on.
    fireEvent.keyDown(choice('Blue'), { key: 'ArrowUp' });
    await act(async () => fireEvent.click(choice('Red')));
    expect(choice('Red').checked).toBe(true);
    expect(step()).toBe('Color');
    await click('Next');
    expect(step()).toBe('Sizes');
    expect(answers()).toEqual([]);
  });

  it('goes on when the pointer picks a choice anywhere on its row, its description too', async () => {
    const { panel, step } = openSession([questions]);
    const description = within(panel()).getByText('Like the sky');
    fireEvent.pointerDown(description);
    await act(async () => fireEvent.click(description));
    expect(step()).toBe('Sizes');
  });
});

describe('answering step by step', () => {
  const form: TranscriptItem = {
    kind: 'question',
    id: 1,
    message: 'Deploy settings',
    state: 'asked',
    fields: [
      { type: 'number', key: 'replicas', title: 'Replicas', required: false, integer: true, minimum: 1, maximum: 5 },
      { type: 'multiselect', key: 'regions', title: 'Regions', required: false, maxItems: 1, options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'Americas' }] },
      { type: 'text', key: 'regions_custom', title: 'Regions (other)', required: false, maxLength: 5 },
      { type: 'text', key: 'notes', title: 'Release notes', required: false },
    ],
  };

  it("holds each question until its answer fits, saying why, before going on", async () => {
    const { panel, step, click, pick, type } = openSession([form]);
    const next = () => within(panel()).getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '9' } });
    expect(next().disabled).toBe(true);
    expect(within(panel()).getByRole('status').textContent).toBe('"Replicas" must be at most 5.');
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '2.5' } });
    expect(within(panel()).getByRole('status').textContent).toBe('"Replicas" can\'t be 2.5.');
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '2' } });
    expect(within(panel()).queryByRole('status')).toBeNull();
    await click('Next');

    expect(step()).toBe('Regions');
    await pick('Europe', 'checkbox');
    await pick('Americas', 'checkbox');
    expect(within(panel()).getByRole('status').textContent).toBe('"Regions" takes at most 1 choices.');
    await pick('Americas', 'checkbox');
    // An answer of one's own that doesn't fit stays in the composer, with the reason.
    await type('Antarctica');
    expect(step()).toBe('Regions');
    expect(within(panel()).getByRole('alert').textContent).toBe('"Regions (other)" takes at most 5 characters.');
    expect((screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe('Antarctica');

    // One's own answer that fits doesn't go on while the choices don't: it waits with them.
    await pick('Americas', 'checkbox');
    await type('Asia');
    expect(step()).toBe('Regions');
    expect(within(panel()).getByRole('status').textContent).toBe('"Regions" takes at most 1 choices.');
    expect(within(panel()).getByText('Asia')).toBeTruthy();
  });

  it("drops the error once the user moves on, and lets an answer of one's own be removed", async () => {
    const { panel, step, click, type, answers } = openSession([form], {
      'sessions.answer': () => {
        throw new Error('The agent is no longer asking this question.');
      },
    });
    await click('Next');
    await type('Asia');
    expect(step()).toBe('Release notes');
    await type('Fast');
    expect(within(panel()).getByRole('alert')).toBeTruthy();

    await click('Back');
    expect(within(panel()).queryByRole('alert')).toBeNull();
    expect(step()).toBe('Regions');
    expect(within(panel()).getByText('Asia')).toBeTruthy();
    await click('Remove your answer');
    expect(within(panel()).queryByText('Asia')).toBeNull();
    await click('Next');
    await click('Answer');
    expect(answers().at(-1)).toEqual({ id: 7, itemId: 1, answer: { notes: 'Fast' } });
  });

  it("takes what is typed in the composer as the answer when the panel's Next or Answer is clicked", async () => {
    const { prompt, step, click, pick, answers } = openSession([questions]);
    fireEvent.change(prompt(), { target: { value: 'Green' } });
    await click('Next');
    expect(step()).toBe('Sizes');
    expect(prompt().value).toBe('');
    await pick('Small', 'checkbox');
    await click('Next');
    await pick('Express');
    expect(answers()).toEqual([{ id: 7, itemId: 1, answer: { q0_custom: 'Green', q1: ['s'], q2: 'exp' } }]);

    // The last question's answer too, typed and not yet sent with Enter.
    const notes: TranscriptItem = { kind: 'question', id: 2, message: 'Release', state: 'asked', fields: [{ type: 'select', key: 'db', title: 'Database', required: true, options: [{ value: 'pg', label: 'postgres' }] }, { type: 'text', key: 'notes', title: 'Notes', required: false }] };
    cleanup();
    const second = openSession([notes]);
    await second.pick('postgres');
    fireEvent.change(second.prompt(), { target: { value: 'Use the replica' } });
    expect(within(second.panel()).getByRole('button', { name: 'Answer' })).toBeTruthy();
    await second.click('Answer');
    expect(second.answers()).toEqual([{ id: 7, itemId: 2, answer: { db: 'pg', notes: 'Use the replica' } }]);
  });

  it('keeps what is typed once the last answer is sent, as the next message', async () => {
    const notes: TranscriptItem = { kind: 'question', id: 1, message: 'Release', state: 'asked', fields: [{ type: 'text', key: 'notes', title: 'Release notes', required: false }] };
    let answered!: () => void;
    const { main, prompt, type } = openSession([notes], { 'sessions.answer': () => new Promise<void>((resolve) => (answered = resolve)) });

    await type('Fast');
    expect(prompt().value).toBe('');
    fireEvent.change(prompt(), { target: { value: 'Then tag the release' } });
    await act(async () => {
      main.publish('transcript', [{ kind: 'user', id: 0, text: 'Add a button' }, { ...notes, state: 'answered', answer: { notes: 'Fast' } }], { sessionId: 7 });
      main.publish('sessions', [{ ...asking, status: 'working', waitingReason: undefined }]);
      answered();
    });

    expect(prompt().value).toBe('Then tag the release');
  });

  it('empties the composer when a choice moves on, so its text never answers the next question', async () => {
    const { prompt, pick, step } = openSession([questions]);
    fireEvent.change(prompt(), { target: { value: 'Gre' } });
    await pick('Blue');
    expect(step()).toBe('Sizes');
    expect(prompt().value).toBe('');
  });
});
