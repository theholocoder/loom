import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { DiffFile, DiffSummary, MergeRequestDetails, MergeRequestDiff, Project, ReviewThread, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

type Handlers = NonNullable<ConstructorParameters<typeof FakeMain>[1]>;

type Annotation = { side: string; lineNumber: number; metadata?: string };
type DiffProps = { patch: string; lineAnnotations?: Annotation[]; renderAnnotation?: (annotation: Annotation) => ReactNode };
/** What each patch was last drawn with, by its text. */
const drawn = vi.hoisted(() => new Map<string, DiffProps>());

// The library draws in a shadow DOM; these tests stop at the notes Loom hands it, drawn as it would under their lines.
vi.mock('@pierre/diffs/react', () => ({
  PatchDiff: (props: DiffProps) => {
    drawn.set(props.patch, props);
    return (
      <div>
        <pre data-testid="patch-diff">{props.patch}</pre>
        {props.lineAnnotations?.map((a) => <div key={`${a.side}:${a.lineNumber}:${a.metadata}`}>{props.renderAnnotation?.(a)}</div>)}
      </div>
    );
  },
}));

afterEach(() => {
  cleanup();
  drawn.clear();
});

const project: Project = {
  id: 1,
  name: 'billing-api',
  color: 'blue',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', host: 'github.com', repository: 'acme/billing-api' },
};
const url = 'https://github.com/acme/billing-api/pull/40';
const currency = 'src/currency.ts';
const thread: ReviewThread = {
  id: 'PRRT_1',
  path: currency,
  line: 2,
  side: 'new',
  code: "export const FALLBACK = 'EUR';",
  changesRequested: true,
  comments: [
    { author: 'mlefevre', body: 'Is **EUR** right as the fallback?', url: `${url}#discussion_r1` },
    { author: 'octocat', body: 'Checking.', url: `${url}#discussion_r2` },
  ],
  canResolve: true,
};
const session: Session = {
  id: 7,
  projectId: 1,
  title: 'Fix login',
  workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/billing-api/fix-login' },
  branch: 'loom/fix-login',
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
  mergeRequest: { number: 40, url },
  mergeRequestState: 'open',
  babysit: { stale: false, lastPollAt: 1 },
};

const patch = `diff --git a/${currency} b/${currency}\n--- a/${currency}\n+++ b/${currency}\n@@ -1,2 +1,2 @@\n import { x } from './x';\n-export const FALLBACK = 'USD';\n+export const FALLBACK = 'EUR';\n`;
const files: DiffFile[] = [{ path: currency, status: 'committed', added: 1, removed: 1, binary: false }];
const summary: DiffSummary = { available: true, readOnly: false, base: 'origin/main', files };
const details: MergeRequestDetails = {
  number: 40,
  url,
  title: 'Show invoices in their currency',
  state: 'open',
  draft: false,
  sourceBranch: 'loom/fix-login',
  targetBranch: 'main',
  author: 'octocat',
  description: '',
  reviewers: [],
  commits: 1,
  files: 1,
  added: 1,
  removed: 1,
  checks: [],
  reviews: [],
  comments: [],
};
const mrDiff: MergeRequestDiff = { files: [{ ...files[0]!, text: patch, truncated: false }] };

function renderApp({ s = session, p = project, shown = 'changes' as 'changes' | 'merge-request', diffText = patch, threads = [thread], handlers = {} as Handlers } = {}) {
  const main = new FakeMain(
    { projects: [p], sessions: [s] },
    {
      ...handlers,
      'sessions.diff': () => summary,
      'sessions.diffFile': () => ({ text: diffText, truncated: false }),
      'sessions.mergeRequest': () => details,
      'sessions.mergeRequestDiff': () => mrDiff,
    },
  );
  main.publish('panels', { side: { panels: ['changes', 'merge-request'], shown, open: true }, dock: { panels: [], shown: null, open: false } }, { sessionId: s.id });
  main.publish('reviewThreads', threads, { sessionId: s.id });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  const inbox = within(screen.getByRole('complementary', { name: 'Inbox' }));
  if (s.status === 'archived') fireEvent.click(inbox.getByRole('button', { name: 'Archived' }));
  fireEvent.click(inbox.getByRole('button', { name: s.title }));
  return main;
}

const changes = () => screen.getByRole('tabpanel', { name: 'Changes' });
const composer = () => within(screen.getByRole('form', { name: 'Composer' }));
const noteName = `Review comment by mlefevre on ${currency}:2`;
const calls = (main: FakeMain, command: string) => main.invoked.filter((c) => c.command === command).map((c) => c.params);

async function noteInChanges() {
  await within(await within(changes()).findByRole('region', { name: currency })).findByTestId('patch-diff');
  return within(changes()).getByRole('note', { name: noteName });
}

describe("the Merge request's review comments, as notes on the diff", () => {
  it('shows each under its line in Changes: who said what, the replies, and a count in the file tree', async () => {
    renderApp();
    const note = await noteInChanges();
    expect(drawn.get(patch)!.lineAnnotations).toEqual([{ side: 'additions', lineNumber: 2, metadata: 'review:PRRT_1' }]);
    expect(note.textContent).toContain('mlefevre');
    expect(note.textContent).toContain('on the Merge request');
    expect(within(note).getByText('Changes requested')).toBeTruthy();
    expect(within(note).getByText('EUR').tagName).toBe('STRONG');
    expect(note.textContent).toContain('Checking.');
    expect(within(note).getByRole('button', { name: 'Ask the agent' })).toBeTruthy();
    expect(within(note).getByRole('button', { name: 'Reply' })).toBeTruthy();
    expect(within(note).getByRole('button', { name: 'Resolve' })).toBeTruthy();
    expect(within(within(changes()).getByRole('navigation', { name: 'Changed files' })).getByLabelText('1 review thread')).toBeTruthy();
  });

  it('shows them in the Merge request Panel\'s Diff tab too', async () => {
    renderApp({ shown: 'merge-request' });
    fireEvent.click(within(await screen.findByRole('tablist', { name: 'Merge request' })).getByRole('tab', { name: 'Diff' }));
    const tab = await screen.findByRole('tabpanel', { name: 'Diff' });
    await within(await within(tab).findByRole('region', { name: currency })).findByTestId('patch-diff');
    expect(within(tab).getByRole('note', { name: noteName })).toBeTruthy();
  });

  it('puts a comment on the line in the composer for Ask the agent, once', async () => {
    const main = renderApp();
    fireEvent.click(within(await noteInChanges()).getByRole('button', { name: 'Ask the agent' }));

    expect(composer().getByRole('button', { name: `Edit comment on ${currency}:2` })).toBeTruthy();
    expect(within(changes()).getByRole('note', { name: `Your comment on ${currency}:2` })).toBeTruthy();
    expect(within(within(changes()).getByRole('note', { name: noteName })).queryByRole('button', { name: 'Ask the agent' })).toBeNull();

    fireEvent.click(composer().getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls(main, 'sessions.send')).toHaveLength(1));
    expect(calls(main, 'sessions.send')[0]).toEqual({
      id: 7,
      prompt: '',
      comments: [
        {
          path: currency,
          start: 2,
          end: 2,
          lines: ["+export const FALLBACK = 'EUR';"],
          note: [`Address this review comment on the Merge request (${url}#discussion_r1):`, '', '> mlefevre wrote:', '> Is **EUR** right as the fallback?', '>', '> octocat wrote:', '> Checking.'].join('\n'),
        },
      ],
    });
  });

  it('replies on the Forge from the note: Ctrl+Enter posts it, Esc drops it', async () => {
    const main = renderApp();
    const note = await noteInChanges();
    fireEvent.click(within(note).getByRole('button', { name: 'Reply' }));
    const field = within(note).getByRole('textbox', { name: 'Reply' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(within(note).queryByRole('textbox', { name: 'Reply' })).toBeNull();

    fireEvent.click(within(note).getByRole('button', { name: 'Reply' }));
    expect(within(note).getByRole('button', { name: 'Reply', hidden: false }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(note).getByRole('textbox', { name: 'Reply' }), { target: { value: 'GBP for old accounts.' } });
    fireEvent.keyDown(within(note).getByRole('textbox', { name: 'Reply' }), { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(within(note).queryByRole('textbox', { name: 'Reply' })).toBeNull());
    expect(calls(main, 'sessions.replyToReviewThread')).toEqual([{ id: 7, thread: 'PRRT_1', body: 'GBP for old accounts.' }]);
  });

  it('keeps the reply, saying why, when the Forge refuses it', async () => {
    renderApp({
      handlers: {
        'sessions.replyToReviewThread': () => {
          throw new Error('gh api graphql exited with code 1: Resource not accessible');
        },
      },
    });
    const note = await noteInChanges();
    fireEvent.click(within(note).getByRole('button', { name: 'Reply' }));
    fireEvent.change(within(note).getByRole('textbox', { name: 'Reply' }), { target: { value: 'Done.' } });
    fireEvent.click(within(note).getAllByRole('button', { name: 'Reply' }).at(-1)!);

    expect((await within(note).findByRole('alert')).textContent).toContain('Resource not accessible');
    expect((within(note).getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement).value).toBe('Done.');
  });

  it("resolves it on the Forge, the note going at once, until Babysit's next read says otherwise", async () => {
    const main = renderApp();
    fireEvent.click(within(await noteInChanges()).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(within(changes()).queryByRole('note', { name: noteName })).toBeNull());
    expect(calls(main, 'sessions.resolveReviewThread')).toEqual([{ id: 7, thread: 'PRRT_1' }]);

    // Unresolved on the Forge since: the next read has it again.
    act(() => {
      main.publish('sessions', [{ ...session, babysit: { stale: false, lastPollAt: 2 } }]);
      main.publish('reviewThreads', [thread], { sessionId: session.id });
    });
    expect(await within(changes()).findByRole('note', { name: noteName })).toBeTruthy();
  });

  it('shows one whose line the diff no longer holds as it was above the file, without Ask the agent', async () => {
    const changed = patch.replace("+export const FALLBACK = 'EUR';", "+export const FALLBACK = 'GBP';");
    renderApp({ diffText: changed });
    await within(await within(changes()).findByRole('region', { name: currency })).findByTestId('patch-diff');
    expect(drawn.get(changed)!.lineAnnotations).toEqual([]);
    const note = within(changes()).getByRole('note', { name: noteName });
    expect(note.textContent).toContain('on line 2, which has changed since');
    expect(within(note).queryByRole('button', { name: 'Ask the agent' })).toBeNull();
    expect(within(note).getByRole('button', { name: 'Resolve' })).toBeTruthy();
  });

  it('shows no Resolve where the Forge says the user may not, and only Open with the Forge off', async () => {
    renderApp({ s: { ...session, babysit: { stale: false } }, threads: [{ ...thread, canResolve: false }] });
    const note = await noteInChanges();
    expect(within(note).queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(within(note).getByRole('button', { name: 'Reply' })).toBeTruthy();
    cleanup();

    renderApp({ p: { ...project, forge: { state: 'signed-out', checking: false } } });
    const off = await noteInChanges();
    expect(within(off).queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(within(off).queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(within(off).getByRole('button', { name: 'Ask the agent' })).toBeTruthy();
    expect(within(off).getByRole('button', { name: 'Open the comment by mlefevre on the Forge' })).toBeTruthy();
  });
});
