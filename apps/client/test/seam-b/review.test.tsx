import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SelectedLineRange } from '@pierre/diffs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS, type DiffSummary, type Project, type Session } from '../../src/shared/api';
import { DEFAULT_SESSION_PANELS, type SessionPanels } from '../../src/shared/panels';
import { FakeMain, HIDDEN_PANELS } from './fake-main';

type DiffProps = { patch: string; options: { onGutterUtilityClick?: (range: SelectedLineRange) => void } };
const drawn = vi.hoisted(() => new Map<string, DiffProps>());

// Review mode moves Changes, not the diffs it draws: they stop at the patch.
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
  diffStat: { files: 1, added: 1, removed: 1 },
};
const other: Session = { ...session, id: 8, title: 'Fix billing' };
const loginTs = 'src/auth/login.ts';
const summary: DiffSummary = {
  available: true,
  readOnly: false,
  base: 'origin/main',
  files: [{ path: loginTs, status: 'modified', added: 1, removed: 1, binary: false }],
  counts: { all: 1, committed: 0, uncommitted: 1 },
};
const patch = `diff --git a/${loginTs} b/${loginTs}\n--- a/${loginTs}\n+++ b/${loginTs}\n@@ -1,2 +1,2 @@\n context\n-old line\n+new line\n`;

function renderApp({ panels = DEFAULT_SESSION_PANELS }: { panels?: SessionPanels } = {}) {
  const main = new FakeMain(
    { projects: [project], sessions: [session, other], settings: DEFAULT_SETTINGS },
    { 'sessions.diff': () => summary, 'sessions.diffFile': () => ({ text: patch, truncated: false }) },
  );
  main.publish('panels', panels, { sessionId: session.id });
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  return main;
}

const sideArea = () => screen.queryByRole('complementary', { name: 'Side area' });
const review = () => screen.queryByRole('region', { name: 'Review mode' });
const header = () => screen.getByRole('region', { name: 'Session header' });
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...init });
const reviewShortcut = () => press('D', { ctrlKey: true, shiftKey: true });
const kept = (main: FakeMain) => main.invoked.filter((c) => c.command === 'sessions.setPanels');
const enter = () => fireEvent.click(within(sideArea()!).getByRole('button', { name: 'Review Changes' }));

