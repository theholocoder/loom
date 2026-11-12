import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type Project, type Session, type TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};
const waiting: Session = {
  id: 7,
  projectId: 1,
  title: 'Ship it',
  workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/billing-api/ship-it' },
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'approval',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};
const forcePush: TranscriptItem = {
  kind: 'approval',
  id: 1,
  toolCallId: 'call_sh',
  title: 'git push --force origin HEAD',
  tool: 'shell',
  detail: 'git push --force origin HEAD',
  category: 'otherPush',
  state: 'asked',
};

function openSession(items: TranscriptItem[], handlers: ConstructorParameters<typeof FakeMain>[1] = {}) {
  const main = new FakeMain({ projects: [project], sessions: [waiting] }, handlers);
  main.publish('transcript', [{ kind: 'user', id: 0, text: 'Ship it' }, ...items], { sessionId: 7 });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: waiting.title }));
  const card = (index = 0) => screen.getAllByRole('group', { name: 'Approval request' })[index]!;
  const click = (name: string | RegExp, index = 0) => act(async () => fireEvent.click(within(card(index)).getByRole('button', { name })));
  const decisions = () => main.invoked.filter((i) => i.command === 'sessions.approve').map((i) => i.params);
  return { main, card, click, decisions };
}

describe('Approval requests', () => {
  it('shows the exact command and its category, and Approve once decides it', async () => {
    const { card, click, decisions } = openSession([forcePush]);
    expect(within(card()).getByText('git push --force origin HEAD', { selector: 'pre' })).toBeTruthy();
    expect(within(card()).getByText('The agent is asking you')).toBeTruthy();
    // The composer waits on the card.
    const composer = within(screen.getByRole('form', { name: 'Composer' }));
    expect((composer.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).placeholder).toBe('Approve or deny the request above to go on.');
    fireEvent.change(composer.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Go on' } });
    expect((composer.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);

    await click('Approve once');
    expect(decisions()).toEqual([{ id: 7, itemId: 1, decision: 'once' }]);
  });

  it('Approve for this Session names the whole category', async () => {
    const { card, click, decisions } = openSession([forcePush]);
    expect(within(card()).getByRole('button', { name: 'Approve for this Session: Force push, push another branch' })).toBeTruthy();
    await click(/^Approve for this Session/);
    expect(decisions()).toEqual([{ id: 7, itemId: 1, decision: 'session' }]);
  });

  it('puts the approvals first, then the message to the agent beside Deny, which it goes with', () => {
    const { card } = openSession([forcePush]);
    const controls = [...card().querySelectorAll('button, input')].map((c) => c.getAttribute('aria-label') ?? c.textContent);
    expect(controls).toEqual(['Approve once', 'Approve for this Session: Force push, push another branch', 'Message to the agent if you deny it', 'Deny']);
    // The category is said once, above; the button names it to a screen reader.
    expect(within(card()).getByRole('button', { name: /^Approve for this Session/ }).textContent).toBe('Approve for this Session');
  });

  it('Deny sends the optional message to the agent', async () => {
    const { card, click, decisions } = openSession([forcePush, { ...forcePush, id: 2 }]);
    fireEvent.change(within(card()).getByRole('textbox', { name: 'Message to the agent if you deny it' }), { target: { value: '  Rebase instead.  ' } });
    await click('Deny');
    await click('Deny', 1);
    expect(decisions()).toEqual([
      { id: 7, itemId: 1, decision: 'deny', message: 'Rebase instead.' },
      { id: 7, itemId: 2, decision: 'deny' },
    ]);
  });

  it("offers only Approve once and Deny for a push to the default branch, or what Loom can't place", () => {
    const { card } = openSession([
      { ...forcePush, detail: 'git push', title: 'git push', defaultBranch: 'main' },
      { ...forcePush, id: 2, category: undefined, detail: 'rm -rf build' },
    ]);
    expect(within(card(0)).getByText('A push to main, the default branch, always asks.')).toBeTruthy();
    for (const index of [0, 1]) expect(within(card(index)).getAllByRole('button').map((b) => b.textContent)).toEqual(['Approve once', 'Deny']);
  });

  it('shows why a decision was refused, and settled cards read-only', async () => {
    const { card, click } = openSession(
      [
        forcePush,
        { ...forcePush, id: 2, state: 'denied', message: 'Rebase instead.' },
        { ...forcePush, id: 3, state: 'approved-session' },
        { ...forcePush, id: 4, state: 'expired' },
      ],
      {
        'sessions.approve': () => {
          throw new Error('The agent is no longer asking for this approval.');
        },
      },
    );
    await click('Approve once');
    expect(within(card()).getByRole('alert').textContent).toBe('The agent is no longer asking for this approval.');
    expect(within(card(1)).getByText('Denied')).toBeTruthy();
    expect(within(card(1)).getByText('Told the agent: Rebase instead.')).toBeTruthy();
    expect(within(card(2)).getByText('Approved for this Session')).toBeTruthy();
    expect(within(card(3)).getByText('No longer asked')).toBeTruthy();
    for (const index of [1, 2, 3]) expect(within(card(index)).queryAllByRole('button')).toEqual([]);
  });

  it('Settings has an Allow/Ask toggle per category', async () => {
    const main = new FakeMain({ settings: DEFAULT_SETTINGS });
    render(
      <ApiProvider api={main}>
        <App />
      </ApiProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const toggle = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(toggle('sudo and global installs').textContent).toContain('Ask');
    expect(toggle('MCP and extension tools').textContent).toContain('Allow');
    expect(toggle("Push the Session's own branch").textContent).toContain('Allow');

    await act(async () => fireEvent.click(toggle('MCP and extension tools')));
    await act(async () => fireEvent.click(within(screen.getByRole('listbox', { name: 'MCP and extension tools' })).getByRole('option', { name: 'Ask' })));
    expect(main.invoked.filter((i) => i.command === 'settings.setApproval').map((i) => i.params)).toEqual([{ category: 'mcp', setting: 'ask' }]);
    expect(toggle('MCP and extension tools').textContent).toContain('Ask');
  });

  it('Settings picks the Approval mode new Sessions start in', async () => {
    const main = new FakeMain({ settings: DEFAULT_SETTINGS });
    render(
      <ApiProvider api={main}>
        <App />
      </ApiProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const picker = () => screen.getByRole('button', { name: 'Default Approval mode' });
    expect(picker().textContent).toContain('Supervised');
    await act(async () => fireEvent.click(picker()));
    await act(async () => fireEvent.click(within(screen.getByRole('listbox', { name: 'Default Approval mode' })).getByRole('option', { name: 'Full access' })));
    expect(main.invoked.filter((i) => i.command === 'settings.setApprovalModeDefault').map((i) => i.params)).toEqual([{ mode: 'full' }]);
    expect(picker().textContent).toContain('Full access');
  });
});
