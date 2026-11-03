import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

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
function openSession() {
  const main = new FakeMain({ projects: [project], sessions: [working] });
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
    expect(within(chat()).getByText('The tests fail on a typo.').closest('.msg')).toBeNull();

    show({ kind: 'thinking', id: 1, text: 'The tests fail on a typo.', streaming: false }, { kind: 'agent', id: 2, text: 'Fixed.', streaming: false });
    expect(header(/Thought/).getAttribute('aria-expanded')).toBe('false');
    expect(within(chat()).queryByText('The tests fail on a typo.')).toBeNull();
    expect(within(chat()).getByText('Fixed.').closest('.msg')?.className).toContain('agent');

    fireEvent.click(header(/Thought/));
    expect(header(/Thought/).getAttribute('aria-expanded')).toBe('true');
    expect(within(chat()).getByText('The tests fail on a typo.')).toBeTruthy();
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

  it('notes a truncated output, showing its marker as it is', () => {
    const { chat, show } = openSession();
    const output = 'HEAD>xxx\n… 2883584 bytes truncated …\nxxx<TAIL';

    show({ kind: 'tool', id: 1, toolCallId: 'call_big', title: 'cat big.log', status: 'completed', output, truncated: true });
    fireEvent.click(header(/cat big\.log/));

    expect(within(chat()).getByText('truncated')).toBeTruthy();
    expect(within(chat()).getByText((_, el) => el?.tagName === 'PRE' && el.textContent === output)).toBeTruthy();
  });
});
