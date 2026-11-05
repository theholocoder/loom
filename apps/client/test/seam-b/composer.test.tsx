import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const finished: Session = {
  id: 7,
  projectId: 1,
  title: 'Fix the timeout',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};

function openSession(main: FakeMain, session: Session = finished) {
  renderApp(main);
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  const composer = within(screen.getByRole('form', { name: 'Composer' }));
  const prompt = composer.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
  return { composer, prompt };
}

/** Types `text` into the prompt, the caret at its end. */
function type(prompt: HTMLTextAreaElement, text: string) {
  fireEvent.change(prompt, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
}

describe('attachments in the composer', () => {
  it('attaches chosen files, shows them as chips, and sends their content with the prompt', async () => {
    const main = new FakeMain({ projects: [project], sessions: [finished] });
    const { composer, prompt } = openSession(main);

    const input = composer.getByLabelText('Attach files or images') as HTMLInputElement;
    const log = new File(['panic: timeout\n'], 'crash.log', { type: 'text/plain' });
    const shot = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [log, shot] } });

    const chips = within(composer.getByRole('list', { name: 'Attachments' }));
    expect(chips.getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('crash.log'), expect.stringContaining('screenshot.png')]);
    fireEvent.click(chips.getByRole('button', { name: 'Remove screenshot.png' }));
    type(prompt, 'Why?');
    fireEvent.click(composer.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(main.invoked.some((i) => i.command === 'sessions.send')).toBe(true));
    const sent = main.invoked.find((i) => i.command === 'sessions.send')!.params as { prompt: string; attachments: Array<{ name: string; mimeType: string; data: Uint8Array }> };
    expect(sent.prompt).toBe('Why?');
    expect(sent.attachments.map(({ name, mimeType }) => ({ name, mimeType }))).toEqual([{ name: 'crash.log', mimeType: 'text/plain' }]);
    expect(new TextDecoder().decode(sent.attachments[0]!.data)).toBe('panic: timeout\n');
    // Sent: the composer is empty again.
    await waitFor(() => expect(composer.queryByRole('list', { name: 'Attachments' })).toBeNull());
  });

  it('attaches an image pasted into the prompt', () => {
    const main = new FakeMain({ projects: [project], sessions: [finished] });
    const { composer, prompt } = openSession(main);

    const image = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' });
    fireEvent.paste(prompt, { clipboardData: { files: [image] } });

    expect(within(composer.getByRole('list', { name: 'Attachments' })).getByRole('listitem').textContent).toContain('image.png');
  });

  it("shows what a sent message had attached, and a queued message's attachments", () => {
    const attachment = { name: 'crash.log', mimeType: 'text/plain', size: 2048, hash: 'ab'.repeat(32) };
    const working: Session = { ...finished, status: 'working', waitingReason: undefined, queue: [{ id: 3, text: 'And this', attachments: [attachment] }] };
    const main = new FakeMain({ projects: [project], sessions: [working] });
    main.publish('transcript', [{ kind: 'user', id: 0, text: 'Why?', attachments: [attachment] }], { sessionId: working.id });
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'Working' }));
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: working.title }));

    const conversation = within(screen.getByRole('log', { name: 'Conversation' }));
    expect(within(conversation.getByRole('list', { name: 'Attachments' })).getByRole('listitem').textContent).toBe('crash.log2 KB');
    expect(within(screen.getByRole('list', { name: 'Queued messages' })).getByLabelText('1 attached')).toBeTruthy();
  });
});

