import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { MergeRequestDetails, Project, Session, TranscriptItem } from '../../src/shared/api';
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

const gitlab: Project = {
  id: 1,
  name: 'billing-api',
  color: 'blue',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'available', checking: false, kind: 'gitlab', repository: 'acme/billing-api' },
};
const url = 'https://gitlab.com/acme/billing-api/-/merge_requests/12';

function session(fields: Partial<Session> = {}): Session {
  return {
    id: 1,
    projectId: 1,
    title: 'Fix login',
    workingCopy: { kind: 'worktree', path: '/home/dev/loom/worktrees/fix-login' },
    agent: 'OpenCode',
    status: 'waiting',
    waitingReason: 'finished',
    branch: 'loom/fix-login',
    unread: false,
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  };
}

function open(main: FakeMain) {
  renderApp(main);
  fireEvent.click(screen.getByRole('button', { name: 'Fix login' }));
  return { header: screen.getByRole('region', { name: 'Session header' }), log: screen.getByRole('log', { name: 'Conversation' }) };
}

const glance = () => screen.getByRole('group', { name: 'Session at a glance' });

/** The Merge request Panel, shown from its chip in the Glance strip (named `chip`) if it isn't shown. */
function panel(chip?: string): HTMLElement {
  if (!screen.queryByRole('tabpanel', { name: 'Merge request' })) fireEvent.click(within(glance()).getByRole('button', { name: chip ?? /^Merge request [#!]\d+$/ }));
  return screen.getByRole('tabpanel', { name: 'Merge request' });
}

/** Merge request !12 as main reads it from GitLab. */
function details(fields: Partial<MergeRequestDetails> = {}): MergeRequestDetails {
  return {
    number: 12,
    url,
    title: 'Fix the login bug',
    state: 'open',
    draft: false,
    sourceBranch: 'loom/fix-login',
    targetBranch: 'main',
    head: 'abc123',
    author: 'dave',
    description: '',
    reviewers: [],
    commits: 3,
    files: 3,
    added: 67,
    removed: 1,
    ci: 'failed',
    checks: [
      { name: 'test', state: 'failed', url: 'https://ci/1' },
      { name: 'lint', state: 'passed' },
    ],
    reviews: [
      { author: 'frank', verdict: 'approved', body: '', url, comments: [] },
      { author: 'erin', verdict: 'changes-requested', body: 'Needs work', at: 1000, url: `${url}#note_1`, comments: [{ author: 'erin', body: 'Off by one', path: 'src/a.ts', line: 3, url: `${url}#note_3` }] },
    ],
    comments: [{ author: 'carol', body: '**Ship it**', at: 2000, url: `${url}#note_2` }],
    ...fields,
  };
}

const calls = (main: FakeMain, command: string) => main.invoked.filter((i) => i.command === command).map((i) => i.params);

describe("the Session's Merge request", () => {
  it('shows a timeline card "Merge request !12 opened · Open" that opens it', async () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url } })] });
    const items: TranscriptItem[] = [
      { kind: 'user', id: 0, text: 'Open the MR' },
      { kind: 'merge-request', id: 1, number: 12, url },
    ];
    main.publish('transcript', items, { sessionId: 1 });
    const { log } = open(main);

    const card = within(log).getByRole('note');
    expect(card.textContent).toBe('Merge request !12 opened·Open');
    fireEvent.click(within(card).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url }]));
  });

  it("shows why the agent's tool couldn't link one", () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session()] });
    main.publish('transcript', [{ kind: 'merge-request-refused', id: 0, mergeRequest: '41', reason: 'That Merge request is closed: only an open one can be linked.' }], { sessionId: 1 });
    const { log } = open(main);
    expect(within(log).getByRole('note').textContent).toBe("Couldn't link Merge request 41: That Merge request is closed: only an open one can be linked.");
  });

  it('shows in the Glance strip once linked, showing its Panel: opening it, asking the agent to update it, or linking another', async () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] }, { 'sessions.mergeRequest': () => details() });
    open(main);
    expect(within(glance()).getByRole('button', { name: 'Merge request !12' }).textContent).toBe('!12');
    const shown = panel();
    expect(within(shown).getByRole('heading', { level: 2 }).textContent).toBe('Merge request !12');
    expect(await within(shown).findByRole('heading', { name: 'Fix the login bug' })).toBeTruthy();
    expect(within(shown).queryByRole('button', { name: 'Create Merge request' })).toBeNull();

    fireEvent.click(within(shown).getByRole('button', { name: 'Open on GitLab' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url }]));
    fireEvent.click(within(shown).getByRole('button', { name: 'Link Merge request…' }));
    expect(within(shown).getByRole('form', { name: 'Link Merge request' })).toBeTruthy();
    fireEvent.click(within(shown).getByRole('button', { name: 'Update Merge request' }));
    await waitFor(() => expect(calls(main, 'sessions.requestMergeRequest')).toEqual([{ id: 1 }]));
  });

  it('shows its state, branches, title, author, commits and changes, its checks, and its reviews and comments', async () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] }, { 'sessions.mergeRequest': () => details() });
    open(main);
    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });
    expect(calls(main, 'sessions.mergeRequest')).toEqual([{ id: 1 }]);

    const head = shown.querySelector('.mr-head')!;
    expect(head.querySelector('.mr-meta')!.textContent).toBe('Open!12loom/fix-login→main');
    expect(head.querySelectorAll('.mr-meta')[1]!.textContent).toBe('by dave3 commits3 files+67−1');
    const checks = within(shown).getByRole('region', { name: /^Checks/ });
    expect(within(checks).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['testFailedDetails', 'lintPassed']);
    expect(checks.textContent).toContain('1 failed, 1 passed');
    fireEvent.click(within(checks).getByRole('button', { name: 'Details of test' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url: 'https://ci/1' }]));

    const reviews = within(shown).getByRole('region', { name: 'Reviews and comments' });
    const entries = within(reviews).getAllByRole('listitem');
    // Oldest first, reviews and comments together.
    expect(entries.map((li) => li.getAttribute('aria-label'))).toEqual(['Review by erin: Changes requested', 'Comment by carol', 'Review by frank: Approved']);
    expect(entries[0]!.textContent).toContain('Needs work');
    expect(within(entries[0]!).getByRole('button', { name: 'src/a.ts:3' })).toBeTruthy();
    expect(entries[0]!.textContent).toContain('Off by one');
    // Markdown, rendered.
    expect(within(entries[1]!).getByText('Ship it').tagName).toBe('STRONG');
    fireEvent.click(within(entries[1]!).getByRole('button', { name: 'Open the comment by carol' }));
    await waitFor(() => expect(calls(main, 'links.open')).toContainEqual({ url: `${url}#note_2` }));
  });

  it('shows its reviewers, and its description as the Forge renders it: Markdown, its mermaid diagrams drawn, its HTML comments hidden, as in its comments', async () => {
    const description = ['<!-- Say what this changes. -->', '## What', '', 'Invoices use the **billing** currency.', '', '```mermaid', 'flowchart LR', '  showInvoice --> currencyFor', '```'].join('\n');
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] }, { 'sessions.mergeRequest': () => details({ reviewers: ['erin', 'frank'], description, comments: [{ author: 'carol', body: '<!-- coverage-bot -->\nCoverage **91%**', at: 2000, url: `${url}#note_2` }] }) });
    open(main);
    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });

    expect(shown.querySelector('.mr-head')!.querySelectorAll('.mr-meta')[1]!.textContent).toBe('by daveReviewersERerinFRfrank3 commits3 files+67−1');
    const section = within(shown).getByRole('region', { name: 'Description' });
    expect(within(section).getByRole('heading', { name: 'What' })).toBeTruthy();
    expect(within(section).getByText('billing').tagName).toBe('STRONG');
    expect(section.textContent).not.toContain('Say what this changes');
    const diagram = await within(section).findByRole('img', { name: 'Diagram' });
    expect(diagram.querySelector('svg')!.textContent).toContain('currencyFor');
    // Drawn instead of shown as code: its code is copied from its right-click menu.
    expect(within(section).queryByRole('button', { name: 'Copy code' })).toBeNull();
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
    fireEvent.contextMenu(diagram);
    fireEvent.click(within(screen.getByRole('menu', { name: 'Context menu' })).getByRole('menuitem', { name: 'Copy code' }));
    await waitFor(() => expect(copied).toEqual(['flowchart LR\n  showInvoice --> currencyFor']));
    const reviews = within(shown).getByRole('region', { name: 'Reviews and comments' });
    expect(within(reviews).getByRole('listitem', { name: 'Comment by carol' }).querySelector('.rb')!.textContent).toBe('Coverage 91%');
  });

  it("shows a diagram it can't draw as its code, saying why, and says when there is no description", async () => {
    let description = '```mermaid\nflowchart LR\n  a -->\n```';
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] }, { 'sessions.mergeRequest': () => details({ description }) });
    open(main);
    const shown = panel();
    const section = within(shown).getByRole('region', { name: 'Description' });
    expect((await within(section).findByRole('note')).textContent).toBe("Couldn't draw this diagram: Parse error on line 2: Expecting 'NODE_STRING', got 'EOF'");
    expect(within(section).getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(section.textContent).toContain('a -->');
    expect(within(shown).getByText('by dave').closest('.mr-meta')!.textContent).not.toContain('Reviewer');

    description = '  ';
    fireEvent.click(within(shown).getByRole('button', { name: 'Refresh the Merge request' }));
    await waitFor(() => expect(section.textContent).toBe('DescriptionNo description.'));
  });

  it('takes the checks Babysit last saw over its own read, and reads it again after each poll', async () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open', babysit: { ci: 'passed', checks: [{ name: 'rspec', state: 'passed' }], lastPollAt: 5, stale: false } })] }, { 'sessions.mergeRequest': () => details() });
    open(main);
    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });
    expect(within(within(shown).getByRole('region', { name: /^Checks/ })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['rspecPassed']);

    act(() => main.publish('sessions', [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open', babysit: { ci: 'passed', checks: [], lastPollAt: 6, stale: false } })]));
    await waitFor(() => expect(calls(main, 'sessions.mergeRequest')).toHaveLength(2));
  });

  it("says why it couldn't be read, keeping what it read before, and reads it again on Try again", async () => {
    let fail = false;
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] }, {
      'sessions.mergeRequest': () => {
        if (fail) throw new Error('glab mr view exited with code 1: 502');
        return details();
      },
    });
    open(main);
    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });

    fail = true;
    fireEvent.click(within(shown).getByRole('button', { name: 'Refresh the Merge request' }));
    expect((await within(shown).findByRole('alert')).textContent).toBe("Couldn't read it from GitLab: glab mr view exited with code 1: 502 Try again");
    expect(within(shown).getByRole('heading', { name: 'Fix the login bug' })).toBeTruthy();
    fail = false;
    fireEvent.click(within(shown).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(shown).queryByRole('alert')).toBeNull());
  });

  it("counts others' reviews in the Glance strip and the tab, showing them in the Panel", async () => {
    const reviews = { reviews: 1, comments: 2, changesRequested: true };
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open', babysit: { stale: false, reviews } })] }, { 'sessions.mergeRequest': () => details() });
    open(main);
    const chip = within(glance()).getByRole('button', { name: '1 review, changes requested: show them' });
    expect(chip.textContent).toBe('1 review');
    expect(chip.querySelector('.tone-pending')).not.toBeNull();

    fireEvent.click(chip);
    const shown = screen.getByRole('tabpanel', { name: 'Merge request' });
    await waitFor(() => expect(document.activeElement).toBe(within(shown).getByRole('heading', { name: 'Reviews and comments' })));
    expect(screen.getByRole('tab', { name: 'Merge request' }).getAttribute('aria-description')).toBe('1 review, changes requested');

    act(() => main.publish('sessions', [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open', babysit: { stale: false, reviews: { reviews: 0, comments: 1, changesRequested: false } } })]));
    expect(within(glance()).getByRole('button', { name: '1 comment: show them' }).textContent).toBe('1 comment');
    act(() => main.publish('sessions', [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open', babysit: { stale: false, reviews: { reviews: 0, comments: 0, changesRequested: false } } })]));
    expect(within(glance()).queryByRole('button', { name: /show them$/ })).toBeNull();
  });

  it("shows a merged one's state, and just opens it from an archived Session", async () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ status: 'archived', mergeRequest: { number: 12, url }, mergeRequestState: 'merged' })] }, { 'sessions.mergeRequest': () => details({ state: 'merged' }) });
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fix login' }));
    expect(within(glance()).getByRole('button', { name: 'Merge request !12' }).textContent).toBe('!12Merged');
    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });
    expect(shown.querySelector('.mr-meta')!.textContent).toContain('Merged');

    for (const name of ['Update Merge request', 'Link Merge request…']) expect(within(shown).queryByRole('button', { name })).toBeNull();
    expect(within(shown).queryAllByRole('switch')).toEqual([]);
    fireEvent.click(within(shown).getByRole('button', { name: 'Open on GitLab' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url }]));
  });

  it('asks the agent to create one when none is linked, and offers nothing with the Forge off', () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session()] });
    open(main);
    expect(within(glance()).getByRole('button', { name: 'No Merge request yet' }).textContent).toBe('Merge request');
    fireEvent.click(within(panel('No Merge request yet')).getByRole('button', { name: 'Create Merge request' }));
    expect(calls(main, 'sessions.requestMergeRequest')).toEqual([{ id: 1 }]);
    expect(calls(main, 'sessions.mergeRequest')).toEqual([]);
    // The + menu offers it only with one linked.
    fireEvent.click(screen.getByRole('button', { name: 'Add a Panel to the Side area' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Changes', 'Highlights', 'Terminal']);
    cleanup();

    const off = new FakeMain({ projects: [{ ...gitlab, forge: { state: 'no-remote', checking: false } }], sessions: [session()] });
    open(off);
    expect(within(glance()).queryByRole('button', { name: 'No Merge request yet' })).toBeNull();
  });

  it('links one by hand, showing why the Forge refused it', async () => {
    let refuse = true;
    const main = new FakeMain({ projects: [gitlab], sessions: [session()] }, {
      'sessions.linkMergeRequest': () => {
        if (refuse) throw new Error('That Merge request is closed: only an open one can be linked.');
      },
    });
    open(main);

    fireEvent.click(within(panel('No Merge request yet')).getByRole('button', { name: 'Link Merge request…' }));
    const form = within(panel()).getByRole('form', { name: 'Link Merge request' });
    expect(document.activeElement).toBe(within(form).getByRole('textbox', { name: 'Merge request number or URL' }));
    fireEvent.change(within(form).getByRole('textbox', { name: 'Merge request number or URL' }), { target: { value: ' !41 ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Link' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('That Merge request is closed: only an open one can be linked.');

    refuse = false;
    fireEvent.change(within(form).getByRole('textbox', { name: 'Merge request number or URL' }), { target: { value: url } });
    fireEvent.click(within(form).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(within(panel()).queryByRole('form', { name: 'Link Merge request' })).toBeNull());
    expect(calls(main, 'sessions.linkMergeRequest')).toEqual([
      { id: 1, mergeRequest: '!41' },
      { id: 1, mergeRequest: url },
    ]);
  });

  it('closes the link form on Esc or Cancel', () => {
    open(new FakeMain({ projects: [gitlab], sessions: [session()] }));
    const shown = panel('No Merge request yet');
    fireEvent.click(within(shown).getByRole('button', { name: 'Link Merge request…' }));
    fireEvent.keyDown(within(shown).getByRole('textbox', { name: 'Merge request number or URL' }), { key: 'Escape' });
    expect(within(shown).queryByRole('form', { name: 'Link Merge request' })).toBeNull();
    fireEvent.click(within(shown).getByRole('button', { name: 'Link Merge request…' }));
    fireEvent.click(within(shown).getByRole('button', { name: 'Cancel' }));
    expect(within(shown).queryByRole('form', { name: 'Link Merge request' })).toBeNull();
  });

  it('opens Link Merge request from the palette', () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url } })] }, { 'sessions.mergeRequest': () => details() });
    open(main);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const palette = screen.getByRole('dialog', { name: 'Command palette' });
    expect(within(palette).getByRole('option', { name: 'Update Merge request !12 for this Session' })).toBeTruthy();
    fireEvent.click(within(palette).getByRole('option', { name: 'Link Merge request…' }));

    const shown = screen.getByRole('tabpanel', { name: 'Merge request' });
    expect(within(shown).getByRole('form', { name: 'Link Merge request' })).toBeTruthy();
    expect(document.activeElement).toBe(within(shown).getByRole('textbox', { name: 'Merge request number or URL' }));
  });
});

