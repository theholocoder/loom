// Subagents in the renderer: a card for each in the transcript, a readonly
// view of one in place of the conversation with a footer for the composer,
// and a Glance strip chip listing them while any runs.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, Subagent, TranscriptItem } from '../../src/shared/api';
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
const base: Session = {
  id: 7,
  projectId: 1,
  title: 'Fix the login bug',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'working',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
  model: 'opencode/pulse-free',
  canStopSubagents: true,
};

const explore: Subagent = { id: 'ses_child1', depth: 1, toolCallId: 'call_sub', agent: 'explore', description: 'Explore auth', status: 'running', startedAt: Date.now() - 65_000 };
const inner: Subagent = { id: 'ses_child2', parentId: 'ses_child1', depth: 2, toolCallId: 'call_inner', agent: 'general', description: 'Read the tests', model: 'anthropic/claude-haiku-5-5', status: 'completed', startedAt: 1, endedAt: 2 };

const card = (toolCallId: string, subagentId: string, status: 'running' | 'completed' = 'completed'): TranscriptItem => ({ kind: 'tool', id: 1, toolCallId, title: 'subagent', name: 'subagent', toolKind: 'think', status, subagentId });

/** The app with the Session open, its transcript and Subagents as given. */
function openSession(session: Partial<Session> = {}, { items = [card('call_sub', 'ses_child1')], subagents = [explore, inner] }: { items?: TranscriptItem[]; subagents?: Subagent[] } = {}) {
  const shown = { ...base, ...session };
  const main = new FakeMain({ projects: [project], sessions: [shown] });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  // Working Sessions are listed folded away; Waiting ones are in view.
  if (shown.status === 'working') fireEvent.click(screen.getByRole('button', { name: 'Working' }));
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: shown.title }));
  act(() => {
    main.publish('transcript', [{ kind: 'user', id: 0, text: 'Fix the login bug' }, ...items], { sessionId: 7 });
    main.publish('subagents', subagents, { sessionId: 7 });
  });
  const chat = () => screen.getByRole('log', { name: 'Conversation' });
  const subagentTranscript = (subagentId: string, list: TranscriptItem[]) => act(() => main.publish('subagentTranscript', list, { sessionId: 7, subagentId }));
  return { main, chat, subagentTranscript };
}

const subagentCard = (name: RegExp) => screen.getByRole('button', { name });

