import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

function renderApp(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

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
  title: 'Say hello',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'working',
  createdAt: 1,
  updatedAt: 1,
};
const finished: Session = { ...working, status: 'waiting', waitingReason: 'finished' };

function startNewSession() {
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
  return screen.getByRole('main', { name: 'New Session' });
}

/** Opens the Session from the sidebar. */
function open(main: FakeMain, session: Session) {
  if (session.status === 'working') fireEvent.click(screen.getByRole('button', { name: 'Working' }));
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  return main;
}

describe('starting a Session', () => {
  it('offers to stay on the current branch, with OpenCode as the agent', () => {
    renderApp(new FakeMain({ projects: [project] }));

    const pane = startNewSession();

    const workingCopy = within(pane).getByRole('combobox', { name: 'Working copy' }) as HTMLSelectElement;
    expect(workingCopy.value).toBe('checkout');
    expect(workingCopy.selectedOptions[0]!.textContent).toBe('Stay on current branch');
    expect(within(pane).getByTitle('Agent').textContent).toBe('OpenCode');
    expect((within(pane).getByRole('combobox', { name: 'Project' }) as HTMLSelectElement).value).toBe('1');
  });

  it('starts a checkout Session with the prompt, then shows it', async () => {
    const main = renderApp(
      new FakeMain({ projects: [project] }, {
        'sessions.create': () => {
          main.publish('sessions', [working]);
          return working;
        },
      }),
    );
    const pane = startNewSession();

    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Say hello' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('main', { name: 'Session' })).toBeTruthy());
    expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([
      { command: 'sessions.create', params: { projectId: 1, workingCopy: 'checkout', prompt: 'Say hello' } },
    ]);
    expect(screen.getByRole('heading', { name: 'Say hello' })).toBeTruthy();
  });

  it('says why a Session could not start', async () => {
    renderApp(
      new FakeMain({ projects: [project] }, {
        'sessions.create': () => {
          throw new Error('Native is not connected');
        },
      }),
    );
    const pane = startNewSession();

    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Go' } });
    fireEvent.keyDown(within(pane).getByRole('textbox', { name: 'Prompt' }), { key: 'Enter' });

    expect((await within(pane).findByRole('alert')).textContent).toBe('Native is not connected');
  });

  it('asks for a Project first when there is none', () => {
    renderApp(new FakeMain());

    const pane = startNewSession();

    expect(within(pane).getByText('Add a Project before starting a Session.')).toBeTruthy();
    expect(within(pane).queryByRole('textbox', { name: 'Prompt' })).toBeNull();
  });
});

describe('a Session', () => {
  it('shows the user as bubbles and streams the agent reply', () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [working] })), working);
    const chat = () => screen.getByRole('log', { name: 'Conversation' });

    act(() => main.publish('transcript', [{ kind: 'user', id: 1, text: 'Say hello' }], { sessionId: 7 }));
    expect(within(chat()).getByText('Say hello').closest('.msg')?.className).toContain('user');

    act(() =>
      main.publish(
        'transcript',
        [
          { kind: 'user', id: 1, text: 'Say hello' },
          { kind: 'agent', id: 2, text: 'Hello', streaming: true },
        ],
        { sessionId: 7 },
      ),
    );
    act(() =>
      main.publish(
        'transcript',
        [
          { kind: 'user', id: 1, text: 'Say hello' },
          { kind: 'agent', id: 2, text: 'Hello, world', streaming: true },
        ],
        { sessionId: 7 },
      ),
    );
    const reply = within(chat()).getByText('Hello, world').closest('.msg')!;
    expect(reply.className).toContain('agent');
    expect(within(reply as HTMLElement).getByText('OpenCode')).toBeTruthy();
  });

  it("can't be sent a message while Working", () => {
    open(renderApp(new FakeMain({ projects: [project], sessions: [working] })), working);

    expect(screen.getByRole('status', { name: 'Session status' }).textContent).toBe('Working');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends a reply once the agent has finished', async () => {
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [finished] })), finished);
    expect(screen.getByRole('status', { name: 'Session status' }).textContent).toBe('Finished');

    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Now say goodbye' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(main.invoked.filter((i) => i.command === 'sessions.send')).toEqual([{ command: 'sessions.send', params: { id: 7, prompt: 'Now say goodbye' } }]));
    expect((screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the error a failed run ended with', () => {
    const failed: Session = { ...working, status: 'waiting', waitingReason: 'error', error: 'Insufficient credits' };
    const main = open(renderApp(new FakeMain({ projects: [project], sessions: [failed] })), failed);

    act(() =>
      main.publish(
        'transcript',
        [
          { kind: 'user', id: 1, text: 'Say hello' },
          { kind: 'error', id: 2, message: 'Insufficient credits' },
        ],
        { sessionId: 7 },
      ),
    );

    expect(screen.getByRole('status', { name: 'Session status' }).textContent).toBe('Error');
    expect(within(screen.getByRole('log', { name: 'Conversation' })).getByRole('alert').textContent).toContain('Insufficient credits');
  });

  it('shows why it is Waiting on an error when its conversation is not loaded', () => {
    const failed: Session = { ...working, status: 'waiting', waitingReason: 'error', error: 'Insufficient credits' };
    open(renderApp(new FakeMain({ projects: [project], sessions: [failed] })), failed);

    expect(within(screen.getByRole('log', { name: 'Conversation' })).getByRole('alert').textContent).toContain('Insufficient credits');
  });

  it('is listed in the Inbox while Waiting, and under Working while Working', () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [finished] }));
    const inbox = screen.getByRole('complementary', { name: 'Inbox' });
    expect(within(inbox).getByRole('button', { name: 'Say hello' })).toBeTruthy();

    act(() => main.publish('sessions', [working]));
    expect(within(inbox).queryByRole('button', { name: 'Say hello' })).toBeNull();
    fireEvent.click(within(inbox).getByRole('button', { name: 'Working' }));
    expect(within(inbox).getByRole('button', { name: 'Say hello' })).toBeTruthy();
  });
});
