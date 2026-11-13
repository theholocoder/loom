// Desktop notifications, from the window's side: Settings turns each kind on,
// the window tells main which Session it shows, and a click on a
// notification opens its Session.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'loom',
  color: 'blue',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/loom' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/loom' },
};

function session(id: number, title: string): Session {
  return { id, projectId: 1, title, workingCopy: { kind: 'checkout', path: '/home/dev/loom' }, agent: 'OpenCode', status: 'waiting', waitingReason: 'finished', unread: true, createdAt: id, updatedAt: id };
}

const calls = (main: FakeMain, command: string) => main.invoked.filter((i) => i.command === command).map((i) => i.params);

function renderApp(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
}

describe('notifications in Settings', () => {
  it('lists each kind, all off to begin with, and saves a change', async () => {
    const main = new FakeMain({ projects: [project] });
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const names = ['When a Session finishes', 'When the agent asks a question', 'When the agent asks for approval', 'When a Merge request has new feedback', 'When a Session is stuck'];
    const boxes = names.map((name) => screen.getByRole('checkbox', { name }) as HTMLInputElement);
    expect(boxes.map((box) => box.checked)).toEqual([false, false, false, false, false]);

    fireEvent.click(boxes[1]!);
    await waitFor(() => expect(calls(main, 'settings.setNotification')).toEqual([{ kind: 'question', on: true }]));
    await waitFor(() => expect(boxes[1]!.checked).toBe(true));
  });

  it('are found by searching for notifications', () => {
    const main = new FakeMain({ projects: [project] });
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'desktop' } });

    expect(screen.getByRole('checkbox', { name: 'When a Session is stuck' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Auto-prompt new Sessions' })).toBeNull();
  });
});

describe('the Session shown', () => {
  it('is told to main as it changes, and none while a Page covers it', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session(1, 'Fix login'), session(2, 'Add tests')] });
    renderApp(main);
    await waitFor(() => expect(calls(main, 'window.showing').at(-1)).toEqual({ sessionId: null }));

    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));
    await waitFor(() => expect(calls(main, 'window.showing').at(-1)).toEqual({ sessionId: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Add tests' }));
    await waitFor(() => expect(calls(main, 'window.showing').at(-1)).toEqual({ sessionId: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(calls(main, 'window.showing').at(-1)).toEqual({ sessionId: null }));
  });
});

describe('a click on a notification', () => {
  it('opens its Session, over a Page too, and again after the user moved on', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session(1, 'Fix login'), session(2, 'Add tests')] });
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    act(() => main.publish('openSession', { sessionId: 2, click: 1 }));
    await waitFor(() => expect(calls(main, 'window.showing').at(-1)).toEqual({ sessionId: 2 }));
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));
    await waitFor(() => expect(calls(main, 'window.showing').at(-1)).toEqual({ sessionId: 1 }));
    act(() => main.publish('openSession', { sessionId: 2, click: 2 }));
    await waitFor(() => expect(calls(main, 'window.showing').at(-1)).toEqual({ sessionId: 2 }));
  });

  it('closes the command palette to open its Session', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session(1, 'Fix login')] });
    renderApp(main);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();

    act(() => main.publish('openSession', { sessionId: 1, click: 1 }));
    await waitFor(() => expect(calls(main, 'window.showing').at(-1)).toEqual({ sessionId: 1 }));
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });

  it('made before the window loaded opens nothing', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session(1, 'Fix login')], openSession: { sessionId: 1, click: 3 } });
    renderApp(main);
    await waitFor(() => expect(calls(main, 'window.showing')).not.toEqual([]));
    expect(calls(main, 'window.showing')).toEqual([{ sessionId: null }]);
  });
});
