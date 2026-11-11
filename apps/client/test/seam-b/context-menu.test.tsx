import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

const NOW = new Date(2026, 10, 11, 10, 42).getTime();
const HOUR = 3_600_000;

/** What the app put on the clipboard, latest last; `pasted` is what it reads back, `pastedImage` an image it holds instead. */
let clipboard: string[];
let pasted: string;
let pastedImage: Blob | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  clipboard = [];
  pasted = '';
  pastedImage = undefined;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => void clipboard.push(text),
      readText: async () => pasted,
      read: async () => [
        pastedImage
          ? { types: [pastedImage.type], getType: async () => pastedImage! }
          : { types: ['text/plain'], getType: async () => new Blob([pasted], { type: 'text/plain' }) },
      ],
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
});

const loom: Project = {
  id: 1,
  name: 'loom',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/loom' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'theholocoder/loom' },
};

let nextId = 1;
function session(change: Partial<Session> = {}): Session {
  const id = nextId++;
  return {
    id,
    projectId: loom.id,
    title: `Session ${id}`,
    workingCopy: { kind: 'worktree', path: `/home/dev/loom/worktrees/s${id}` },
    branch: `loom/s${id}`,
    agent: 'OpenCode',
    status: 'waiting',
    waitingReason: 'finished',
    unread: false,
    createdAt: NOW - HOUR,
    updatedAt: NOW - 60_000,
    ...change,
  };
}

function renderApp(sessions: Session[], handlers: ConstructorParameters<typeof FakeMain>[1] = {}) {
  const main = new FakeMain({ projects: [loom], sessions }, handlers);
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const inbox = () => screen.getByRole('complementary', { name: 'Inbox' });
const card = (title: string) => within(inbox()).getByRole('listitem', { name: title });
const menu = () => screen.getByRole('menu', { name: 'Context menu' });
/** The menu's items, `—` for each separator, a disabled item in brackets. */
const items = () =>
  [...menu().querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) =>
    el.getAttribute('role') === 'separator' ? '—' : (el as HTMLButtonElement).disabled ? `(${el.getAttribute('aria-label')})` : el.getAttribute('aria-label'),
  );
const pick = (label: string) => fireEvent.click(within(menu()).getByRole('menuitem', { name: label }));
const invoked = (main: FakeMain, command: string) => main.invoked.filter((i) => i.command === command).map((i) => i.params);

