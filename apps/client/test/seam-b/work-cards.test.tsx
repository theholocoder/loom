import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

// The library draws in a shadow DOM; these tests stop at the texts Loom hands it.
vi.mock('@pierre/diffs/react', () => ({
  MultiFileDiff: ({ oldFile, newFile }: { oldFile: { name: string; contents: string }; newFile: { name: string; contents: string } }) => (
    <div data-testid="file-diff" data-path={newFile.name}>
      <pre>{oldFile.contents}</pre>
      <pre>{newFile.contents}</pre>
    </div>
  ),
}));

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const working: Session = {
  id: 7,
  projectId: 1,
  title: 'Fix the tests',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'working',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};

/** The app with the Working Session open; `show` publishes its transcript. */
function openSession(session: Session = working) {
  const main = new FakeMain({ projects: [project], sessions: [session] });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Working' }));
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: working.title }));
  const chat = () => screen.getByRole('log', { name: 'Conversation' });
  const show = (...items: TranscriptItem[]) => act(() => main.publish('transcript', [{ kind: 'user', id: 0, text: 'Fix the tests' }, ...items], { sessionId: 7 }));
  return { chat, show };
}

const header = (name: RegExp) => screen.getByRole('button', { name });

describe("how a Session's agent worked", () => {
  it('shows thinking apart from the reply, open while it streams and folded once done', () => {
    const { chat, show } = openSession();

    show({ kind: 'thinking', id: 1, text: 'The tests fail on a typo.', streaming: true });
    expect(header(/Thinking…/).getAttribute('aria-expanded')).toBe('true');
    expect(within(chat()).getByText('The tests fail on a typo.').closest('.bubble')).toBeNull();

    show({ kind: 'thinking', id: 1, text: 'The tests fail on a typo.', streaming: false }, { kind: 'agent', id: 2, text: 'Fixed.', streaming: false });
    expect(header(/Thought/).getAttribute('aria-expanded')).toBe('false');
    expect(within(chat()).queryByText('The tests fail on a typo.')).toBeNull();
    expect(within(chat()).getByText('Fixed.').closest('.msg')?.className).toContain('agent');

    fireEvent.click(header(/Thought/));
    expect(header(/Thought/).getAttribute('aria-expanded')).toBe('true');
    expect(within(chat()).getByText('The tests fail on a typo.')).toBeTruthy();
  });

  it("heads the agent's words with its name and the model that said them, its thought under that line", () => {
    const { chat, show } = openSession({ ...working, agentConfig: { models: [{ id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }], efforts: [] } });
    const sonnet = 'anthropic/claude-sonnet-5-5';

    show(
      { kind: 'thinking', id: 1, text: 'A typo.', streaming: false, model: sonnet },
      { kind: 'agent', id: 2, text: 'Fixed.', streaming: false, model: sonnet },
      { kind: 'thinking', id: 3, text: 'Now the tests.', streaming: false, model: sonnet },
      { kind: 'tool', id: 4, toolCallId: 'call_1', title: 'pnpm test', command: 'pnpm test', status: 'completed' },
      { kind: 'agent', id: 5, text: 'Green.', streaming: false, model: 'openai/gpt-x' },
      { kind: 'agent', id: 6, text: 'From before.', streaming: false },
    );

    const turns = [...chat().querySelectorAll('.msg.agent')];
    // Each part of a turn under one line: its name, then its thought, then its words.
    const parts = (msg: Element) => [...msg.querySelectorAll('.name, .tool-head, .bubble')].map((el) => el.textContent);
    expect(turns.map(parts)).toEqual([
      ['OpenCode · Claude Sonnet 5.5', 'Thought', 'Fixed.'],
      ['OpenCode · Claude Sonnet 5.5', 'Thought'],
      ['OpenCode · openai/gpt-x', 'Green.'],
      ['OpenCode', 'From before.'],
    ]);
  });

  it('shows a tool call as a folded card that follows its status, with its input and output inside', () => {
    const { chat, show } = openSession();
    const call = { kind: 'tool', id: 1, toolCallId: 'call_1', title: 'Read src/app.ts', toolKind: 'read', input: '{ "filePath": "src/app.ts" }' } as const;

    show({ ...call, status: 'running' });
    expect(within(header(/Read src\/app\.ts/)).getByRole('img', { name: 'Running' })).toBeTruthy();
    expect(within(header(/Read src\/app\.ts/)).getByText('read')).toBeTruthy();
    expect(header(/Read src\/app\.ts/).getAttribute('aria-expanded')).toBe('false');

    show({ ...call, status: 'completed', output: 'export const app = 1;' });
    expect(within(header(/Read src\/app\.ts/)).getByRole('img', { name: 'Completed' })).toBeTruthy();
    expect(within(chat()).queryByText('export const app = 1;')).toBeNull();

    fireEvent.click(header(/Read src\/app\.ts/));
    expect(within(chat()).getByText('export const app = 1;').tagName).toBe('PRE');
    expect(within(chat()).getByText('{ "filePath": "src/app.ts" }')).toBeTruthy();
    expect(within(chat()).queryByText('truncated')).toBeNull();

    fireEvent.click(header(/Read src\/app\.ts/));
    expect(within(chat()).queryByText('export const app = 1;')).toBeNull();
  });

  it('shows a failed tool call in the same card, failed', () => {
    const { chat, show } = openSession();

    show({ kind: 'tool', id: 1, toolCallId: 'call_2', title: 'bash', toolKind: 'execute', status: 'failed', output: 'command not found: pnpx' });

    const card = header(/bash/);
    expect(within(card).getByRole('img', { name: 'Failed' })).toBeTruthy();
    fireEvent.click(card);
    expect(within(chat()).getByText('command not found: pnpx')).toBeTruthy();
  });

  it('shows each tool call on one line: its tool in mono, what it worked on, then its status', () => {
    const { show } = openSession();

    show(
      { kind: 'tool', id: 1, toolCallId: 'call_1', title: 'read', name: 'read', toolKind: 'read', subject: 'src/app.ts', status: 'completed' },
      { kind: 'tool', id: 2, toolCallId: 'call_2', title: 'pnpm test', toolKind: 'execute', command: 'pnpm test', status: 'running' },
      { kind: 'tool', id: 3, toolCallId: 'call_3', title: 'Look it up', status: 'completed' },
    );

    const read = header(/read/);
    const part = (el: Element) => ['tool-name', 'tool-title', 'tool-status'].find((name) => el.classList.contains(name));
    expect([...read.querySelectorAll('.tool-name, .tool-title, .tool-status')].map((el) => [part(el), el.textContent || el.getAttribute('aria-label')])).toEqual([
      ['tool-name', 'read'],
      ['tool-title', 'src/app.ts'],
      ['tool-status', 'Completed'],
    ]);
    // Without its name, its kind; a shell call says its command.
    expect(within(header(/pnpm test/)).getByText('execute').className).toContain('tool-name');
    expect(within(header(/pnpm test/)).getByText('pnpm test').className).toContain('tool-title');
    expect(within(header(/Look it up/)).getByText('tool').className).toContain('tool-name');
  });

  it('shows the command of a shell call, not its raw input', () => {
    const { chat, show } = openSession();

    show({ kind: 'tool', id: 1, toolCallId: 'call_1', title: 'pnpm test', name: 'bash', toolKind: 'execute', command: 'pnpm test', input: '{\n  "command": "pnpm test"\n}', status: 'completed', output: '2 passed' });
    fireEvent.click(header(/pnpm test/));

    expect(within(chat()).getByText('$ pnpm test').tagName).toBe('PRE');
    expect(within(chat()).queryByText(/"command"/)).toBeNull();
    expect(within(chat()).getByText('2 passed')).toBeTruthy();
  });

  it("shows an edit's diff of each file it changed, and says when one was too large to keep", () => {
    const { chat, show } = openSession();

    show({
      kind: 'tool',
      id: 1,
      toolCallId: 'call_1',
      title: 'edit',
      name: 'edit',
      toolKind: 'edit',
      subject: 'src/app.ts',
      input: '{ "oldString": "1", "newString": "2" }',
      status: 'completed',
      output: 'Edit applied successfully.',
      diffs: [
        { path: 'src/app.ts', oldText: 'const a = 1;\n', newText: 'const a = 2;\n' },
        { path: 'src/new.ts', newText: 'export {};\n' },
        { path: 'big.json', tooLarge: true },
      ],
      truncated: true,
    });
    fireEvent.click(header(/src\/app\.ts/));

    const diffs = within(chat()).getAllByTestId('file-diff');
    expect(diffs.map((d) => [d.dataset.path, ...[...d.querySelectorAll('pre')].map((p) => p.textContent)])).toEqual([
      ['src/app.ts', 'const a = 1;\n', 'const a = 2;\n'],
      ['src/new.ts', '', 'export {};\n'],
    ]);
    expect(within(chat()).getByText('big.json').closest('.tool-diff-path')?.textContent).toBe('big.json: too large to show');
    expect(within(chat()).queryByText(/oldString/)).toBeNull();
    expect(within(chat()).getByText('Edit applied successfully.')).toBeTruthy();
  });

  it("shows the agent's plan, each step with where it is, kept up to date", () => {
    const { chat, show } = openSession();
    const plan = (statuses: Array<'pending' | 'in_progress' | 'completed' | 'cancelled'>) =>
      ({ kind: 'plan', id: 1, entries: ['Find the typo', 'Fix it', 'Add a test'].map((content, at) => ({ content, status: statuses[at]! })) }) as const;
    const steps = () => within(within(chat()).getByRole('group', { name: 'Plan' })).getAllByRole('listitem').map((li) => [li.textContent, within(li).getByRole('img').getAttribute('aria-label')]);

    show(plan(['in_progress', 'pending', 'pending']));
    expect(within(chat()).getByRole('group', { name: 'Plan' }).textContent).toContain('0 of 3 done');
    expect(steps()).toEqual([
      ['Find the typo', 'In progress'],
      ['Fix it', 'Pending'],
      ['Add a test', 'Pending'],
    ]);

    show(plan(['completed', 'completed', 'cancelled']));
    expect(within(chat()).getByRole('group', { name: 'Plan' }).textContent).toContain('2 of 3 done');
    expect(steps()).toEqual([
      ['Find the typo', 'Done'],
      ['Fix it', 'Done'],
      ['Add a test', 'Cancelled'],
    ]);
  });

  it('shows nothing for a plan emptied', () => {
    const { chat, show } = openSession();

    show({ kind: 'plan', id: 1, entries: [] });
    expect(within(chat()).queryByRole('group', { name: 'Plan' })).toBeNull();
    expect(within(chat()).queryByRole('alert')).toBeNull();
  });

  it('notes a truncated output, showing its marker as it is', () => {
    const { chat, show } = openSession();
    const output = 'HEAD>xxx\n… 2883584 bytes truncated …\nxxx<TAIL';

    show({ kind: 'tool', id: 1, toolCallId: 'call_big', title: 'cat big.log', status: 'completed', output, truncated: true });
    fireEvent.click(header(/cat big\.log/));

    expect(within(chat()).getByText('truncated')).toBeTruthy();
    expect(within(chat()).getByText((_, el) => el?.tagName === 'PRE' && el.textContent === output)).toBeTruthy();
  });
});
