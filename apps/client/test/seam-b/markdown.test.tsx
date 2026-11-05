import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, TranscriptItem } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

/** What the app put on the clipboard, latest last. */
let clipboard: string[];
beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void clipboard.push(text) },
  });
});

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
  title: 'Explain the tests',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};

/** The app with the Session open; `show` publishes its transcript. */
function openSession(session: Session = finished) {
  const main = new FakeMain({ projects: [project], sessions: [session] });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  if (session.status === 'archived') fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  const chat = () => screen.getByRole('log', { name: 'Conversation' });
  const show = (...items: TranscriptItem[]) => act(() => main.publish('transcript', items, { sessionId: session.id }));
  return { main, chat, show };
}

const agent = (text: string, streaming = false): TranscriptItem => ({ kind: 'agent', id: 2, text, streaming });
const user = (text: string): TranscriptItem => ({ kind: 'user', id: 1, text });

describe('Markdown in chat messages', () => {
  it("renders the agent's reply as GitHub-flavoured Markdown", () => {
    const { chat, show } = openSession();

    show(
      user('Explain'),
      agent(
        [
          '## Summary',
          '',
          'Some *emphasis*, **strong** and `inline code`.',
          '',
          '- one',
          '- two',
          '',
          '- [x] done',
          '- [ ] todo',
          '',
          '| Name | Value |',
          '| ---- | ----- |',
          '| a    | 1     |',
        ].join('\n'),
      ),
    );

    const reply = within(chat()).getByRole('heading', { name: 'Summary', level: 2 }).closest('.msg') as HTMLElement;
    expect(reply.className).toContain('agent');
    expect(within(reply).getByText('emphasis').tagName).toBe('EM');
    expect(within(reply).getByText('strong').tagName).toBe('STRONG');
    expect(within(reply).getByText('inline code').tagName).toBe('CODE');
    expect(within(reply).getByText('one').closest('ul')).toBeTruthy();
    expect((within(reply).getAllByRole('checkbox') as HTMLInputElement[]).map((box) => box.checked)).toEqual([true, false]);
    expect(within(reply).getByRole('table')).toBeTruthy();
    expect(within(reply).getByRole('cell', { name: '1' })).toBeTruthy();
  });

  it("renders the user's own messages the same way, keeping their line breaks", () => {
    const { chat, show } = openSession();

    show(user('Please fix **the login** bug\nand `npm test`'));

    const message = within(chat()).getByText('the login').closest('.msg') as HTMLElement;
    expect(message.className).toContain('user');
    expect(within(message).getByText('the login').tagName).toBe('STRONG');
    expect(within(message).getByText('npm test').tagName).toBe('CODE');
    expect(message.querySelector('br')).toBeTruthy();
  });

  it('shows raw HTML as text, never rendering or running it', () => {
    const { chat, show } = openSession();

    show(user('<b>bold?</b>'), agent('Before\n\n<img src="x" onerror="alert(1)">\n\n<script>alert(2)</script>\n\nInline <i>tag</i> here'));

    expect(chat().querySelector('img, script, b, i')).toBeNull();
    expect(within(chat()).getByText('<img src="x" onerror="alert(1)">')).toBeTruthy();
    expect(within(chat()).getByText('<script>alert(2)</script>')).toBeTruthy();
    expect(within(chat()).getByText('Inline <i>tag</i> here')).toBeTruthy();
    expect(within(chat()).getByText('<b>bold?</b>')).toBeTruthy();
  });

  it('shows a fenced code block with its language and highlighting, and copies its raw contents', async () => {
    const { chat, show } = openSession();
    const code = 'const answer = 42;\nconsole.log("hi");';

    show(user('Show me'), agent(`Here:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nAnd:\n\n\`\`\`\nplain\n\`\`\``));

    const [typed, plain] = within(chat()).getAllByRole('figure') as [HTMLElement, HTMLElement];
    expect(within(typed).getByText('ts')).toBeTruthy();
    const block = typed.querySelector('pre code')!;
    expect(block.textContent).toBe(`${code}\n`);
    expect(block.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(within(plain).queryByText('ts')).toBeNull();

    fireEvent.click(within(typed).getByRole('button', { name: 'Copy code' }));
    expect(await within(typed).findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(clipboard).toEqual([code]);
    fireEvent.click(within(plain).getByRole('button', { name: 'Copy code' }));
    await within(plain).findByRole('button', { name: 'Copied' });
    expect(clipboard.at(-1)).toBe('plain');
  });

  it('renders a reply as it streams, with a code fence not yet closed', () => {
    const { chat, show } = openSession();

    show(user('Show me'), agent('Here:\n\n```py\nprint(1)\nprint(', true));
    const block = within(chat()).getByRole('figure');
    expect(block.querySelector('pre code')?.textContent).toBe('print(1)\nprint(\n');
    expect(within(chat()).getByText('Here:').tagName).toBe('P');

    show(user('Show me'), agent('Here:\n\n```py\nprint(1)\nprint(2)\n```\n\nDone.'));
    expect(within(chat()).getByRole('figure').querySelector('pre code')?.textContent).toBe('print(1)\nprint(2)\n');
    expect(within(chat()).getByText('Done.').tagName).toBe('P');
  });

  it('copies the text of a blockquote, without its quote markers', async () => {
    const { chat, show } = openSession();

    show(user('Quote it'), agent('The commit says:\n\n> Fix **the login** bug\n>\n> Closes #12\n\nThat is all.'));

    const quote = within(chat()).getByText('the login').closest('blockquote')!.parentElement!;
    fireEvent.click(within(quote).getByRole('button', { name: 'Copy quote' }));
    await within(quote).findByRole('button', { name: 'Copied' });
    expect(clipboard).toEqual(['Fix **the login** bug\n\nCloses #12']);
  });

  it('opens links in the system browser, never in the Loom window', () => {
    const { main, chat, show } = openSession();

    show(user('Where?'), agent('See [the issue](https://github.com/acme/billing-api/issues/12) or https://example.com/docs.'));

    const issue = within(chat()).getByRole('link', { name: 'the issue' });
    expect(fireEvent.click(issue)).toBe(false); // the click's default, navigating, was prevented
    fireEvent.click(within(chat()).getByRole('link', { name: 'https://example.com/docs' }));
    expect(main.invoked.filter((i) => i.command === 'links.open').map((i) => i.params)).toEqual([
      { url: 'https://github.com/acme/billing-api/issues/12' },
      { url: 'https://example.com/docs' },
    ]);
  });

  it('renders a replayed transcript on an Archived Session the same as a live one', () => {
    const { chat, show } = openSession({ ...finished, status: 'archived', waitingReason: undefined });

    show(user('Explain'), agent('## Summary\n\n```sh\nnpm test\n```'));

    expect(within(chat()).getByRole('heading', { name: 'Summary' })).toBeTruthy();
    expect(within(within(chat()).getByRole('figure')).getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });
});