/** Selects the whole text of `element`, as the user would by dragging over it. */
function select(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

describe("a Session's right-click menu", () => {
  it('offers, on its Inbox card, a new Session in its worktree and Snooze, Rename and Mark unread, then Archive and Delete', () => {
    renderApp([session({ title: 'Fix login' })]);
    fireEvent.contextMenu(card('Fix login'));
    expect(items()).toEqual(['New Session in this worktree', 'Snooze…', '—', 'Rename…', 'Mark unread', '—', 'Archive', 'Delete…']);
  });

  it('offers the same on the Session header', () => {
    const main = renderApp([session({ title: 'Fix login' })]);
    fireEvent.click(within(card('Fix login')).getByRole('button', { name: 'Fix login' }));
    fireEvent.contextMenu(screen.getByRole('heading', { name: 'Fix login' }));
    expect(items()).toEqual(['New Session in this worktree', 'Snooze…', '—', 'Rename…', 'Mark unread', '—', 'Archive', 'Delete…']);
    pick('Archive');
    expect(invoked(main, 'sessions.archive')).toEqual([{ id: main.value('sessions')[0]!.id }]);
  });

  it("can't snooze a Working Session, nor archive an archived one, nor mark an unread one unread", () => {
    renderApp([session({ title: 'Busy', status: 'working', waitingReason: undefined }), session({ title: 'Done', status: 'archived', waitingReason: undefined, unread: true })]);
    fireEvent.click(screen.getByRole('button', { name: 'Working' }));
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Busy' }));
    expect(items()).toContain('(Snooze…)');
    fireEvent.keyDown(menu(), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Done' }));
    expect(items()).toEqual(['New Session on this branch', '(Snooze…)', '—', 'Rename…', '(Mark unread)', '—', '(Archive)', 'Delete…']);
  });

  it('snoozes from the snooze times the Inbox card offers', async () => {
    const later = session({ title: 'Later' });
    const main = renderApp([later]);
    fireEvent.contextMenu(card('Later'));
    pick('Snooze…');
    fireEvent.click(within(screen.getByRole('menu', { name: 'Snooze' })).getByRole('menuitem', { name: '3 hours' }));
    await waitFor(() => expect(invoked(main, 'sessions.snooze')).toEqual([{ id: later.id, until: NOW + 3 * HOUR }]));
  });

  it('wakes a Snoozed Session', async () => {
    const later = session({ title: 'Later', snoozedUntil: NOW + HOUR });
    const main = renderApp([later]);
    fireEvent.click(screen.getByRole('button', { name: 'Snoozed' }));
    fireEvent.contextMenu(card('Later'));
    pick('Wake');
    await waitFor(() => expect(invoked(main, 'sessions.snooze')).toEqual([{ id: later.id, until: null }]));
  });

  it('renames the Session to the title typed', async () => {
    const fix = session({ title: 'Fix login' });
    const main = renderApp([fix]);
    fireEvent.contextMenu(card('Fix login'));
    pick('Rename…');
    const dialog = screen.getByRole('dialog', { name: 'Rename Session' });
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveProperty('value', 'Fix login');
    fireEvent.change(title, { target: { value: 'Login 500s' } });
    fireEvent.submit(title);
    await waitFor(() => expect(invoked(main, 'sessions.rename')).toEqual([{ id: fix.id, title: 'Login 500s' }]));
    expect(screen.queryByRole('dialog', { name: 'Rename Session' })).toBeNull();
  });

  it('marks it unread, and asks before deleting it', async () => {
    const fix = session({ title: 'Fix login' });
    const main = renderApp([fix]);
    fireEvent.contextMenu(card('Fix login'));
    pick('Mark unread');
    await waitFor(() => expect(invoked(main, 'sessions.setUnread')).toEqual([{ id: fix.id, unread: true }]));
    fireEvent.contextMenu(card('Fix login'));
    pick('Delete…');
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Delete “Fix login”?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(invoked(main, 'sessions.delete')).toEqual([{ id: fix.id }]));
  });

  it('starts a new Session in the same worktree', async () => {
    const fix = session({ title: 'Fix login', workingCopy: { kind: 'worktree', path: '/wt/fix-login' }, branch: 'loom/fix-login' });
    const main = renderApp([fix], { 'sessions.create': () => session({ title: 'Also this' }) });
    fireEvent.contextMenu(card('Fix login'));
    pick('New Session in this worktree');
    const composer = screen.getByRole('form', { name: 'Composer' });
    expect(within(composer).getByRole('button', { name: 'Worktree' }).textContent).toContain('loom/fix-login');
    fireEvent.change(within(composer).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Also this' } });
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(invoked(main, 'sessions.create')).toEqual([{ projectId: loom.id, workingCopy: 'worktree', existing: { worktree: '/wt/fix-login' }, prompt: 'Also this' }]),
    );
  });

  it("starts a new Session on an archived worktree Session's branch, or in the checkout for a checkout Session", async () => {
    const main = renderApp([
      session({ title: 'Old', status: 'archived', waitingReason: undefined, branch: 'loom/old' }),
      session({ title: 'Here', workingCopy: { kind: 'checkout', path: '/home/dev/loom' }, branch: 'main' }),
    ]);
    fireEvent.contextMenu(card('Here'));
    pick('New Session in the checkout');
    expect(screen.getByRole('button', { name: 'Working copy' }).textContent).toContain('Stay on current branch');
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Old' }));
    pick('New Session on this branch');
    expect(screen.getByRole('button', { name: 'Worktree' }).textContent).toContain('loom/old');
    expect(main.invoked.filter((i) => i.command === 'sessions.create')).toEqual([]);
  });

  it('closes on Escape, giving focus back', () => {
    renderApp([session({ title: 'Fix login' })]);
    const open = within(card('Fix login')).getByRole('button', { name: 'Fix login' });
    open.focus();
    fireEvent.contextMenu(open);
    fireEvent.keyDown(menu(), { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Context menu' })).toBeNull();
    expect(document.activeElement).toBe(open);
  });
});

describe("the composer's right-click menu", () => {
  const prompt = () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
  function openSession() {
    const fix = session({ title: 'Fix login' });
    const main = renderApp([fix]);
    fireEvent.click(within(card('Fix login')).getByRole('button', { name: 'Fix login' }));
    return main;
  }

  it('cuts and copies what is selected in the prompt', async () => {
    openSession();
    fireEvent.change(prompt(), { target: { value: 'Fix the login bug' } });
    prompt().setSelectionRange(4, 13);
    fireEvent.contextMenu(prompt());
    expect(items()).toEqual(['Cut', 'Copy', 'Paste']);
    pick('Copy');
    await waitFor(() => expect(clipboard).toEqual(['the login']));
    prompt().setSelectionRange(4, 14);
    fireEvent.contextMenu(prompt());
    pick('Cut');
    await waitFor(() => expect(prompt().value).toBe('Fix bug'));
    expect(clipboard).toEqual(['the login', 'the login ']);
  });

  it("pastes the clipboard's text in place of the selection", async () => {
    openSession();
    fireEvent.change(prompt(), { target: { value: 'Fix the bug' } });
    prompt().setSelectionRange(4, 7);
    pasted = 'a login';
    fireEvent.contextMenu(prompt());
    pick('Paste');
    await waitFor(() => expect(prompt().value).toBe('Fix a login bug'));
  });

  it('attaches an image on the clipboard, as Ctrl+V does, typing nothing', async () => {
    openSession();
    fireEvent.change(prompt(), { target: { value: 'Look' } });
    pastedImage = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    fireEvent.contextMenu(prompt());
    pick('Paste');
    const attachments = await screen.findByRole('list', { name: 'Attachments' });
    expect(within(attachments).getByRole('listitem').textContent).toContain('Pasted image.png');
    expect(prompt().value).toBe('Look');
  });

  it("can't cut or copy with nothing selected", () => {
    openSession();
    fireEvent.contextMenu(prompt());
    expect(items()).toEqual(['(Cut)', '(Copy)', 'Paste']);
  });
});

describe('commenting on the conversation', () => {
  const transcript: TranscriptItem[] = [
    { kind: 'user', id: 1, text: 'Fix the login bug' },
    { kind: 'agent', id: 2, text: 'The login form retries twice.', streaming: false },
  ];

  it('adds the passage selected and a note to the composer, sent with the next message', async () => {
    const fix = session({ title: 'Fix login' });
    const main = renderApp([fix]);
    main.publish('transcript', transcript, { sessionId: fix.id });
    fireEvent.click(within(card('Fix login')).getByRole('button', { name: 'Fix login' }));
    const passage = await screen.findByText('The login form retries twice.');
    select(passage);
    fireEvent.contextMenu(passage);
    expect(items()).toEqual(['Comment…', '—', 'Copy']);
    pick('Comment…');
    const dialog = screen.getByRole('dialog', { name: 'Comment on the conversation' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Comment' }), { target: { value: 'Why twice?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add comment' }));

    const chips = within(screen.getByRole('list', { name: 'Comments' }));
    expect(chips.getByRole('listitem').textContent).toContain('“The login form retries twice.”');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(invoked(main, 'sessions.send')).toEqual([{ id: fix.id, prompt: '', comments: [{ quote: 'The login form retries twice.', note: 'Why twice?' }] }]));
  });

  it("isn't offered with nothing selected", async () => {
    const fix = session({ title: 'Fix login' });
    const main = renderApp([fix]);
    main.publish('transcript', transcript, { sessionId: fix.id });
    fireEvent.click(within(card('Fix login')).getByRole('button', { name: 'Fix login' }));
    fireEvent.contextMenu(await screen.findByText('The login form retries twice.'));
    expect(screen.queryByRole('menu', { name: 'Context menu' })).toBeNull();
  });
});

describe('copying from any right-click', () => {
  it('copies the text selected', async () => {
    const fix = session({ title: 'Fix login' });
    renderApp([fix]);
    const title = within(card('Fix login')).getByText('Fix login');
    select(title);
    fireEvent.contextMenu(title);
    pick('Copy');
    await waitFor(() => expect(clipboard).toEqual(['Fix login']));
  });

  it("copies a branch's name, and a worktree's path and name", async () => {
    const fix = session({ title: 'Fix login', workingCopy: { kind: 'worktree', path: '/wt/fix-login' }, branch: 'loom/fix-login' });
    renderApp([fix]);
    fireEvent.contextMenu(within(card('Fix login')).getByText('loom/fix-login'));
    expect(items().slice(-2)).toEqual(['—', 'Copy branch name']);
    pick('Copy branch name');
    await waitFor(() => expect(clipboard).toEqual(['loom/fix-login']));

    fireEvent.click(within(card('Fix login')).getByRole('button', { name: 'Fix login' }));
    fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    fireEvent.contextMenu(within(screen.getByRole('complementary', { name: 'Side area' })).getByText('/wt/fix-login'));
    expect(items()).toEqual(['Copy worktree name', 'Copy worktree path']);
    pick('Copy worktree name');
    await waitFor(() => expect(clipboard).toEqual(['loom/fix-login', 'fix-login']));
  });
});