describe('Squash and merge, from the Merge request Panel', () => {
  const github: Project = { ...gitlab, forge: { state: 'available', checking: false, kind: 'github', host: 'github.com', repository: 'acme/billing-api' } };
  const dialog = () => screen.getByRole('alertdialog', { name: 'Squash and merge !12?' });

  it("asks first, naming the squash commit's title, which can be changed, and how many commits it squashes, warning of failed checks and changes asked for", async () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] }, { 'sessions.mergeRequest': () => details(), 'sessions.squashAndMerge': () => ({ state: 'merged' }) });
    open(main);
    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });
    // Next to it, opening it on the Forge.
    const foot = shown.querySelector('.mr-foot')!;
    expect([...foot.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Squash and merge', 'Open on GitLab', 'Update Merge request', 'Link Merge request…']);

    fireEvent.click(within(shown).getByRole('button', { name: 'Squash and merge' }));
    const asked = dialog();
    expect(asked.querySelector('p')!.textContent).toBe('3 commits will be squashed into one commit on main:');
    const title = within(asked).getByRole('textbox', { name: 'Squash commit title' }) as HTMLInputElement;
    expect(title.value).toBe('Fix the login bug');
    expect([...asked.querySelectorAll('.warnline')].map((line) => line.textContent)).toEqual(['CI failed on test.', 'erin asked for changes.', 'Merge anyway?']);
    expect(document.activeElement).toBe(within(asked).getByRole('button', { name: 'Cancel' }));
    expect(calls(main, 'sessions.squashAndMerge')).toEqual([]);

    fireEvent.change(title, { target: { value: 'fix(login): Fix the login bug' } });
    fireEvent.click(within(asked).getByRole('button', { name: 'Squash and merge' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls(main, 'sessions.squashAndMerge')).toEqual([{ id: 1, title: 'fix(login): Fix the login bug', head: 'abc123' }]);
    // Read again, to show it merged.
    await waitFor(() => expect(calls(main, 'sessions.mergeRequest')).toHaveLength(2));
  });

  it("gives GitHub's title with the number, warns of nothing once checks pass and the reviewer approved since, and closes on Cancel or Esc", async () => {
    const reviews = [
      { author: 'erin', verdict: 'changes-requested' as const, body: 'Needs work', at: 1000, url: `${url}#r1`, comments: [] },
      { author: 'erin', verdict: 'commented' as const, body: 'Thanks', at: 1500, url: `${url}#r2`, comments: [] },
      { author: 'erin', verdict: 'approved' as const, body: '', at: 2000, url: `${url}#r3`, comments: [] },
    ];
    const main = new FakeMain({ projects: [github], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] }, { 'sessions.mergeRequest': () => details({ commits: 1, ci: 'passed', checks: [{ name: 'test', state: 'passed' }], reviews }) });
    open(main);
    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });

    fireEvent.click(within(shown).getByRole('button', { name: 'Squash and merge' }));
    const asked = screen.getByRole('alertdialog', { name: 'Squash and merge #12?' });
    expect(asked.querySelector('p')!.textContent).toBe('1 commit will be squashed into one commit on main:');
    expect((within(asked).getByRole('textbox', { name: 'Squash commit title' }) as HTMLInputElement).value).toBe('Fix the login bug (#12)');
    expect(asked.querySelector('.warnline')).toBeNull();
    fireEvent.click(within(asked).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(within(shown).getByRole('button', { name: 'Squash and merge' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Esc closed the dialog only, not the Panel.
    expect(screen.getByRole('tabpanel', { name: 'Merge request' })).toBeTruthy();
    expect(calls(main, 'sessions.squashAndMerge')).toEqual([]);
  });

  it('shows why the Forge refused, keeping the dialog open, and says when the Forge will merge it later', async () => {
    let merge: () => { state?: 'open' | 'merged' } = () => {
      throw new Error('gh pr merge exited with code 1: GraphQL: Head branch was modified. Review and try the merge again.');
    };
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] }, { 'sessions.mergeRequest': () => details(), 'sessions.squashAndMerge': () => merge() });
    open(main);
    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });
    fireEvent.click(within(shown).getByRole('button', { name: 'Squash and merge' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Squash and merge' }));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('gh pr merge exited with code 1: GraphQL: Head branch was modified. Review and try the merge again.');

    merge = () => ({ state: 'open' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Squash and merge' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(within(shown).getByRole('status').textContent).toBe('GitLab will merge !12 once it can.');
  });

  it('is offered on an open Merge request only, and waits for a draft to be marked ready', async () => {
    let read = details({ draft: true });
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] }, { 'sessions.mergeRequest': () => read });
    open(main);
    const shown = panel();
    await within(shown).findByRole('heading', { name: 'Fix the login bug' });
    const button = within(shown).getByRole('button', { name: 'Squash and merge' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('!12 is a draft: mark it ready on GitLab first.');

    read = details({ state: 'merged' });
    fireEvent.click(within(shown).getByRole('button', { name: 'Refresh the Merge request' }));
    await waitFor(() => expect(shown.querySelector('.mr-meta')!.textContent).toContain('Merged'));
    expect(within(shown).queryByRole('button', { name: 'Squash and merge' })).toBeNull();
  });
});
