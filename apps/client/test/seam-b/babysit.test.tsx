import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { DiffSummary, Project, Session, TranscriptItem } from '../../src/shared/api';
import { Dates, ownLocale } from '../../src/shared/dates';
import { settingsPage } from './settings-page';
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
const url = 'https://github.com/acme/loom/pull/12';

function session(fields: Partial<Session> = {}): Session {
  return { id: 1, projectId: 1, title: 'Fix login', workingCopy: { kind: 'worktree', path: '/w' }, agent: 'OpenCode', status: 'waiting', waitingReason: 'feedback', branch: 'loom/fix', mergeRequest: { number: 12, url }, mergeRequestState: 'open', unread: false, createdAt: 1, updatedAt: 1, ...fields };
}

function open(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));
  return screen.getByRole('log', { name: 'Conversation' });
}

const feedback: Extract<TranscriptItem, { kind: 'feedback' }> = {
  kind: 'feedback',
  id: 0,
  number: 12,
  url,
  state: 'new',
  ci: 'failed',
  items: [
    { kind: 'review', author: 'alice', verdict: 'changes-requested', excerpt: 'Needs work', url: `${url}#r1`, comments: [{ path: 'src/a.ts', line: 10, excerpt: 'Off by one', url: `${url}#r1a` }] },
    { kind: 'comment', author: 'bob', excerpt: 'Add a test', url: `${url}#c2` },
    { kind: 'ci-failed', checks: [{ name: 'unit', url: 'https://ci/1' }] },
    { kind: 'conflicts' },
  ],
};

const calls = (main: FakeMain, command: string) => main.invoked.filter((i) => i.command === command).map((i) => i.params);

describe('the feedback card', () => {
  it('lists each item on one line, sends them to the agent and opens the Merge request', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    main.publish('transcript', [feedback], { sessionId: 1 });
    const card = within(open(main)).getByRole('group', { name: 'Feedback on Merge request #12' });

    expect(card.querySelector('.tool-head')?.textContent).toBe('babysitNew feedback on Merge request #12');
    expect(within(card).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'alice requested changes: 1 comment on src/a.ts:10',
      'bob commented: Add a test',
      'CI failed: unit',
      'Conflicts with its target branch',
    ]);

    fireEvent.click(within(card).getByRole('button', { name: 'unit' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url: 'https://ci/1' }]));
    fireEvent.click(within(card).getByRole('button', { name: 'Send to agent' }));
    await waitFor(() => expect(calls(main, 'sessions.sendFeedback')).toEqual([{ id: 1, itemId: 0 }]));
    fireEvent.click(within(card).getByRole('button', { name: 'Open on Forge' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url: 'https://ci/1' }, { url }]));
  });

  it('takes a comment on the code to its file in Changes', async () => {
    const scrolled: Element[] = [];
    // jsdom has no scrolling: what is scrolled to is recorded instead.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const summary: DiffSummary = { available: true, readOnly: false, base: 'origin/main', files: [{ path: 'src/a.ts', status: 'committed', added: 1, removed: 0, binary: false }] };
      const main = new FakeMain({ projects: [project], sessions: [session()] }, { 'sessions.diff': () => summary });
      main.publish('transcript', [feedback], { sessionId: 1 });
      const card = within(open(main)).getByRole('group', { name: 'Feedback on Merge request #12' });

      fireEvent.click(within(card).getByRole('button', { name: 'src/a.ts:10' }));
      expect(screen.getByRole('tab', { name: /Changes/ }).getAttribute('aria-selected')).toBe('true');
      await waitFor(() => expect(scrolled.some((el) => el.id.includes(encodeURIComponent('src/a.ts')))).toBe(true));
      expect(calls(main, 'links.open')).toEqual([]);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it('says it was sent once it has been, with nothing left to send', () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    main.publish('transcript', [{ ...feedback, state: 'sent' }], { sessionId: 1 });
    const card = within(open(main)).getByRole('group', { name: 'Feedback on Merge request #12' });

    expect(card.textContent).toContain('Sent to the agent');
    expect(within(card).queryByRole('button', { name: 'Send to agent' })).toBeNull();
  });

  it('says when auto-prompt has paused, and can still be sent by hand', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session({ autoPrompt: true })] });
    main.publish('transcript', [{ ...feedback, paused: true }], { sessionId: 1 });
    const card = within(open(main)).getByRole('group', { name: 'Feedback on Merge request #12' });

    expect(card.textContent).toContain('paused after 3 attempts');
    fireEvent.click(within(card).getByRole('button', { name: 'Send to agent' }));
    await waitFor(() => expect(calls(main, 'sessions.sendFeedback')).toEqual([{ id: 1, itemId: 0 }]));
  });

  it('has nothing to send once the Session is archived, but still opens on the Forge', () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    main.publish('transcript', [feedback], { sessionId: 1 });
    const card = within(open(main)).getByRole('group', { name: 'Feedback on Merge request #12' });
    expect(within(card).queryByRole('button', { name: 'Send to agent' })).not.toBeNull();

    act(() => main.publish('sessions', [session({ status: 'archived', waitingReason: undefined })]));
    const archived = within(screen.getByRole('log', { name: 'Conversation' })).getByRole('group', { name: 'Feedback on Merge request #12' });
    expect(within(archived).queryByRole('button', { name: 'Send to agent' })).toBeNull();
    expect(within(archived).getByRole('button', { name: 'Open on Forge' })).toBeTruthy();
  });
});