describe('Subagents', () => {
  it("show as a card where the agent started them: the agent, what it does, how it goes, and a Stop while it runs", () => {
    const { main, chat } = openSession();

    const shown = within(chat()).getByRole('group', { name: 'Subagent: Explore auth' });
    expect(within(shown).getByText('explore')).toBeTruthy();
    expect(within(shown).getByText('Running')).toBeTruthy();
    expect(within(shown).getByText(/1m/)).toBeTruthy();
    // No generic tool card for it.
    expect(within(chat()).queryByText('subagent')).toBeNull();

    fireEvent.click(within(shown).getByRole('button', { name: 'Stop Subagent Explore auth' }));
    expect(main.invoked.filter((c) => c.command === 'sessions.stopSubagent')).toEqual([{ command: 'sessions.stopSubagent', params: { id: 7, subagentId: 'ses_child1' } }]);
  });

  it('show an ended one without Stop, and its model when it is not the Session\'s', () => {
    const { chat } = openSession({}, { items: [card('call_inner', 'ses_child2')], subagents: [explore, inner] });

    const shown = within(chat()).getByRole('group', { name: 'Subagent: Read the tests' });
    expect(within(shown).getByText('Completed')).toBeTruthy();
    expect(within(shown).getByText('anthropic/claude-haiku-5-5')).toBeTruthy();
    expect(within(shown).queryByRole('button', { name: /Stop/ })).toBeNull();
  });

  it("open readonly in place of the conversation, a footer in place of the composer, nested ones within, back going up one level", () => {
    const { chat, subagentTranscript } = openSession();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeTruthy();

    fireEvent.click(subagentCard(/Open Subagent Explore auth/));
    subagentTranscript('ses_child1', [
      { kind: 'agent', id: 0, text: 'Looking in src/.', streaming: false },
      card('call_inner', 'ses_child2'),
    ]);
    const view = screen.getByRole('log', { name: 'Subagent Explore auth' });
    expect(within(view).getByText('Looking in src/.')).toBeTruthy();
    expect(screen.queryByRole('log', { name: 'Conversation' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
    const footer = screen.getByRole('contentinfo', { name: 'Subagent' });
    expect(within(footer).getByText('explore')).toBeTruthy();
    // Given no model of its own, it runs on the Session's.
    expect(within(footer).getByText('opencode/pulse-free')).toBeTruthy();
    expect(within(footer).getByText('Running')).toBeTruthy();
    expect(within(footer).getByText('Explore auth')).toBeTruthy();
    expect(within(footer).getByRole('button', { name: 'Stop Subagent Explore auth' })).toBeTruthy();

    fireEvent.click(within(view).getByRole('button', { name: /Open Subagent Read the tests/ }));
    subagentTranscript('ses_child2', [{ kind: 'agent', id: 0, text: 'The tests cover it.', streaming: false }]);
    expect(within(screen.getByRole('log', { name: 'Subagent Read the tests' })).getByText('The tests cover it.')).toBeTruthy();
    const nested = screen.getByRole('contentinfo', { name: 'Subagent' });
    expect(within(nested).getByText('anthropic/claude-haiku-5-5')).toBeTruthy();
    expect(within(nested).queryByRole('button', { name: /Stop/ })).toBeNull();

    fireEvent.click(within(nested).getByRole('button', { name: 'Back to Explore auth' }));
    expect(screen.getByRole('log', { name: 'Subagent Explore auth' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('contentinfo', { name: 'Subagent' })).getByRole('button', { name: 'Back to Fix the login bug' }));
    expect(chat()).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeTruthy();
  });

  it('list in a Glance strip chip while any runs, at every depth, a click opening one', () => {
    const { subagentTranscript } = openSession({ runningSubagents: 1 });
    const glance = screen.getByRole('group', { name: 'Session at a glance' });

    fireEvent.click(within(glance).getByRole('button', { name: '1 Subagent running' }));
    const list = screen.getByRole('dialog', { name: 'Subagents' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual(['exploreExplore authRunning', 'generalRead the testsCompleted']);
    expect(rows[1]!.closest('li')?.style.paddingLeft).not.toBe(rows[0]!.closest('li')?.style.paddingLeft);
    expect(within(list).queryByRole('button', { name: /Stop/ })).toBeNull();

    fireEvent.click(rows[1]!);
    subagentTranscript('ses_child2', []);
    expect(screen.getByRole('log', { name: 'Subagent Read the tests' })).toBeTruthy();
  });

  it('show no chip while none runs', () => {
    openSession({ status: 'waiting', waitingReason: 'finished' }, { subagents: [{ ...explore, status: 'completed', endedAt: 3 }] });
    expect(within(screen.getByRole('group', { name: 'Session at a glance' })).queryByRole('button', { name: /Subagent/ })).toBeNull();
  });

  it("leave the Session's Stop to its agent's run: while only Subagents work, there is none, and a message goes now", () => {
    openSession({ runningSubagents: 1, subagentsOnly: true });

    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).placeholder).toMatch(/^Reply to OpenCode…/);
  });

  it("name the Subagent an Approval request comes from, and point to it from the Subagent's view", () => {
    const approval: TranscriptItem = { kind: 'approval', id: 2, title: '/home/elsewhere/a.txt', tool: 'write', detail: '/home/elsewhere/a.txt', state: 'asked', subagent: { id: 'ses_child1', description: 'Explore auth' } };
    const { chat, subagentTranscript } = openSession({ status: 'waiting', waitingReason: 'approval', runningSubagents: 1 }, { items: [card('call_sub', 'ses_child1'), approval] });

    expect(within(chat()).getByText('From Subagent Explore auth')).toBeTruthy();

    fireEvent.click(subagentCard(/Open Subagent Explore auth/));
    subagentTranscript('ses_child1', []);
    const view = screen.getByRole('log', { name: 'Subagent Explore auth' });
    fireEvent.click(within(view).getByRole('button', { name: 'Answer it in the Session' }));
    expect(chat()).toBeTruthy();
  });
});
