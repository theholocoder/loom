import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

// The clock the shortcuts read, moved on by hand.
let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const later = (ms: number) => {
  now += ms;
};

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
};

function session(id: number, fields: Partial<Session> = {}): Session {
  return {
    id,
    projectId: 1,
    title: `Session ${id}`,
    workingCopy: { kind: 'worktree', path: `/home/dev/loom/worktrees/s${id}` },
    agent: 'OpenCode',
    status: 'waiting',
    waitingReason: 'finished',
    unread: false,
    createdAt: 1,
    updatedAt: 10 - id,
    ...fields,
  };
}

function renderApp(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const press = (key: string, target: Element = document.activeElement ?? document.body, more: { ctrlKey?: boolean } = {}) => fireEvent.keyDown(target, { key, ...more });
/** Types `text` in the focused field, a key at a time. */
const typeKeys = (text: string) => {
  for (const key of text) press(key);
};
const openSessionTitle = () => within(screen.getByRole('region', { name: 'Session header' })).getByRole('heading').textContent;
const prompt = () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
const commands = (main: FakeMain) => main.invoked.map((i) => i.command);
const toast = () => screen.queryByRole('group', { name: 'What was done' });

describe('Escape in the composer', () => {
  it('moves the focus out of it, to the conversation, where j works again at once', () => {
    renderApp(new FakeMain({ projects: [project], sessions: [session(1), session(2)] }));
    press('j', document.body);
    expect(openSessionTitle()).toBe('Session 1');
    prompt().focus();
    typeKeys('hi');

    press('Escape');

    expect(document.activeElement).toBe(screen.getByRole('log', { name: 'Conversation' }));
    press('j');
    expect(openSessionTitle()).toBe('Session 2');
  });
});

describe('bare-letter shortcuts just after typing', () => {
  it('are ignored for a moment after a text field loses the focus, and while the typing goes on', () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [session(1), session(2)] }));
    press('j', document.body);
    prompt().focus();
    typeKeys('fix th');
    // The focus drops out of the prompt box mid-word.
    prompt().blur();

    later(300);
    press('e', document.body);
    later(300);
    press('u', document.body);
    later(300);
    press('j', document.body);
    expect(commands(main)).not.toContain('sessions.archive');
    expect(commands(main)).not.toContain('sessions.setUnread');
    expect(openSessionTitle()).toBe('Session 1');

    // Once the typing has stopped for a moment, they work again.
    later(1500);
    press('j', document.body);
    expect(openSessionTitle()).toBe('Session 2');
  });
});

describe('a composer that disables while it has the focus', () => {
  const approval: TranscriptItem = { kind: 'approval', id: 2, toolCallId: 'call_sh', title: 'git push', tool: 'shell', detail: 'git push --force', category: 'otherPush', state: 'asked' };

  it('leaves the focus on the Approval request waiting, so what is typed next archives nothing', async () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [session(1)] }));
    main.publish('transcript', [{ kind: 'user', id: 1, text: 'Ship it' }], { sessionId: 1 });
    press('j', document.body);
    act(() => main.publish('sessions', [session(1, { status: 'working', waitingReason: undefined })]));
    prompt().focus();
    typeKeys('and th');

    act(() => {
      main.publish('transcript', [{ kind: 'user', id: 1, text: 'Ship it' }, approval], { sessionId: 1 });
      main.publish('sessions', [session(1, { waitingReason: 'approval' })]);
    });

    expect(prompt().disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Approval request' }));
    later(200);
    typeKeys('en');
    later(2000);
    expect(commands(main)).not.toContain('sessions.archive');
    expect(commands(main)).not.toContain('sessions.approve');
  });
});

describe('the Undo toast', () => {
  it('follows Archive, and its Undo brings the Session back', async () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [session(1)] }, { 'sessions.archive': () => ({ archived: true }) }));
    press('j', document.body);

    press('e');

    await waitFor(() => expect(toast()?.textContent).toContain('Archived “Session 1”'));
    await act(async () => fireEvent.click(within(toast()!).getByRole('button', { name: 'Undo' })));
    expect(main.invoked).toContainEqual({ command: 'sessions.unarchive', params: { id: 1 } });
    expect(toast()).toBeNull();
  });

  it('follows Mark unread, and Ctrl+Z undoes it outside a text field', async () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [session(1)] }));
    press('j', document.body);

    press('u');
    await waitFor(() => expect(toast()?.textContent).toContain('Marked “Session 1” unread'));
    // Ctrl+Z in a text field is the field's own undo.
    press('z', prompt(), { ctrlKey: true });
    expect(main.invoked.filter((i) => i.command === 'sessions.setUnread').map((i) => i.params)).toEqual([{ id: 1, unread: true }]);

    await act(async () => press('z', document.body, { ctrlKey: true }));
    expect(main.invoked.filter((i) => i.command === 'sessions.setUnread').at(-1)?.params).toEqual({ id: 1, unread: false });
    expect(toast()).toBeNull();
  });

  it('says why an Undo failed', async () => {
    renderApp(
      new FakeMain(
        { projects: [project], sessions: [session(1)] },
        {
          'sessions.archive': () => ({ archived: true }),
          'sessions.unarchive': () => {
            throw new Error("There's no local branch \"loom/s1\".");
          },
        },
      ),
    );
    press('j', document.body);
    press('e');
    await waitFor(() => expect(toast()).toBeTruthy());

    await act(async () => fireEvent.click(within(toast()!).getByRole('button', { name: 'Undo' })));

    expect(toast()?.textContent).toContain('Couldn’t undo: There\'s no local branch "loom/s1".');
    expect(within(toast()!).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('closes on its own after a while, or with Dismiss', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderApp(new FakeMain({ projects: [project], sessions: [session(1)] }));
      press('j', document.body);
      press('u');
      await act(async () => {});
      expect(toast()).toBeTruthy();
      // Not while the pointer is on it.
      fireEvent.mouseEnter(toast()!);
      act(() => vi.advanceTimersByTime(10_000));
      expect(toast()).toBeTruthy();
      fireEvent.mouseLeave(toast()!);
      act(() => vi.advanceTimersByTime(10_000));
      expect(toast()).toBeNull();

      const conversation = screen.getByRole('log', { name: 'Conversation' });
      conversation.focus();
      press('u');
      await act(async () => {});
      // Closed from the keyboard, the focus goes back where it was.
      within(toast()!).getByRole('button', { name: 'Dismiss' }).focus();
      fireEvent.click(within(toast()!).getByRole('button', { name: 'Dismiss' }));
      expect(toast()).toBeNull();
      expect(document.activeElement).toBe(conversation);
    } finally {
      vi.useRealTimers();
    }
  });
});