describe('info cards', () => {
  it('shows an approval and a green CI quietly', () => {
    const main = new FakeMain({ projects: [project], sessions: [session({ waitingReason: 'finished' })] });
    main.publish('transcript', [{ kind: 'feedback-info', id: 0, event: 'approved', author: 'alice', url }, { kind: 'feedback-info', id: 1, event: 'ci-passed', url }], { sessionId: 1 });
    const notes = within(open(main)).getAllByRole('note').map((n) => n.textContent);

    expect(notes).toEqual(expect.arrayContaining([expect.stringContaining('alice approved'), expect.stringContaining('CI passed')]));
  });
});

describe("the Glance strip's Merge request", () => {
  const glance = () => screen.getByRole('group', { name: 'Session at a glance' });
  const ciButton = (name: string) => within(glance()).getByRole('button', { name });
  /** The Merge request Panel, shown from its chip if it isn't shown. */
  const panel = () => {
    if (!screen.queryByRole('tabpanel', { name: 'Merge request' })) fireEvent.click(within(glance()).getByRole('button', { name: 'Merge request #12' }));
    return screen.getByRole('tabpanel', { name: 'Merge request' });
  };
  const watch = () => within(panel()).queryByRole('switch', { name: 'Babysit' }) as HTMLButtonElement | null;
  const autoPrompt = () => within(panel()).queryByRole('switch', { name: 'Auto-prompt' }) as HTMLButtonElement | null;

  it('shows how CI is going beside the number, its checks saying when they were last polled', () => {
    const at = new Date(2026, 10, 10, 14, 32).getTime();
    open(new FakeMain({ projects: [project], sessions: [session({ babysit: { ci: 'pending', lastPollAt: at, stale: false } })] }));

    expect(ciButton('CI running').textContent).toBe('CI running');
    // In the runner's regional format, which the fake main reports.
    const checked = `Checked ${new Dates(ownLocale()).time(at)}`;
    expect(glance().textContent).not.toContain('Checked');
    fireEvent.click(ciButton('CI running'));
    expect(screen.getByRole('dialog', { name: 'CI checks' }).textContent).toContain(checked);
    expect(glance().textContent).not.toContain('Stale');
  });

  it('says when it may be out of date, after a failed poll', () => {
    open(new FakeMain({ projects: [project], sessions: [session({ babysit: { ci: 'passed', lastPollAt: 1, stale: true } })] }));

    expect(ciButton('CI passed').title).toBe('CI passed (may be out of date)');
    expect(within(panel()).getByText('Stale').getAttribute('title')).toBe("Loom couldn't reach the Forge on its last check: this may be out of date.");
  });

  const checks: NonNullable<NonNullable<Session['babysit']>['checks']> = [
    { name: 'unit', state: 'failed', url: 'https://ci/1' },
    { name: 'lint', state: 'passed', url: 'https://ci/2' },
    { name: 'e2e', state: 'pending' },
    { name: 'old', state: 'not-run' },
  ];
  const iconOf = (element: Element) => [...element.querySelector('svg')!.classList].find((c) => c.startsWith('lucide-'));

  it.each([
    ['passed', 'CI passed', 'lucide-circle-check', 'tone-passed'],
    ['failed', 'CI failed', 'lucide-circle-x', 'tone-failed'],
    ['pending', 'CI running', 'lucide-clock', 'tone-pending'],
  ] as const)('labels CI %s, in its colour', (ci, name, icon, tone) => {
    open(new FakeMain({ projects: [project], sessions: [session({ babysit: { ci, stale: false } })] }));

    expect(iconOf(ciButton(name))).toBe(icon);
    expect(ciButton(name).querySelector(`.${tone}`)).not.toBeNull();
  });

  it("shows a merged or closed one's state in place of its CI", () => {
    const main = new FakeMain({ projects: [project], sessions: [session({ mergeRequestState: 'merged', babysit: { ci: 'passed', stale: false } })] });
    open(main);
    const number = within(glance()).getByRole('button', { name: 'Merge request #12' });
    expect(number.textContent).toBe('#12Merged');
    expect(iconOf(number)).toBe('lucide-git-merge');
    expect(within(glance()).queryByRole('button', { name: 'CI passed' })).toBeNull();

    act(() => main.publish('sessions', [session({ mergeRequestState: 'closed' })]));
    expect(within(glance()).getByRole('button', { name: 'Merge request #12' }).textContent).toBe('#12Closed');
  });

  it('lists the checks in a popover, each opening its details', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session({ babysit: { ci: 'failed', checks, stale: false } })] });
    open(main);
    expect(screen.queryByRole('dialog', { name: 'CI checks' })).toBeNull();

    fireEvent.click(ciButton('CI failed'));
    const list = screen.getByRole('dialog', { name: 'CI checks' });
    expect(list.textContent).toContain('Some checks failed');
    expect(list.textContent).toContain('1 failed, 1 passed, 1 pending, 1 not run');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['unitFailedDetails', 'lintPassedDetails', 'e2ePending', 'oldNot run']);

    fireEvent.click(within(within(list).getAllByRole('listitem')[1]!).getByRole('button', { name: 'Details' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url: 'https://ci/2' }]));

    fireEvent.click(ciButton('CI failed'));
    expect(screen.queryByRole('dialog', { name: 'CI checks' })).toBeNull();
  });

  it.each([
    [{ ci: 'passed', checks: [{ name: 'lint', state: 'passed' }], stale: false }, 'CI passed', 'All checks have passed'],
    [{ ci: 'pending', checks: [{ name: 'lint', state: 'pending' }], stale: false }, 'CI running', 'Checks are running'],
    [{ checks: [{ name: 'old', state: 'not-run' }], stale: false }, 'Checks', 'No CI checks'],
  ] as const)('heads the checks for what CI is doing', (babysit, name, heading) => {
    open(new FakeMain({ projects: [project], sessions: [session({ babysit: babysit as never })] }));
    fireEvent.click(ciButton(name));

    expect(screen.getByRole('dialog', { name: 'CI checks' }).textContent).toContain(heading);
  });

  it('shows no CI before Babysit has seen any', () => {
    open(new FakeMain({ projects: [project], sessions: [session()] }));
    expect(within(glance()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).not.toContain('Checks');
    expect(glance().textContent).not.toContain('CI');
  });

  it('switches the watch with a labelled Babysit switch, saying what it means', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    open(main);
    expect(watch()!.getAttribute('aria-checked')).toBe('true');
    expect(watch()!.getAttribute('aria-description')).toBe('New reviews, failed checks and conflicts put the Session in the Inbox.');
    // Labelled: what it means shows under its name.
    expect(watch()!.textContent).toBe('BabysitNew reviews, failed checks and conflicts put the Session in the Inbox.');
    fireEvent.click(watch()!);
    await waitFor(() => expect(calls(main, 'sessions.setBabysitting')).toEqual([{ id: 1, on: false }]));

    act(() => main.publish('sessions', [session({ babysitOff: true })]));
    expect(watch()!.getAttribute('aria-checked')).toBe('false');
    expect(watch()!.getAttribute('aria-description')).toBe('Babysit is off for #12.');
    fireEvent.click(watch()!);
    await waitFor(() => expect(calls(main, 'sessions.setBabysitting')).toEqual([{ id: 1, on: false }, { id: 1, on: true }]));
  });

  it('has no Babysit switch for what cannot be watched', () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    open(main);
    expect(watch()).not.toBeNull();

    act(() => main.publish('sessions', [session({ mergeRequestState: 'merged' })]));
    expect(watch()).toBeNull();
    act(() => main.publish('sessions', [session({ status: 'archived', waitingReason: undefined })]));
    expect(watch()).toBeNull();
  });

  it('greys out Auto-prompt while the Merge request is not watched', () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    open(main);
    expect(autoPrompt()!.disabled).toBe(false);

    act(() => main.publish('sessions', [session({ babysitOff: true })]));
    expect(autoPrompt()!.disabled).toBe(true);
    expect(autoPrompt()!.getAttribute('aria-description')).toBe('Auto-prompt needs Babysit on.');
  });

  it('turns Auto-prompt on and off for the Session, showing what it is', async () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    open(main);
    expect(autoPrompt()!.getAttribute('aria-checked')).toBe('false');
    expect(autoPrompt()!.getAttribute('aria-description')).toBe('New feedback waits for you.');

    fireEvent.click(autoPrompt()!);
    await waitFor(() => expect(calls(main, 'sessions.setAutoPrompt')).toEqual([{ id: 1, on: true }]));

    act(() => main.publish('sessions', [session({ autoPrompt: true })]));
    expect(autoPrompt()!.getAttribute('aria-checked')).toBe('true');
    expect(autoPrompt()!.getAttribute('aria-description')).toBe('New feedback goes straight to the agent, up to 3 times in a row.');
    fireEvent.click(autoPrompt()!);
    await waitFor(() => expect(calls(main, 'sessions.setAutoPrompt')).toEqual([{ id: 1, on: true }, { id: 1, on: false }]));
  });

  it('has no Auto-prompt switch on an archived Session', () => {
    const main = new FakeMain({ projects: [project], sessions: [session()] });
    open(main);
    expect(autoPrompt()).not.toBeNull();

    act(() => main.publish('sessions', [session({ status: 'archived', waitingReason: undefined })]));
    expect(autoPrompt()).toBeNull();
  });
});