describe('attachments when starting a Session', () => {
  it('go with the first prompt', async () => {
    const main = new FakeMain({ projects: [project] }, { 'sessions.create': () => finished });
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter Projects' }), { key: 'Enter' });
    const composer = within(screen.getByRole('form', { name: 'Composer' }));

    fireEvent.change(composer.getByLabelText('Attach files or images'), { target: { files: [new File(['a,b\n'], 'rows.csv', { type: 'text/csv' })] } });
    fireEvent.change(composer.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Import these' } });
    fireEvent.click(composer.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(main.invoked.some((i) => i.command === 'sessions.create')).toBe(true));
    const params = main.invoked.find((i) => i.command === 'sessions.create')!.params as { prompt: string; attachments: Array<{ name: string; data: Uint8Array }> };
    expect(params.prompt).toBe('Import these');
    expect(params.attachments.map((a) => [a.name, new TextDecoder().decode(a.data)])).toEqual([['rows.csv', 'a,b\n']]);
  });
});

describe('@-mentions', () => {
  it("suggests, when starting a new worktree, the files of the branch it starts from", async () => {
    const main = new FakeMain({ projects: [project] }, { 'projects.files': () => ['README.md'], 'projects.branches': () => ({ defaultBranch: 'trunk', remote: ['trunk'], existing: [], worktrees: [] }) });
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter Projects' }), { key: 'Enter' });
    const composer = within(screen.getByRole('form', { name: 'Composer' }));
    await waitFor(() => expect(composer.getByRole('button', { name: 'Branch from' }).textContent).toBe('origin/trunk'));

    type(composer.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement, 'See @READ');

    await composer.findByRole('option', { name: 'README.md' });
    expect(main.invoked.find((i) => i.command === 'projects.files')?.params).toEqual({ id: project.id, ref: 'origin/trunk' });
  });

  const files = ['README.md', 'src/billing/invoice.ts', 'src/billing/refund.ts', 'test/invoice.test.ts'];

  it("suggests the working copy's files as the user types after @, and puts the one picked in the prompt", async () => {
    const main = new FakeMain({ projects: [project], sessions: [finished] }, { 'sessions.files': () => files });
    const { composer, prompt } = openSession(main);

    type(prompt, 'Look at @invo');

    const suggestions = within(await composer.findByRole('listbox', { name: 'Files' }));
    await waitFor(() => expect(suggestions.getAllByRole('option').map((o) => o.textContent)).toEqual(['src/billing/invoice.ts', 'test/invoice.test.ts']));
    expect(main.invoked.find((i) => i.command === 'sessions.files')?.params).toEqual({ id: finished.id });
    fireEvent.keyDown(prompt, { key: 'ArrowDown' });
    fireEvent.keyDown(prompt, { key: 'Enter' });

    expect(prompt.value).toBe('Look at @test/invoice.test.ts ');
    expect(composer.queryByRole('listbox', { name: 'Files' })).toBeNull();
    // Enter picked the file: nothing was sent.
    expect(main.invoked.some((i) => i.command === 'sessions.send')).toBe(false);
  });

  it('closes on Escape, leaving what was typed', async () => {
    const main = new FakeMain({ projects: [project], sessions: [finished] }, { 'sessions.files': () => files });
    const { composer, prompt } = openSession(main);

    type(prompt, '@READ');
    await composer.findByRole('option', { name: 'README.md' });
    fireEvent.keyDown(prompt, { key: 'Escape' });

    expect(composer.queryByRole('listbox', { name: 'Files' })).toBeNull();
    expect(prompt.value).toBe('@READ');
  });
});

describe('/ commands', () => {
  it("lists the palette's actions after /, and runs the one picked instead of sending", async () => {
    const main = new FakeMain({ projects: [project], sessions: [finished] });
    const { composer, prompt } = openSession(main);

    type(prompt, '/edit');

    const commands = within(composer.getByRole('listbox', { name: 'Commands' }));
    expect(commands.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['Open in editor']);
    fireEvent.keyDown(prompt, { key: 'Enter' });

    await waitFor(() => expect(main.invoked.find((i) => i.command === 'sessions.openInEditor')?.params).toEqual({ id: finished.id }));
    expect(prompt.value).toBe('');
    expect(main.invoked.some((i) => i.command === 'sessions.send')).toBe(false);
  });

  it('sends a prompt that only starts with / when no action matches it', async () => {
    const main = new FakeMain({ projects: [project], sessions: [finished] });
    const { composer, prompt } = openSession(main);

    type(prompt, '/usr/bin is missing');
    expect(within(composer.getByRole('listbox', { name: 'Commands' })).getByText('No command matches.')).toBeTruthy();
    fireEvent.keyDown(prompt, { key: 'Enter' });

    await waitFor(() => expect(main.invoked.find((i) => i.command === 'sessions.send')?.params).toEqual({ id: finished.id, prompt: '/usr/bin is missing' }));
  });
});

