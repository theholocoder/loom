import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SelectedLineRange } from '@pierre/diffs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { MergeRequestDetails, MergeRequestDiff, Project, Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

type DiffProps = { patch: string; options: { onGutterUtilityClick?: (range: SelectedLineRange) => void } };
const drawn = vi.hoisted(() => new Map<string, DiffProps>());

// The Diff tab draws its diffs as Changes does: they stop at the patch.
vi.mock('@pierre/diffs/react', () => ({
  PatchDiff: (props: DiffProps & { lineAnnotations?: Array<{ metadata?: string }>; renderAnnotation?: (a: unknown) => React.ReactNode }) => {
    drawn.set(props.patch, props);
    return (
      <div>
        <pre data-testid="patch-diff">{props.patch}</pre>
        {props.lineAnnotations?.map((a) => <div key={a.metadata}>{props.renderAnnotation?.(a)}</div>)}
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
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', host: 'github.com', repository: 'acme/billing-api' },
};
const url = 'https://github.com/acme/billing-api/pull/40';
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
};

const details: MergeRequestDetails = {
  number: 40,
  url,
  title: 'Show invoices in their currency',
  state: 'open',
  draft: false,
  sourceBranch: 'loom/fix-login',
  targetBranch: 'main',
  author: 'octocat',
  description: 'What it does.',
  reviewers: [],
  commits: 2,
  files: 2,
  added: 2,
  removed: 1,
  checks: [{ name: 'test', state: 'passed' }],
  reviews: [],
  comments: [],
};
const currency = 'src/currency.ts';
const patchOf = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n context\n-old\n+${line}\n`;
const diff: MergeRequestDiff = {
  files: [
    { path: currency, status: 'committed', added: 1, removed: 1, binary: false, text: patchOf(currency, 'new'), truncated: false },
    { path: 'logo.png', status: 'committed', added: 0, removed: 0, binary: true, text: '', truncated: false },
  ],
};

function renderApp({ sessions = [session], read = () => diff }: { sessions?: Session[]; read?: () => MergeRequestDiff } = {}) {
  const main = new FakeMain({ projects: [project], sessions }, { 'sessions.mergeRequest': () => details, 'sessions.mergeRequestDiff': read });
  main.publish('panels', { side: { panels: ['changes', 'merge-request'], shown: 'merge-request', open: true }, dock: { panels: [], shown: null, open: false } }, { sessionId: session.id });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  return main;
}

const sideArea = () => screen.queryByRole('complementary', { name: 'Side area' });
const reviewArea = () => screen.queryByRole('region', { name: 'Review mode' });
const mrTabs = () => screen.getByRole('tablist', { name: 'Merge request' });
const reads = (main: FakeMain) => main.invoked.filter((c) => c.command === 'sessions.mergeRequestDiff');

async function showDiff() {
  fireEvent.click(within(await screen.findByRole('tablist', { name: 'Merge request' })).getByRole('tab', { name: 'Diff' }));
  return screen.findByRole('tabpanel', { name: 'Diff' });
}

describe("the Merge request Panel's Diff tab", () => {
  it('shows what the Merge request changes, as its Forge has it, the way Changes shows a diff', async () => {
    const main = renderApp();
    const overview = await screen.findByRole('tabpanel', { name: 'Overview' });
    await within(overview).findByText('What it does.');
    // Not read until the tab shows.
    expect(reads(main)).toHaveLength(0);
    const diffTab = within(mrTabs()).getByRole('tab', { name: 'Diff' });
    expect(diffTab.getAttribute('aria-description')).toBe('2 files');
    expect(diffTab.textContent).toBe('Diff2');

    const tab = await showDiff();
    expect(within(mrTabs()).getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tabpanel', { name: 'Overview' })).toBeNull();
    const file = await within(tab).findByRole('region', { name: currency });
    expect((await within(file).findByTestId('patch-diff')).textContent).toBe(patchOf(currency, 'new'));
    // Its files aren't the working copy's: none opens in the editor.
    expect(within(file).queryByRole('button', { name: `Open ${currency} in the editor` })).toBeNull();
    // A binary file starts collapsed, as on Changes.
    expect(within(within(tab).getByRole('region', { name: 'logo.png' })).getByRole('button', { name: 'logo.png' }).getAttribute('aria-expanded')).toBe('false');
    expect(within(tab).getByRole('navigation', { name: 'Changed files' })).toBeTruthy();
    expect(within(tab).getByRole('button', { name: 'Side by side' })).toBeTruthy();
    expect(reads(main)).toEqual([{ command: 'sessions.mergeRequestDiff', params: { id: session.id } }]);
  });

  it('is read again on the Panel’s refresh, showing the new diff', async () => {
    let line = 'new';
    const main = renderApp({ read: () => ({ files: [{ ...diff.files[0]!, text: patchOf(currency, line) }] }) });
    const tab = await showDiff();
    await within(tab).findByText(patchOf(currency, 'new'), { normalizer: (s) => s });
    line = 'newer';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh the Merge request' }));
    await waitFor(() => expect(within(tab).getByTestId('patch-diff').textContent).toBe(patchOf(currency, 'newer')));
    expect(reads(main)).toHaveLength(2);
  });

  it("says why it couldn't be read, reading it again on Try again", async () => {
    let fail = true;
    renderApp({
      read: () => {
        if (fail) throw new Error('HTTP 502');
        return diff;
      },
    });
    const tab = await showDiff();
    expect((await within(tab).findByRole('alert')).textContent).toBe("Couldn't read the diff from GitHub: HTTP 502 Try again");
    fail = false;
    fireEvent.click(within(tab).getByRole('button', { name: 'Try again' }));
    await within(tab).findByRole('region', { name: currency });
    expect(within(tab).queryByRole('alert')).toBeNull();
  });

  it('says when the Forge listed only its first files', async () => {
    renderApp({ read: () => ({ ...diff, moreFiles: true }) });
    const tab = await showDiff();
    expect(await within(tab).findByText('GitHub listed only the first 2 files.')).toBeTruthy();
  });

  it('takes comments to the agent on its lines, as Changes does, but not on a Session whose worktree is gone', async () => {
    renderApp();
    const tab = await showDiff();
    await within(within(tab).getByRole('region', { name: currency })).findByTestId('patch-diff');
    act(() => drawn.get(patchOf(currency, 'new'))!.options.onGutterUtilityClick!({ start: 2, side: 'additions', end: 2 }));
    const field = within(tab).getByRole('textbox', { name: `Comment on ${currency}:2` });
    fireEvent.change(field, { target: { value: 'Why not keep it?' } });
    fireEvent.click(within(tab).getByRole('button', { name: 'Add comment' }));
    expect(await within(tab).findByRole('note', { name: `Your comment on ${currency}:2` })).toBeTruthy();
    cleanup();
    drawn.clear();

    renderApp({ sessions: [{ ...session, worktreeMissing: true }] });
    const archived = await showDiff();
    await within(await within(archived).findByRole('region', { name: currency })).findByTestId('patch-diff');
    expect(drawn.get(patchOf(currency, 'new'))!.options.onGutterUtilityClick).toBeUndefined();
  });

  it('can take Review mode from its ⤢, which only the Diff tab offers, and leaves it for the Overview', async () => {
    renderApp();
    await screen.findByRole('tabpanel', { name: 'Overview' });
    expect(within(sideArea()!).queryByRole('button', { name: 'Review Merge request' })).toBeNull();
    fireEvent.contextMenu(within(sideArea()!).getByRole('tab', { name: 'Merge request' }));
    expect(screen.queryByRole('menuitem', { name: 'Review mode' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    await showDiff();
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Review Merge request' }));
    expect(sideArea()).toBeNull();
    const surface = reviewArea()!;
    await within(surface).findByRole('region', { name: currency });

    fireEvent.click(within(within(surface).getByRole('tablist', { name: 'Merge request' })).getByRole('tab', { name: 'Overview' }));
    expect(reviewArea()).toBeNull();
    expect(sideArea()).not.toBeNull();
    expect(within(sideArea()!).getByRole('tabpanel', { name: 'Overview' })).toBeTruthy();
  });

  it('leaves Review mode for the Overview when its reviews are asked for', async () => {
    renderApp({ sessions: [{ ...session, babysit: { stale: false, reviews: { reviews: 1, comments: 0, changesRequested: true } } }] });
    await showDiff();
    fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Review Merge request' }));
    expect(reviewArea()).not.toBeNull();

    fireEvent.click(within(screen.getByRole('group', { name: 'Session at a glance' })).getByRole('button', { name: '1 review, changes requested: show them' }));
    expect(reviewArea()).toBeNull();
    expect(within(sideArea()!).getByRole('tabpanel', { name: 'Overview' })).toBeTruthy();
  });

  it('switches tabs with the arrow keys', async () => {
    renderApp();
    const overview = within(await screen.findByRole('tablist', { name: 'Merge request' })).getByRole('tab', { name: 'Overview' });
    overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    expect(await screen.findByRole('tabpanel', { name: 'Diff' })).toBeTruthy();
    expect(document.activeElement).toBe(within(mrTabs()).getByRole('tab', { name: 'Diff' }));
  });
});