describe('the auto-prompt default in Settings', () => {
  it('is off to begin with, and saves a change', async () => {
    const main = new FakeMain({ projects: [project] });
    render(
      <ApiProvider api={main}>
        <App />
      </ApiProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    settingsPage('Sessions');
    const box = screen.getByRole('checkbox', { name: 'Auto-prompt new Sessions' }) as HTMLInputElement;
    expect(box.checked).toBe(false);

    fireEvent.click(box);
    await waitFor(() => expect(calls(main, 'settings.setAutoPromptDefault')).toEqual([{ on: true }]));
    await waitFor(() => expect(box.checked).toBe(true));
  });
});

describe('a Merge request merged or closed', () => {
  it('badges a Session held back by unsaved work in the Inbox, and says why in its conversation', () => {
    const main = new FakeMain({ projects: [project], sessions: [session({ waitingReason: 'unsaved-work', mergeRequestState: 'merged' })] });
    main.publish('transcript', [{ kind: 'merge-request-ended', id: 0, number: 12, url, state: 'merged', archived: false, unsavedWork: { uncommitted: true, unpushedCommits: 2, detached: false } }], { sessionId: 1 });
    render(
      <ApiProvider api={main}>
        <App />
      </ApiProvider>,
    );
    const row = screen.getByRole('listitem', { name: 'Fix login' });
    expect(within(row).getByRole('img', { name: 'Merged with unsaved work' })).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: 'Fix login' }));
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log.textContent).toContain("Merge request #12 was merged, but this Session's worktree has uncommitted changes and 2 unpushed commits, so Loom didn't archive it.");
    fireEvent.click(within(log).getByRole('button', { name: 'Open' }));
    expect(calls(main, 'links.open')).toEqual([{ url }]);
  });

  it('badges one closed without merging as closed', () => {
    const main = new FakeMain({ projects: [project], sessions: [session({ waitingReason: 'unsaved-work', mergeRequestState: 'closed' })] });
    render(
      <ApiProvider api={main}>
        <App />
      </ApiProvider>,
    );
    expect(within(screen.getByRole('listitem', { name: 'Fix login' })).getByRole('img', { name: 'Closed with unsaved work' })).toBeTruthy();
  });

  it('marks the Archived section and row of a Session archived as closed without merging, with a card saying so', () => {
    const main = new FakeMain({ projects: [project], sessions: [session({ status: 'archived', waitingReason: undefined, mergeRequestState: 'closed', unread: true })] });
    main.publish('transcript', [{ kind: 'merge-request-ended', id: 0, number: 12, url, state: 'closed', archived: true }], { sessionId: 1 });
    render(
      <ApiProvider api={main}>
        <App />
      </ApiProvider>,
    );
    const section = screen.getByRole('button', { name: 'Archived' });
    expect(within(section).getByRole('img', { name: 'Unread' })).toBeTruthy();
    fireEvent.click(section);
    const row = screen.getByRole('button', { name: 'Fix login' });
    expect(within(row).getByRole('img', { name: 'Unread' })).toBeTruthy();

    fireEvent.click(row);
    expect(screen.getByRole('log', { name: 'Conversation' }).textContent).toContain('Merge request #12 was closed without merging. Loom archived this Session.');
  });
});