describe('Review mode', () => {
  it('gives Changes the main area from its ⤢: the conversation and its composer stay beside it, the Side area hidden', async () => {
    const main = renderApp();
    await within(sideArea()!).findByRole('region', { name: loginTs });
    enter();

    expect(sideArea()).toBeNull();
    const surface = review()!;
    expect(within(surface).getByText('in Review mode')).toBeTruthy();
    expect(within(surface).getByRole('toolbar', { name: 'Changes' })).toBeTruthy();
    expect(within(surface).getByRole('region', { name: loginTs })).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Composer' })).toBeTruthy();
    expect(surface.closest('.session-body')!.classList.contains('reviewing')).toBe(true);
    expect(within(header()).getByRole('button', { name: 'Show the Side area' })).toBeTruthy();
    // The focus, lost with the button, goes to the one that leaves.
    expect(document.activeElement).toBe(within(surface).getByRole('button', { name: 'Leave Review mode' }));
    // Not the Session's Panels: nothing is kept.
    expect(kept(main)).toEqual([]);
  });

  it('leaves on Esc, or its ⤡, bringing the Side area back as it was', async () => {
    const panels: SessionPanels = { ...DEFAULT_SESSION_PANELS, side: { panels: ['changes'], shown: 'changes', open: true } };
    const main = renderApp({ panels });
    enter();
    press('Escape');
    expect(review()).toBeNull();
    expect(within(sideArea()!).getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(within(sideArea()!).getByRole('button', { name: 'Review Changes' }));

    enter();
    fireEvent.click(within(review()!).getByRole('button', { name: 'Leave Review mode' }));
    expect(review()).toBeNull();
    expect(sideArea()).toBeTruthy();
    expect(kept(main)).toEqual([]);
  });

  it('keeps Changes as it was going in and out, without working the diff out again', async () => {
    const main = renderApp();
    await within(sideArea()!).findByRole('region', { name: loginTs });
    fireEvent.click(within(sideArea()!).getByRole('radio', { name: /^Uncommitted/ }));
    await waitFor(() => expect(main.invoked.filter((c) => c.command === 'sessions.diff').at(-1)!.params).toMatchObject({ scope: 'uncommitted' }));
    const loads = main.invoked.filter((c) => c.command === 'sessions.diff' || c.command === 'sessions.diffFile').length;

    enter();
    expect(within(review()!).getByRole('radio', { name: /^Uncommitted/ }).getAttribute('aria-checked')).toBe('true');
    press('Escape');
    expect(within(sideArea()!).getByRole('radio', { name: /^Uncommitted/ }).getAttribute('aria-checked')).toBe('true');
    expect(main.invoked.filter((c) => c.command === 'sessions.diff' || c.command === 'sessions.diffFile')).toHaveLength(loads);
  });

  it('toggles with Ctrl+Shift+D, even with the Side area hidden, which stays hidden after', async () => {
    const main = renderApp({ panels: HIDDEN_PANELS });
    expect(sideArea()).toBeNull();
    reviewShortcut();
    expect(await within(review()!).findByRole('region', { name: loginTs })).toBeTruthy();
    reviewShortcut();
    expect(review()).toBeNull();
    expect(sideArea()).toBeNull();
    // The focus, lost with the surface, goes to the composer.
    expect(document.activeElement).toBe(within(screen.getByRole('form', { name: 'Composer' })).getByRole('textbox', { name: 'Prompt' }));
    expect(kept(main)).toEqual([]);
  });

  it("isn't offered for Changes sitting in the Dock, which stays there", () => {
    renderApp({ panels: { side: { panels: [], shown: null, open: false }, dock: { panels: ['changes'], shown: 'changes', open: true } } });
    const dock = screen.getByRole('region', { name: 'Dock' });
    expect(within(dock).getByRole('tab', { name: 'Changes' })).toBeTruthy();
    expect(within(dock).queryByRole('button', { name: 'Review Changes' })).toBeNull();
    reviewShortcut();
    expect(review()).toBeNull();
  });

  it('is left for the Side area by Ctrl+B or the header icon, and by d, Changes going back to it', () => {
    renderApp({ panels: HIDDEN_PANELS });
    reviewShortcut();
    press('b', { ctrlKey: true });
    expect(review()).toBeNull();
    expect(within(sideArea()!).getByRole('tab', { name: 'Changes' })).toBeTruthy();

    enter();
    fireEvent.click(within(header()).getByRole('button', { name: 'Show the Side area' }));
    expect(review()).toBeNull();
    expect(sideArea()).toBeTruthy();

    enter();
    press('d');
    expect(review()).toBeNull();
    expect(within(sideArea()!).getByRole('tab', { name: 'Changes' })).toBeTruthy();
  });

  it('stays on while showing Changes from the Glance strip', () => {
    renderApp();
    enter();
    fireEvent.click(screen.getByRole('button', { name: /^Show changes/ }));
    expect(review()).toBeTruthy();
    expect(sideArea()).toBeNull();
  });

  it('leaves Esc to a comment being written, or to a menu over it', async () => {
    renderApp();
    await within(sideArea()!).findByRole('region', { name: loginTs });
    enter();
    act(() => drawn.get(patch)!.options.onGutterUtilityClick!({ start: 2, side: 'additions', end: 2, endSide: 'additions' }));
    const note = await within(review()!).findByRole('textbox', { name: `Comment on ${loginTs}:2` });
    fireEvent.keyDown(note, { key: 'Escape' });
    expect(within(review()!).queryByRole('textbox', { name: /^Comment on/ })).toBeNull();
    expect(review()).toBeTruthy();

    press('k', { ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Command palette' }), { key: 'Escape' });
    expect(review()).toBeTruthy();
  });

  it('sends the comments written in it with the next message, from the composer beside it', async () => {
    const main = renderApp();
    await within(sideArea()!).findByRole('region', { name: loginTs });
    enter();
    act(() => drawn.get(patch)!.options.onGutterUtilityClick!({ start: 2, side: 'additions', end: 2, endSide: 'additions' }));
    fireEvent.change(await within(review()!).findByRole('textbox', { name: `Comment on ${loginTs}:2` }), { target: { value: 'Rename it.' } });
    fireEvent.click(within(review()!).getByRole('button', { name: 'Add comment' }));
    expect(within(review()!).getByRole('note', { name: `Your comment on ${loginTs}:2` })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('form', { name: 'Composer' })).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(main.invoked.some((c) => c.command === 'sessions.send')).toBe(true));
    expect(review()).toBeTruthy();
  });

  it('takes the main area in a narrow window too, rather than the drawer, which stays closed after', () => {
    renderApp();
    act(() => {
      window.innerWidth = 900;
      window.dispatchEvent(new Event('resize'));
    });
    try {
      expect(sideArea()).toBeNull();
      reviewShortcut();
      expect(review()!.classList.contains('drawer')).toBe(false);
      expect(document.querySelector('.drawer-scrim')).toBeNull();
      press('Escape');
      expect(review()).toBeNull();
      expect(sideArea()).toBeNull();
    } finally {
      act(() => {
        window.innerWidth = 1440;
        window.dispatchEvent(new Event('resize'));
      });
    }
  });

  it("isn't kept when another Session is opened", () => {
    renderApp();
    enter();
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: other.title }));
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
    expect(review()).toBeNull();
    expect(sideArea()).toBeTruthy();
  });

  it('is in the palette while a Session is open, and in the shortcut list', () => {
    renderApp();
    press('k', { ctrlKey: true });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole('option', { name: 'Toggle Review mode for Changes' }));
    expect(review()).toBeTruthy();
    press('?', { ctrlKey: true });
    expect(within(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).getByRole('row', { name: /^Toggle Review mode for Changes Ctrl Shift D$/ })).toBeTruthy();
  });
});
