import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SelectedLineRange } from '@pierre/diffs';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { WATCH_INTERVAL_MS, WIDE_CHANGES_PX } from '../../src/renderer/Changes';
import { DEFAULT_SETTINGS, type DiffFile, type DiffScope, type DiffSummary, type Project, type Session } from '../../src/shared/api';
import { FakeMain, HIDDEN_PANELS } from './fake-main';

type DiffProps = {
  patch: string;
  options: { onGutterUtilityClick?: (range: SelectedLineRange) => void } & Record<string, unknown>;
  lineAnnotations?: Array<{ side: string; lineNumber: number }>;
  selectedLines?: SelectedLineRange | null;
  renderAnnotation?: (annotation: { side: string; lineNumber: number }) => ReactNode;
};
/** What each patch was last drawn with, by its text. */
const drawn = vi.hoisted(() => new Map<string, DiffProps>());

// The library draws in a shadow DOM and highlights asynchronously; these tests
// stop at the data Loom hands it, and at what it calls back with.
vi.mock('@pierre/diffs/react', () => ({
  PatchDiff: (props: DiffProps) => {
    drawn.set(props.patch, props);
    return (
      <div>
        <pre data-testid="patch-diff" data-options={JSON.stringify(props.options)} data-selected={JSON.stringify(props.selectedLines ?? null)}>
          {props.patch}
        </pre>
        {props.lineAnnotations?.map((a) => <div key={`${a.side}:${a.lineNumber}`}>{props.renderAnnotation?.(a)}</div>)}
      </div>
    );
  },
}));

afterEach(cleanup);

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'acme/billing-api' },
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
  diffStat: { files: 4, added: 1210, removed: 3 },
};

