import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type DiffFile, type DiffSummary, type Project, type Session } from '../../src/shared/api';
import { FakeMain } from './fake-main';

// The library draws in a shadow DOM and highlights asynchronously; these tests
// stop at the data Loom hands it.
vi.mock('@pierre/diffs/react', () => ({
  PatchDiff: ({ patch, options }: { patch: string; options: unknown }) => (
    <pre data-testid="patch-diff" data-options={JSON.stringify(options)}>
      {patch}
    </pre>
  ),
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

/** Opens the sidebar's Changes view, as `d` does. */
const showChanges = () => fireEvent.keyDown(document.body, { key: 'd' });
const hideChanges = showChanges;

function fakeMain(result: DiffSummary = summary, s: Session = session, settings = DEFAULT_SETTINGS) {
  return new FakeMain(
    { projects: [project], sessions: [s], settings },
    {
      'sessions.diff': ({ uncommittedOnly }) => (uncommittedOnly && result.available ? { ...result, files: result.files.filter((f) => f.status !== 'committed') } : result),
      'sessions.diffFile': ({ path }) => ({ text: text(path), truncated: false }),
    },
  );
}

const panel = () => screen.getByRole('tabpanel', { name: 'Changes' });
const diffCalls = (main: FakeMain, command: string) => main.invoked.filter((c) => c.command === command);

describe('the Changes view', () => {
  it('works out the diff only once the Changes view is first shown', () => {
    const main = renderOpen(fakeMain());
    expect(screen.queryByRole('tabpanel', { name: 'Changes' })).toBeNull();
    expect(diffCalls(main, 'sessions.diff')).toHaveLength(0);
    fireEvent.keyDown(document.body, { key: 'i', ctrlKey: true });
    expect(diffCalls(main, 'sessions.diff')).toHaveLength(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(panel()).toBeTruthy();
    expect(diffCalls(main, 'sessions.diff')).toHaveLength(1);
  });

  it('shows a file tree and per-file sections, large, binary and lockfiles collapsed, loading a diff on expand', async () => {
    const main = renderOpen(fakeMain());
    showChanges();
    fireEvent.click(await within(panel()).findByRole('button', { name: 'File list' }));
    const tree = within(panel()).getByRole('navigation', { name: 'Changed files' });
    expect(within(tree).getByRole('button', { name: 'src' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(tree).getByRole('button', { name: /login\.ts.*committed/ })).toBeTruthy();
    expect(within(tree).getByRole('button', { name: /session\.ts.*modified/ })).toBeTruthy();
    expect(within(tree).getByRole('button', { name: /logo\.png.*untracked/ })).toBeTruthy();
    fireEvent.click(within(tree).getByRole('button', { name: 'src' }));
    expect(within(tree).queryByRole('button', { name: /login\.ts/ })).toBeNull();

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

  it('toggles to uncommitted changes only, and refreshes', async () => {
    const main = renderOpen(fakeMain());
    showChanges();
    const only = await within(panel()).findByRole('button', { name: 'Uncommitted only' });
    fireEvent.click(only);
    await waitFor(() => expect(within(panel()).queryByRole('region', { name: 'src/auth/login.ts' })).toBeNull());
    expect(only.getAttribute('aria-pressed')).toBe('true');
    expect(diffCalls(main, 'sessions.diff').at(-1)?.params).toEqual({ id: 7, uncommittedOnly: true });

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
    expect(within(panel()).queryByRole('button', { name: 'Uncommitted only' })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: /in the editor/ })).toBeNull();
    cleanup();

    renderPanel(fakeMain({ available: false, reason: 'No diff available' }, archived));
    expect(await within(panel()).findByText('No diff available')).toBeTruthy();
  });

  it('shows why the diff could not be worked out', async () => {
    const main = new FakeMain(
      { projects: [project], sessions: [session], settings: DEFAULT_SETTINGS },
      {
        'sessions.diff': () => {
          throw new Error("There's no local origin/main to compare with; fetch origin to see this diff.");
        },
      },
    );
    renderOpen(main);
    showChanges();
    expect((await within(panel()).findByRole('alert')).textContent).toMatch(/no local origin\/main/);
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
  const click = (name: string) => fireEvent.click(within(panel()).getByRole('button', { name }));
  const openPanel = async () => {
    showChanges();
    await within(panel()).findAllByTestId('patch-diff');
  };

  it('opens as the settings say', async () => {
    renderOpen(fakeMain(summary, session, { ...DEFAULT_SETTINGS, diffView: { fileList: true, wrap: true, sideBySide: true } }));
    await openPanel();
    expect(within(panel()).getByRole('navigation', { name: 'Changed files' })).toBeTruthy();
    expect(pressed('File list')).toBe('true');
    for (const diff of within(panel()).getAllByTestId('patch-diff')) expect(JSON.parse(diff.dataset.options!)).toMatchObject({ overflow: 'wrap', diffStyle: 'split' });
  });

  it('saves each click, whole', async () => {
    const main = renderOpen(fakeMain());
    await openPanel();
    click('Wrap long lines');
    click('File list');
    const saved = main.invoked.filter((c) => c.command === 'settings.setDiffView').map((c) => c.params);
    expect(saved).toEqual([
      { fileList: false, wrap: true, sideBySide: false },
      { fileList: true, wrap: true, sideBySide: false },
    ]);
  });

  it('is as the user left it after closing and reopening the panel', async () => {
    renderOpen(fakeMain());
    await openPanel();
    click('File list');
    click('Wrap long lines');
    click('Side by side');
    hideChanges();
    expect(screen.queryByRole('tabpanel', { name: 'Changes' })).toBeNull();

    await openPanel();
    for (const name of ['File list', 'Wrap long lines', 'Side by side']) expect(pressed(name)).toBe('true');
    expect(within(panel()).getByRole('navigation', { name: 'Changed files' })).toBeTruthy();
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
  it('starts hidden, leaving the search and the diffs, and the toggle shows and hides it', async () => {
    renderOpen(fakeMain());
    showChanges();
    const toggle = await within(panel()).findByRole('button', { name: 'File list' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(within(panel()).queryByRole('navigation', { name: 'Changed files' })).toBeNull();
    expect(within(panel()).getByRole('searchbox', { name: 'Filter changed files' })).toBeTruthy();
    expect(within(panel()).getByRole('region', { name: 'src/auth/login.ts' })).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(within(panel()).getByRole('navigation', { name: 'Changed files' })).toBeTruthy();

    fireEvent.click(toggle);
    expect(within(panel()).queryByRole('navigation', { name: 'Changed files' })).toBeNull();
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
    fireEvent.click(await within(panel()).findByRole('button', { name: 'File list' }));
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

  it('narrows the diffs with the file list hidden too', async () => {
    await open();
    fireEvent.click(within(panel()).getByRole('button', { name: 'File list' }));
    type('login');
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

  it('keeps the filter and the file list when switching to uncommitted changes only', async () => {
    await open();
    type('session');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Uncommitted only' }));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Uncommitted only' }).getAttribute('aria-pressed')).toBe('true'));
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
  it("shows what the diff is against, says when it is only origin's default, and sets another, refreshing the diff", async () => {
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
    expect(within(panel).getByText(/origin's default branch: where this branch started isn't known/)).toBeTruthy();
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('option', { name: 'origin/release/1.2' }));

    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Compared with' }).textContent).toBe('origin/release/1.2'));
    expect(main.invoked.filter((i) => i.command === 'sessions.setDiffBase')).toEqual([{ command: 'sessions.setDiffBase', params: { id: 7, base: 'origin/release/1.2' } }]);
    expect(within(panel).queryByText(/isn't known/)).toBeNull();
  });

  it('has no base control on an archived read-only diff, nor for uncommitted changes only', async () => {
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
    fireEvent.click(within(live).getByRole('button', { name: 'Uncommitted only' }));
    await waitFor(() => expect(within(live).queryByRole('button', { name: 'Compared with' })).toBeNull());
  });
});
