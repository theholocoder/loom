import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const loom: Project = {
  id: 1,
  name: 'loom',
  color: 'blue',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/loom' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'theholocoder/loom' },
};

function session(id: number, title: string): Session {
  return {
    id,
    projectId: loom.id,
    title,
    workingCopy: { kind: 'worktree', path: `/home/dev/loom/worktrees/s${id}` },
    branch: `loom/s${id}`,
    agent: 'OpenCode',
    status: 'waiting',
    waitingReason: 'finished',
    unread: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

const login = session(1, 'Fix login');
const docs = session(2, 'Write docs');

function renderApp(handlers: ConstructorParameters<typeof FakeMain>[1] = {}) {
  const main = new FakeMain({ projects: [loom], sessions: [login, docs] }, handlers);
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const inbox = () => within(screen.getByRole('complementary', { name: 'Inbox' }));
/** Shows the Session titled `title`, from its Inbox card. */
const open = (title: string) => fireEvent.click(inbox().getByRole('button', { name: title }));
const composer = () => within(screen.getByRole('form', { name: 'Composer' }));
const prompt = () => composer().getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;

/** Types `text` into the prompt, the caret at `caret` (its end by default). */
function type(text: string, caret = text.length) {
  fireEvent.change(prompt(), { target: { value: text, selectionStart: caret, selectionEnd: caret } });
}

describe("a Session's draft", () => {
  it('is still in the composer on coming back to the Session, and each Session has its own', () => {
    renderApp();
    open('Fix login');
    type('Look at the retry');
    open('Write docs');
    expect(prompt().value).toBe('');
    type('Document the API');
    open('Fix login');
    expect(prompt().value).toBe('Look at the retry');
    open('Write docs');
    expect(prompt().value).toBe('Document the API');
  });

  it('keeps where the caret was', () => {
    renderApp();
    open('Fix login');
    type('Look at the retry', 'Look at'.length);
    open('Write docs');
    open('Fix login');
    expect(prompt().selectionStart).toBe('Look at'.length);
  });

  it('keeps the files attached', () => {
    renderApp();
    open('Fix login');
    fireEvent.change(composer().getByLabelText('Attach files or images'), { target: { files: [new File(['panic\n'], 'crash.log', { type: 'text/plain' })] } });
    open('Write docs');
    expect(composer().queryByRole('list', { name: 'Attachments' })).toBeNull();
    open('Fix login');
    expect(within(composer().getByRole('list', { name: 'Attachments' })).getByRole('listitem').textContent).toContain('crash.log');
  });

  it('keeps the comments waiting to go with the next message, and sends them', async () => {
    const main = renderApp();
    main.publish('transcript', [{ kind: 'agent', id: 2, text: 'The login form retries twice.', streaming: false }], { sessionId: login.id });
    open('Fix login');
    const passage = await screen.findByText('The login form retries twice.');
    const range = document.createRange();
    range.selectNodeContents(passage);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.contextMenu(passage);
    fireEvent.click(within(screen.getByRole('menu', { name: 'Context menu' })).getByRole('menuitem', { name: 'Comment…' }));
    const dialog = screen.getByRole('dialog', { name: 'Comment on the conversation' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Comment' }), { target: { value: 'Why twice?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));
    window.getSelection()!.removeAllRanges();

    open('Write docs');
    expect(composer().queryByRole('list', { name: 'Comments' })).toBeNull();
    open('Fix login');
    expect(within(composer().getByRole('list', { name: 'Comments' })).getByRole('listitem').textContent).toContain('Why twice?');
    fireEvent.click(composer().getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(main.invoked.filter((i) => i.command === 'sessions.send').map((i) => i.params)).toEqual([
        { id: login.id, prompt: '', comments: [{ quote: 'The login form retries twice.', note: 'Why twice?' }] },
      ]),
    );
  });

  it('is gone once sent', async () => {
    const main = renderApp();
    open('Fix login');
    type('Look at the retry');
    fireEvent.click(composer().getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(main.invoked.some((i) => i.command === 'sessions.send')).toBe(true));
    await waitFor(() => expect(prompt().value).toBe(''));
    open('Write docs');
    open('Fix login');
    expect(prompt().value).toBe('');
  });
});

describe("New Session's draft", () => {
  /** Opens New Session on the only Project, from the Inbox's New menu. */
  const startNew = () => {
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter Projects' }), { key: 'Enter' });
  };

  it('is still there on starting a New Session again, after Settings and a Session', () => {
    renderApp();
    startNew();
    type('Add dark mode');
    fireEvent.change(composer().getByLabelText('Attach files or images'), { target: { files: [new File(['a'], 'mock.png', { type: 'image/png' })] } });
    fireEvent.click(inbox().getByRole('button', { name: 'Settings' }));
    open('Fix login');
    expect(prompt().value).toBe('');
    startNew();
    expect(prompt().value).toBe('Add dark mode');
    expect(within(composer().getByRole('list', { name: 'Attachments' })).getByRole('listitem').textContent).toContain('mock.png');
    // The branch is suggested from it, as from what is typed.
    expect((screen.getByRole('textbox', { name: 'Branch' }) as HTMLInputElement).value).toBe('loom/add-dark-mode');
  });

  it('is thrown away by Cancel', () => {
    renderApp();
    startNew();
    type('Add dark mode');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    startNew();
    expect(prompt().value).toBe('');
  });

  it('is gone once a Session starts from it', async () => {
    const main = renderApp({ 'sessions.create': () => login });
    startNew();
    type('Add dark mode');
    fireEvent.change(composer().getByLabelText('Attach files or images'), { target: { files: [new File(['a'], 'mock.png', { type: 'image/png' })] } });
    fireEvent.click(composer().getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(main.invoked.some((i) => i.command === 'sessions.create')).toBe(true));
    await screen.findByRole('heading', { name: 'Fix login' });
    startNew();
    expect(prompt().value).toBe('');
    expect(composer().queryByRole('list', { name: 'Attachments' })).toBeNull();
  });

  it("isn't given up by Esc when it comes back with text in it", () => {
    renderApp();
    startNew();
    type('Add dark mode');
    open('Fix login');
    startNew();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    // Esc gives up only while nothing is typed.
    expect(screen.getByRole('main', { name: 'New Session' })).toBeTruthy();
  });
});