const files: DiffFile[] = [
  { path: 'src/auth/login.ts', status: 'committed', added: 5, removed: 2, binary: false },
  { path: 'src/auth/session.ts', status: 'modified', added: 2, removed: 1, binary: false },
  { path: 'docs/logo.png', status: 'untracked', added: 0, removed: 0, binary: true },
  { path: 'pnpm-lock.yaml', status: 'committed', added: 1200, removed: 0, binary: false },
];
const summary: DiffSummary = { available: true, readOnly: false, base: 'origin/main', files };
const text = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n context\n-old line\n+new line\n`;

function renderOpen(main: FakeMain, s: Session = session) {
  // Hidden, so that `d` shows it.
  main.publish('panels', HIDDEN_PANELS, { sessionId: s.id });
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

/** Shows the Changes Panel, as `d` does. */
const showChanges = () => fireEvent.keyDown(document.body, { key: 'd' });
const hideChanges = showChanges;

function fakeMain(result: DiffSummary = summary, s: Session = session, settings = DEFAULT_SETTINGS) {
  return new FakeMain(
    { projects: [project], sessions: [s], settings },
    {
      'sessions.diff': ({ scope }) => (result.available ? { ...result, files: result.files.filter((f) => inScope(f, scope)) } : result),
      'sessions.diffFile': ({ path }) => ({ text: text(path), truncated: false }),
    },
  );
}

/** Whether a file shows in a scope, as main would list it. */
const inScope = (file: DiffFile, scope: DiffScope = 'all') => scope === 'all' || (scope === 'committed') === (file.status === 'committed');

const panel = () => screen.getByRole('tabpanel', { name: 'Changes' });
/** The head of the file tree stacked above the diffs, which folds it. */
const treeHead = () => within(panel()).getByRole('button', { name: /^(\d+ of )?\d+ files?/ });
const scopeButton = (name: string) => within(panel()).getByRole('radio', { name: new RegExp(`^${name}`) });
const diffCalls = (main: FakeMain, command: string) => main.invoked.filter((c) => c.command === command);

describe('the Changes view', () => {
  it('works out the diff only once the Changes view is first shown', () => {
    const main = renderOpen(fakeMain());
    expect(screen.queryByRole('tabpanel', { name: 'Changes' })).toBeNull();
    expect(diffCalls(main, 'sessions.diff')).toHaveLength(0);
    fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    expect(diffCalls(main, 'sessions.diff')).toHaveLength(0);

    fireEvent.click(within(screen.getByRole('group', { name: 'Session at a glance' })).getByRole('button', { name: /^Show changes/ }));
    expect(panel()).toBeTruthy();
    expect(diffCalls(main, 'sessions.diff')).toHaveLength(1);
  });

  it('shows a file tree and per-file sections, large, binary and lockfiles collapsed, loading a diff on expand', async () => {
    const main = renderOpen(fakeMain());
    showChanges();
    const tree = within(await within(panel()).findByRole('navigation', { name: 'Changed files' }));
    expect(tree.getByRole('button', { name: 'src' }).getAttribute('aria-expanded')).toBe('true');
    expect(tree.getByRole('button', { name: /committed.*login\.ts/ })).toBeTruthy();
    expect(tree.getByRole('button', { name: /modified.*session\.ts/ })).toBeTruthy();
    expect(tree.getByRole('button', { name: /untracked.*logo\.png/ })).toBeTruthy();
    fireEvent.click(tree.getByRole('button', { name: 'src' }));
    expect(tree.queryByRole('button', { name: /login\.ts/ })).toBeNull();

    const section = (path: string) => within(panel()).getByRole('region', { name: path });
    const toggle = (path: string) => within(section(path)).getByRole('button', { name: new RegExp(`^${path.replaceAll('.', '\\.')}`) });
    expect(toggle('src/auth/login.ts').getAttribute('aria-expanded')).toBe('true');
    const diff = await within(section('src/auth/login.ts')).findByTestId('patch-diff');
    expect(diff.textContent).toBe(text('src/auth/login.ts'));
    expect(JSON.parse(diff.dataset.options!)).toMatchObject({ diffStyle: 'unified', overflow: 'scroll', lineDiffType: 'word', lineHoverHighlight: 'both', disableFileHeader: true, disableLineNumbers: false });
    for (const collapsed of ['docs/logo.png', 'pnpm-lock.yaml']) expect(toggle(collapsed).getAttribute('aria-expanded')).toBe('false');
    expect(diffCalls(main, 'sessions.diffFile').map((c) => (c.params as { path: string }).path).sort()).toEqual(['src/auth/login.ts', 'src/auth/session.ts']);

    fireEvent.click(toggle('pnpm-lock.yaml'));
    expect((await within(section('pnpm-lock.yaml')).findByTestId('patch-diff')).textContent).toBe(text('pnpm-lock.yaml'));

    fireEvent.click(within(section('src/auth/login.ts')).getByRole('button', { name: 'Open src/auth/login.ts in the editor' }));
    expect(main.invoked).toContainEqual({ command: 'sessions.openInEditor', params: { id: 7, file: 'src/auth/login.ts' } });
  });

  it('switches between all, committed and uncommitted changes, with how many files each holds, and refreshes', async () => {
    const main = renderOpen(fakeMain({ ...summary, counts: { all: 4, committed: 2, uncommitted: 2 } }));
    showChanges();
    await within(panel()).findByRole('region', { name: 'src/auth/login.ts' });
    const scopes = within(panel()).getByRole('radiogroup', { name: 'Which changes' });
    expect(within(scopes).getAllByRole('radio').map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([
      ['All4', 'true'],
      ['Committed2', 'false'],
      ['Uncommitted2', 'false'],
    ]);
    expect(diffCalls(main, 'sessions.diff').at(-1)?.params).toEqual({ id: 7, scope: 'all' });

    fireEvent.click(scopeButton('Uncommitted'));
    await waitFor(() => expect(within(panel()).queryByRole('region', { name: 'src/auth/login.ts' })).toBeNull());
    expect(scopeButton('Uncommitted').getAttribute('aria-checked')).toBe('true');
    expect(diffCalls(main, 'sessions.diff').at(-1)?.params).toEqual({ id: 7, scope: 'uncommitted' });
    await waitFor(() => expect(diffCalls(main, 'sessions.diffFile').at(-1)?.params).toMatchObject({ scope: 'uncommitted' }));

    fireEvent.click(scopeButton('Committed'));
    await waitFor(() => expect(within(panel()).queryByRole('region', { name: 'src/auth/session.ts' })).toBeNull());
    expect(within(panel()).getByRole('region', { name: 'src/auth/login.ts' })).toBeTruthy();
    expect(diffCalls(main, 'sessions.diff').at(-1)?.params).toEqual({ id: 7, scope: 'committed' });

    const before = diffCalls(main, 'sessions.diff').length;
    fireEvent.click(within(panel()).getByRole('button', { name: 'Refresh changes' }));
    await waitFor(() => expect(diffCalls(main, 'sessions.diff').length).toBe(before + 1));
  });

  it('refreshes at the end of a turn and on reopening', async () => {
    const main = renderOpen(fakeMain());
    showChanges();
    await waitFor(() => expect(diffCalls(main, 'sessions.diff')).toHaveLength(1));
    act(() => main.publish('sessions', [{ ...session, status: 'working' }]));
    act(() => main.publish('sessions', [{ ...session, status: 'waiting', updatedAt: 5 }]));
    await waitFor(() => expect(diffCalls(main, 'sessions.diff')).toHaveLength(2));
    // An update that isn't a turn ending doesn't refresh it.
    act(() => main.publish('sessions', [{ ...session, status: 'waiting', updatedAt: 6, unread: true }]));
    hideChanges();
    expect(screen.queryByRole('tabpanel', { name: 'Changes' })).toBeNull();
    showChanges();
    await waitFor(() => expect(diffCalls(main, 'sessions.diff')).toHaveLength(3));
  });

  it("shows an archived Session's branch read-only, or no diff available", async () => {
    const archived = { ...session, status: 'archived' as const };
    const renderPanel = (main: FakeMain) => {
      renderOpen(main, archived);
      showChanges();
    };
    renderPanel(fakeMain({ ...summary, readOnly: true, files: [files[0]!] }, archived));
    await within(panel()).findByRole('region', { name: 'src/auth/login.ts' });
    expect(within(panel()).queryByRole('radiogroup', { name: 'Which changes' })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: /in the editor/ })).toBeNull();
    cleanup();

    renderPanel(fakeMain({ available: false, reason: 'No diff available' }, archived));
    expect(await within(panel()).findByText('No diff available')).toBeTruthy();
  });

  it('shows why the diff could not be worked out, still offering the uncommitted changes', async () => {
    const main = new FakeMain(
      { projects: [project], sessions: [session], settings: DEFAULT_SETTINGS },
      {
        'sessions.diff': ({ scope }) => {
          if (scope === 'uncommitted') return { available: true, readOnly: false, base: 'HEAD', files: [files[1]!] };
          throw new Error("There's no origin/main or origin/master here, nor a local main or master, to compare with.");
        },
        'sessions.diffFile': ({ path }) => ({ text: text(path), truncated: false }),
      },
    );
    renderOpen(main);
    showChanges();
    expect((await within(panel()).findByRole('alert')).textContent).toMatch(/nor a local main/);
    fireEvent.click(scopeButton('Uncommitted'));
    expect(await within(panel()).findByRole('region', { name: 'src/auth/session.ts' })).toBeTruthy();
    expect(within(panel()).getByRole('note').getAttribute('aria-label')).toMatch(/Compared with HEAD, the last commit/);
  });

  it('marks deleted and renamed files as such', async () => {
    renderOpen(
      fakeMain({
        ...summary,
        files: [
          { path: 'src/old.ts', status: 'committed', change: 'deleted', added: 0, removed: 4, binary: false },
          { path: 'src/new.ts', oldPath: 'src/was.ts', status: 'modified', change: 'renamed', added: 0, removed: 0, binary: false },
        ],
      }),
    );
    showChanges();
    const tree = within(await within(panel()).findByRole('navigation', { name: 'Changed files' }));
    expect(tree.getByRole('button', { name: /deleted.*old\.ts/ })).toBeTruthy();
    expect(tree.getByRole('button', { name: /renamed.*new\.ts/ })).toBeTruthy();
    const renamed = within(panel()).getByRole('region', { name: 'src/new.ts' });
    expect(renamed.textContent).toContain('src/was.ts → src/new.ts');
    expect(within(renamed).getByText('renamed')).toBeTruthy();
  });

  it('follows the working copy: a new fingerprint works the diff out again, an unchanged one does not', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let fingerprint = 'one';
      const main = new FakeMain(
        { projects: [project], sessions: [session], settings: DEFAULT_SETTINGS },
        {
          'sessions.diff': () => summary,
          'sessions.diffFile': ({ path }) => ({ text: text(path), truncated: false }),
          'sessions.diffFingerprint': () => fingerprint,
        },
      );
      renderOpen(main);
      showChanges();
      await waitFor(() => expect(diffCalls(main, 'sessions.diffFingerprint').length).toBeGreaterThan(0));
      await waitFor(() => expect(diffCalls(main, 'sessions.diff')).toHaveLength(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 2);
      });
      expect(diffCalls(main, 'sessions.diff')).toHaveLength(1);
      const loads = diffCalls(main, 'sessions.diffFile').length;

      fingerprint = 'two';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS);
      });
      await waitFor(() => expect(diffCalls(main, 'sessions.diff')).toHaveLength(2));
      // The open diffs are read again too.
      await waitFor(() => expect(diffCalls(main, 'sessions.diffFile').length).toBeGreaterThan(loads));

      hideChanges();
      const asked = diffCalls(main, 'sessions.diffFingerprint').length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 3);
      });
      expect(diffCalls(main, 'sessions.diffFingerprint')).toHaveLength(asked);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't watch an archived Session's branch", async () => {
    const archived = { ...session, status: 'archived' as const };
    const main = renderOpen(fakeMain({ ...summary, readOnly: true }, archived), archived);
    showChanges();
    await within(panel()).findByRole('region', { name: 'src/auth/login.ts' });
    expect(diffCalls(main, 'sessions.diffFingerprint')).toHaveLength(0);
  });
});

describe('a file\'s diff', () => {
  const oneFile = (file: DiffFile, diff: { text: string; truncated: boolean }, settings = DEFAULT_SETTINGS) =>
    renderOpen(
      new FakeMain(
        { projects: [project], sessions: [session], settings },
        {
          'sessions.diff': () => ({ ...summary, files: [file] }),
          'sessions.diffFile': () => diff,
        },
      ),
    );
  const loginTs = files[0]!;
  const section = () => within(panel()).findByRole('region', { name: loginTs.path });

  it('says when a diff is cut short, under what there is of it', async () => {
    oneFile(loginTs, { text: text(loginTs.path), truncated: true });
    showChanges();
    const file = within(await section());
    expect((await file.findByTestId('patch-diff')).textContent).toBe(text(loginTs.path));
    expect(file.getByText('This diff is too large to show in full.')).toBeTruthy();
  });

  it('hands the library nothing when there is no text at all', async () => {
    oneFile(loginTs, { text: '', truncated: true });
    showChanges();
    const file = within(await section());
    await file.findByText('This diff is too large to show in full.');
    expect(file.queryByTestId('patch-diff')).toBeNull();
  });

  it('says so when only the file\'s name or mode changed', async () => {
    oneFile(loginTs, { text: 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n', truncated: false });
    showChanges();
    const file = within(await section());
    await file.findByText('No changes to its content.');
    expect(file.queryByTestId('patch-diff')).toBeNull();
  });

  it('shows a binary file as one, without asking for its text', async () => {
    const main = oneFile({ ...loginTs, binary: true }, { text: '', truncated: false });
    showChanges();
    const file = within(await section());
    fireEvent.click(file.getByRole('button', { name: new RegExp(`^${loginTs.path}`) }));
    expect(await file.findByText('Binary file')).toBeTruthy();
    expect(file.queryByTestId('patch-diff')).toBeNull();
    expect(diffCalls(main, 'sessions.diffFile')).toHaveLength(0);
  });

  it.each([
    ['midnight', 'github-dark', 'dark'],
    ['paper', 'rose-pine-dawn', 'light'],
    ['nord', 'nord', 'dark'],
    ['mocha', 'catppuccin-mocha', 'dark'],
    ['daylight', 'github-light', 'light'],
  ] as const)('highlights the %s theme with %s, %s', async (theme, shiki, themeType) => {
    oneFile(loginTs, { text: text(loginTs.path), truncated: false }, { ...DEFAULT_SETTINGS, theme });
    showChanges();
    const file = within(await section());
    await waitFor(() => expect(JSON.parse(file.getByTestId('patch-diff').dataset.options!)).toMatchObject({ theme: shiki, themeType }));
  });

  it('restyles an open diff when the theme changes, without loading it again', async () => {
    const main = oneFile(loginTs, { text: text(loginTs.path), truncated: false });
    showChanges();
    const file = within(await section());
    await file.findByTestId('patch-diff');
    expect(diffCalls(main, 'sessions.diffFile')).toHaveLength(1);

    await act(() => main.invoke('settings.setAppearance', { theme: 'daylight' }));

    await waitFor(() => expect(JSON.parse(file.getByTestId('patch-diff').dataset.options!)).toMatchObject({ theme: 'github-light', themeType: 'light' }));
    expect(diffCalls(main, 'sessions.diffFile')).toHaveLength(1);
  });
});

describe("how the diffs are laid out", () => {
  const optionsOf = (element: HTMLElement) => JSON.parse(element.dataset.options!);
  const open = async () => {
    const main = renderOpen(fakeMain());
    showChanges();
    await within(panel()).findAllByTestId('patch-diff');
    return main;
  };
  const allOptions = () => within(panel()).getAllByTestId('patch-diff').map(optionsOf);

  it.each([
    ['Wrap long lines', { overflow: 'scroll' }, { overflow: 'wrap' }],
    ['Side by side', { diffStyle: 'unified' }, { diffStyle: 'split' }],
  ])('%s switches every open diff, and back, without loading them again', async (label, off, on) => {
    const main = await open();
    const loads = diffCalls(main, 'sessions.diffFile').length;
    const button = within(panel()).getByRole('button', { name: label });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    for (const options of allOptions()) expect(options).toMatchObject(off);

    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    for (const options of allOptions()) expect(options).toMatchObject(on);

    fireEvent.click(button);
    for (const options of allOptions()) expect(options).toMatchObject(off);
    expect(diffCalls(main, 'sessions.diffFile')).toHaveLength(loads);
  });

  it('wraps and goes side by side independently', async () => {
    await open();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Wrap long lines' }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Side by side' }));
    for (const options of allOptions()) expect(options).toMatchObject({ overflow: 'wrap', diffStyle: 'split' });
  });
});

describe('remembering how the diffs are laid out', () => {
  const pressed = (name: string) => within(panel()).getByRole('button', { name }).getAttribute('aria-pressed');
  const treeOpen = () => treeHead().getAttribute('aria-expanded');
  const click = (name: string) => fireEvent.click(within(panel()).getByRole('button', { name }));
  const openPanel = async () => {
    showChanges();
    await within(panel()).findAllByTestId('patch-diff');
  };

  it('opens as the settings say', async () => {
    renderOpen(fakeMain(summary, session, { ...DEFAULT_SETTINGS, diffView: { fileList: false, wrap: true, sideBySide: true } }));
    await openPanel();
    expect(within(panel()).queryByRole('navigation', { name: 'Changed files' })).toBeNull();
    expect(treeOpen()).toBe('false');
    for (const diff of within(panel()).getAllByTestId('patch-diff')) expect(JSON.parse(diff.dataset.options!)).toMatchObject({ overflow: 'wrap', diffStyle: 'split' });
  });

  it('saves each click, whole', async () => {
    const main = renderOpen(fakeMain());
    await openPanel();
    click('Wrap long lines');
    fireEvent.click(treeHead());
    const saved = main.invoked.filter((c) => c.command === 'settings.setDiffView').map((c) => c.params);
    expect(saved).toEqual([
      { fileList: true, wrap: true, sideBySide: false },
      { fileList: false, wrap: true, sideBySide: false },
    ]);
  });

  it('is as the user left it after closing and reopening the panel', async () => {
    renderOpen(fakeMain());
    await openPanel();
    fireEvent.click(treeHead());
    click('Wrap long lines');
    click('Side by side');
    hideChanges();
    expect(screen.queryByRole('tabpanel', { name: 'Changes' })).toBeNull();

    await openPanel();
    for (const name of ['Wrap long lines', 'Side by side']) expect(pressed(name)).toBe('true');
    expect(treeOpen()).toBe('false');
    expect(within(panel()).queryByRole('navigation', { name: 'Changed files' })).toBeNull();
  });

  it('goes back when the choice cannot be saved', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderOpen(
      new FakeMain(
        { projects: [project], sessions: [session], settings: DEFAULT_SETTINGS },
        {
          'sessions.diff': () => summary,
          'sessions.diffFile': ({ path }) => ({ text: text(path), truncated: false }),
          'settings.setDiffView': () => {
            throw new Error('disk full');
          },
        },
      ),
    );
    await openPanel();
    click('Wrap long lines');
    await waitFor(() => expect(pressed('Wrap long lines')).toBe('false'));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('the file list', () => {
  it('starts open above the diffs in a narrow Panel, its head saying how much changed and folding it', async () => {
    renderOpen(fakeMain());
    showChanges();
    await within(panel()).findByRole('navigation', { name: 'Changed files' });
    const head = treeHead();
    expect(head.textContent).toBe('4 files+1207 −3');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(within(panel()).getByRole('searchbox', { name: 'Filter changed files' })).toBeTruthy();

    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(within(panel()).queryByRole('navigation', { name: 'Changed files' })).toBeNull();
    expect(within(panel()).getByRole('region', { name: 'src/auth/login.ts' })).toBeTruthy();

    fireEvent.click(head);
    expect(within(panel()).getByRole('navigation', { name: 'Changed files' })).toBeTruthy();
  });

  it('sits beside the diffs, always shown, once the Panel is wide', async () => {
    const observed: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observed.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    let width = WIDE_CHANGES_PX - 1;
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    try {
      renderOpen(fakeMain(summary, session, { ...DEFAULT_SETTINGS, diffView: { ...DEFAULT_SETTINGS.diffView, fileList: false } }));
      showChanges();
      await within(panel()).findByRole('region', { name: 'src/auth/login.ts' });
      expect(within(panel()).queryByRole('navigation', { name: 'Changed files' })).toBeNull();

      width = WIDE_CHANGES_PX;
      act(() => observed.forEach((callback) => callback()));
      expect(within(panel()).getByRole('navigation', { name: 'Changed files' })).toBeTruthy();
      expect(within(panel()).queryByRole('button', { name: /^\d+ files/ })).toBeNull();

      width = WIDE_CHANGES_PX - 1;
      act(() => observed.forEach((callback) => callback()));
      expect(within(panel()).queryByRole('navigation', { name: 'Changed files' })).toBeNull();
    } finally {
      clientWidth.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('searching the changed files', () => {
  const tree = () => within(panel()).getByRole('navigation', { name: 'Changed files' });
  const search = () => within(panel()).getByRole('searchbox', { name: 'Filter changed files' });
  const type = (value: string) => fireEvent.change(search(), { target: { value } });
  const listed = () => within(tree()).getAllByRole('button').map((row) => row.textContent);
  const section = (path: string) => within(panel()).queryByRole('region', { name: path });
  const open = async () => {
    renderOpen(fakeMain());
    showChanges();
    await within(panel()).findByRole('navigation', { name: 'Changed files' });
  };

  it('narrows the tree as you type to the paths holding the text, whatever its case, keeping their folders', async () => {
    await open();
    type('AUTH/LOG');
    expect(listed()).toEqual(['src', 'auth', expect.stringContaining('login.ts')]);
    type('.yaml');
    expect(listed()).toEqual([expect.stringContaining('pnpm-lock.yaml')]);
  });

  it('matches on the whole path, so a folder name finds the files in it', async () => {
    await open();
    type('docs/');
    expect(listed()).toEqual(['docs', expect.stringContaining('logo.png')]);
  });

  it('narrows the diffs below to the same files', async () => {
    await open();
    type('login');
    expect(section('src/auth/login.ts')).toBeTruthy();
    for (const other of ['src/auth/session.ts', 'docs/logo.png', 'pnpm-lock.yaml']) expect(section(other)).toBeNull();
  });

  it('keeps narrowing the diffs with the file list folded, its head saying so', async () => {
    await open();
    type('login');
    fireEvent.click(treeHead());
    expect(treeHead().textContent).toMatch(/^1 of 4 files/);
    expect(section('src/auth/login.ts')).toBeTruthy();
    expect(section('src/auth/session.ts')).toBeNull();
  });

  it('brings back a filtered-out diff without loading it again', async () => {
    const main = fakeMain();
    renderOpen(main);
    showChanges();
    const shown = await within(panel()).findByRole('region', { name: 'src/auth/session.ts' });
    await within(shown).findByTestId('patch-diff');
    const loads = diffCalls(main, 'sessions.diffFile').length;
    type('login');
    type('');
    expect(within(section('src/auth/session.ts')!).getByTestId('patch-diff')).toBeTruthy();
    expect(diffCalls(main, 'sessions.diffFile')).toHaveLength(loads);
  });

  it('keeps the filter and the file list when switching to uncommitted changes', async () => {
    await open();
    type('session');
    fireEvent.click(scopeButton('Uncommitted'));
    await waitFor(() => expect(scopeButton('Uncommitted').getAttribute('aria-checked')).toBe('true'));
    expect((search() as HTMLInputElement).value).toBe('session');
    expect(within(tree()).getByRole('button', { name: /session\.ts/ })).toBeTruthy();
  });

  it('shows a match inside a folder that was closed', async () => {
    await open();
    fireEvent.click(within(tree()).getByRole('button', { name: 'docs' }));
    expect(within(tree()).queryByRole('button', { name: /logo\.png/ })).toBeNull();
    type('logo');
    expect(within(tree()).getByRole('button', { name: /logo\.png/ })).toBeTruthy();
    type('');
    expect(within(tree()).queryByRole('button', { name: /logo\.png/ })).toBeNull();
  });

  it('says so when nothing matches', async () => {
    await open();
    type('nothing-here');
    expect(within(panel()).queryByRole('navigation', { name: 'Changed files' })).toBeNull();
    for (const file of files) expect(section(file.path)).toBeNull();
    expect(within(panel()).getByText('No changed file matches “nothing-here”.')).toBeTruthy();
  });

  it('brings back the whole tree when the field is cleared', async () => {
    await open();
    const whole = listed();
    type('login');
    type('');
    expect(listed()).toEqual(whole);
    expect(within(panel()).queryByText(/No changed file matches/)).toBeNull();
  });

  it('ignores spaces around the text, so spaces alone search for nothing', async () => {
    await open();
    const whole = listed();
    type('   ');
    expect(listed()).toEqual(whole);
    expect(within(tree()).getByRole('button', { name: 'src' }).hasAttribute('disabled')).toBe(false);
    type(' login ');
    expect(listed()).toEqual(['src', 'auth', expect.stringContaining('login.ts')]);
  });

  it("doesn't run a letter's shortcut while typing in the field", async () => {
    await open();
    fireEvent.keyDown(search(), { key: 'd' });
    expect(panel()).toBeTruthy();
  });

  it('clears the field on Escape', async () => {
    await open();
    const whole = listed();
    type('login');
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect((search() as HTMLInputElement).value).toBe('');
    expect(listed()).toEqual(whole);
  });
});

describe("the diff's base", () => {
  it("shows what the diff is against, says in its tooltip when it is only origin's default, and sets another, refreshing the diff", async () => {
    let base = { base: 'origin/main', baseSource: 'default' as const };
    const main = renderOpen(
      new FakeMain(
        { projects: [project], sessions: [session], settings: DEFAULT_SETTINGS },
        {
          'sessions.diff': () => ({ ...summary, ...base }),
          'sessions.diffFile': ({ path }) => ({ text: text(path), truncated: false }),
          'sessions.diffBases': () => ['origin/main', 'origin/release/1.2'],
          'sessions.setDiffBase': ({ base: chosen }) => {
            base = { base: chosen, baseSource: 'recorded' as never };
          },
        },
      ),
    );
    showChanges();
    const panel = await screen.findByRole('tabpanel', { name: 'Changes' });

    const picker = await within(panel).findByRole('button', { name: 'Compared with' });
    expect(picker.textContent).toBe('origin/main');
    const why = () => within(panel).getByRole('note').getAttribute('title');
    expect(why()).toMatch(/^Compared with origin\/main: .*origin's default branch: where this branch started isn't known/);
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('option', { name: 'origin/release/1.2' }));

    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Compared with' }).textContent).toBe('origin/release/1.2'));
    expect(main.invoked.filter((i) => i.command === 'sessions.setDiffBase')).toEqual([{ command: 'sessions.setDiffBase', params: { id: 7, base: 'origin/release/1.2' } }]);
    await waitFor(() => expect(why()).toMatch(/^Compared with origin\/release\/1\.2: .*kept with the branch/));
  });

  it('has no base control on an archived read-only diff, nor for uncommitted changes', async () => {
    renderOpen(fakeMain({ ...summary, readOnly: true, baseSource: 'recorded' }));
    showChanges();
    const panel = await screen.findByRole('tabpanel', { name: 'Changes' });
    await waitFor(() => expect(panel.textContent).toContain('login.ts'));
    expect(within(panel).queryByRole('button', { name: 'Compared with' })).toBeNull();
    cleanup();

    renderOpen(fakeMain({ ...summary, baseSource: 'recorded' }));
    showChanges();
    const live = await screen.findByRole('tabpanel', { name: 'Changes' });
    await within(live).findByRole('button', { name: 'Compared with' });
    fireEvent.click(within(live).getByRole('radio', { name: /^Uncommitted/ }));
    await waitFor(() => expect(within(live).queryByRole('button', { name: 'Compared with' })).toBeNull());
    expect(within(live).getByRole('note').textContent).toBe('vs last commit');
  });
});

describe('commenting on the diff', () => {
  const loginTs = 'src/auth/login.ts';
  const composer = () => within(screen.getByRole('form', { name: 'Composer' }));
  const chips = () => composer().queryByRole('list', { name: 'Comments' });
  /** Opens the Changes view with login.ts's diff drawn, and hands back what the library calls on its "+". */
  const open = async (main = fakeMain()) => {
    renderOpen(main);
    showChanges();
    await within(await within(panel()).findByRole('region', { name: loginTs })).findByTestId('patch-diff');
    return main;
  };
  /** As the library does once the user presses its "+" by a line, or drags it over a range. */
  const pressPlus = (range: SelectedLineRange, path = loginTs) => act(() => drawn.get(text(path))!.options.onGutterUtilityClick!(range));
  const comment = async (range: SelectedLineRange, note: string, path = loginTs) => {
    pressPlus(range, path);
    fireEvent.change(await within(panel()).findByRole('textbox', { name: /^Comment on / }), { target: { value: note } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Add comment' }));
  };

  it('offers the "+" by each line, and line selection, on a live Session', async () => {
    await open();
    const options = JSON.parse(within(panel()).getAllByTestId('patch-diff')[0]!.dataset.options!);
    expect(options).toMatchObject({ enableGutterUtility: true, enableLineSelection: true });
  });

  it('asks for a note under the range, keeps it selected meanwhile, and adds a chip to the composer', async () => {
    await open();
    pressPlus({ start: 1, side: 'additions', end: 2, endSide: 'additions' });
    const note = await within(panel()).findByRole('textbox', { name: `Comment on ${loginTs}:1-2` });
    expect(JSON.parse(within(within(panel()).getByRole('region', { name: loginTs })).getByTestId('patch-diff').dataset.selected!)).toEqual({ start: 1, side: 'additions', end: 2, endSide: 'additions' });
    expect(drawn.get(text(loginTs))!.lineAnnotations).toEqual([{ side: 'additions', lineNumber: 2 }]);
    // No note, nothing to add.
    expect(within(panel()).getByRole('button', { name: 'Add comment' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(note, { target: { value: 'Keep the old name.' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Add comment' }));

    expect(within(panel()).queryByRole('textbox', { name: /^Comment on/ })).toBeNull();
    expect(drawn.get(text(loginTs))!.lineAnnotations ?? []).toEqual([]);
    const chip = within(chips()!).getByRole('listitem');
    expect(chip.textContent).toContain(`${loginTs}:1-2`);
    expect(chip.getAttribute('title')).toContain('Keep the old name.');
  });

  it('drops the note on Cancel, adding nothing', async () => {
    await open();
    pressPlus({ start: 2, side: 'deletions', end: 2, endSide: 'deletions' });
    fireEvent.click(await within(panel()).findByRole('button', { name: 'Cancel' }));
    expect(within(panel()).queryByRole('textbox', { name: /^Comment on/ })).toBeNull();
    expect(chips()).toBeNull();
  });

  it('accumulates chips across files until sent, each removable, and sends each with its quoted lines', async () => {
    const main = await open();
    await comment({ start: 1, side: 'additions', end: 2, endSide: 'additions' }, 'Keep the old name.');
    await within(within(panel()).getByRole('region', { name: 'src/auth/session.ts' })).findByTestId('patch-diff');
    await comment({ start: 2, side: 'deletions', end: 2, endSide: 'deletions' }, 'Why drop this?', 'src/auth/session.ts');
    await comment({ start: 1, side: 'additions', end: 1, endSide: 'additions' }, 'Typo?');
    expect(within(chips()!).getAllByRole('listitem').map((li) => li.textContent)).toEqual([`${loginTs}:1-2`, 'src/auth/session.ts:2', `${loginTs}:1`]);

    fireEvent.click(composer().getByRole('button', { name: `Remove comment on ${loginTs}:1` }));
    expect(within(chips()!).getAllByRole('listitem')).toHaveLength(2);

    fireEvent.change(composer().getByRole('textbox', { name: 'Prompt' }), { target: { value: 'A few things:' } });
    fireEvent.click(composer().getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(chips()).toBeNull());
    expect(main.invoked.filter((c) => c.command === 'sessions.send').map((c) => c.params)).toEqual([
      {
        id: 7,
        prompt: 'A few things:',
        comments: [
          { path: loginTs, start: 1, end: 2, lines: [' context', '-old line', '+new line'], note: 'Keep the old name.' },
          { path: 'src/auth/session.ts', start: 2, end: 2, lines: ['-old line'], note: 'Why drop this?' },
        ],
      },
    ]);
  });

  it('quotes a range drawn from the bottom up, or across the old and new sides, in the order the diff has them', async () => {
    const main = await open();
    await comment({ start: 2, side: 'additions', end: 1, endSide: 'additions' }, 'Up.');
    await comment({ start: 2, side: 'deletions', end: 2, endSide: 'additions' }, 'Across.');
    fireEvent.click(composer().getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(chips()).toBeNull());
    const [sent] = main.invoked.filter((c) => c.command === 'sessions.send');
    expect((sent!.params as { comments: unknown }).comments).toEqual([
      { path: loginTs, start: 1, end: 2, lines: [' context', '-old line', '+new line'], note: 'Up.' },
      { path: loginTs, start: 2, end: 2, lines: ['-old line', '+new line'], note: 'Across.' },
    ]);
  });

  it("numbers a range on the new side when it holds any new line, on the old side only when it's all removed lines", async () => {
    // Old and new numbers have drifted apart: line 50 of the old file is where line 45 of the new one is.
    const patch = `diff --git a/${loginTs} b/${loginTs}\n--- a/${loginTs}\n+++ b/${loginTs}\n@@ -50,3 +45,3 @@\n-gone\n-also gone\n+here\n context\n`;
    await open(
      new FakeMain(
        { projects: [project], sessions: [session], settings: DEFAULT_SETTINGS },
        { 'sessions.diff': () => ({ ...summary, files: [files[0]!] }), 'sessions.diffFile': () => ({ text: patch, truncated: false }) },
      ),
    );
    const plus = (range: SelectedLineRange) => act(() => drawn.get(patch)!.options.onGutterUtilityClick!(range));
    const add = async (range: SelectedLineRange, label: string) => {
      plus(range);
      fireEvent.change(await within(panel()).findByRole('textbox', { name: `Comment on ${label}` }), { target: { value: label } });
      fireEvent.click(within(panel()).getByRole('button', { name: 'Add comment' }));
    };
    await add({ start: 50, side: 'deletions', end: 46, endSide: 'additions' }, `${loginTs}:45-46`);
    await add({ start: 50, side: 'deletions', end: 51, endSide: 'deletions' }, `${loginTs}:50-51`);
    expect(within(chips()!).getAllByRole('listitem').map((li) => li.textContent)).toEqual([`${loginTs}:45-46`, `${loginTs}:50-51`]);
  });

  it('keeps a note being written when a turn end reloads the diff with the same lines', async () => {
    const main = await open();
    pressPlus({ start: 2, side: 'additions', end: 2, endSide: 'additions' });
    fireEvent.change(await within(panel()).findByRole('textbox', { name: `Comment on ${loginTs}:2` }), { target: { value: 'Half' } });
    const loads = diffCalls(main, 'sessions.diffFile').length;
    act(() => main.publish('sessions', [{ ...session, status: 'working' }]));
    act(() => main.publish('sessions', [{ ...session, status: 'waiting', updatedAt: 5 }]));
    await waitFor(() => expect(diffCalls(main, 'sessions.diffFile').length).toBeGreaterThan(loads));
    expect((within(panel()).getByRole('textbox', { name: `Comment on ${loginTs}:2` }) as HTMLTextAreaElement).value).toBe('Half');
  });

  it('keeps the chips when the send fails', async () => {
    await open(
      new FakeMain(
        { projects: [project], sessions: [session], settings: DEFAULT_SETTINGS },
        {
          'sessions.diff': () => summary,
          'sessions.diffFile': ({ path }) => ({ text: text(path), truncated: false }),
          'sessions.send': () => {
            throw new Error('Answer the question first.');
          },
        },
      ),
    );
    await comment({ start: 1, side: 'additions', end: 1, endSide: 'additions' }, 'Typo?');
    fireEvent.click(composer().getByRole('button', { name: 'Send' }));
    await screen.findByText('Answer the question first.');
    expect(within(chips()!).getAllByRole('listitem')).toHaveLength(1);
  });

  it('is not offered on an archived Session', async () => {
    const archived = { ...session, status: 'archived' as const };
    renderOpen(fakeMain({ ...summary, readOnly: true, files: [files[0]!] }, archived), archived);
    showChanges();
    const diff = await within(await within(panel()).findByRole('region', { name: loginTs })).findByTestId('patch-diff');
    const options = JSON.parse(diff.dataset.options!);
    expect(options.enableGutterUtility).toBeFalsy();
    expect(options.enableLineSelection).toBeFalsy();
    expect(drawn.get(text(loginTs))!.options.onGutterUtilityClick).toBeUndefined();
  });
});
