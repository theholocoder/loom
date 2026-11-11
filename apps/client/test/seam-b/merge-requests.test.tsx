import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session, TranscriptItem } from '../../src/shared/api';
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

/** The Merge request popover, opened from its chip in the Glance strip if it isn't open. */
function mergeRequestPopover(): HTMLElement {
  if (!screen.queryByRole('dialog', { name: 'Merge request' })) fireEvent.click(within(glance()).getByRole('button', { name: /^(Merge request [#!]\d+|No Merge request yet)$/ }));
  return screen.getByRole('dialog', { name: 'Merge request' });
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

  it('shows in the Glance strip once linked, its popover opening it, asking the agent to update it, or linking another', async () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url }, mergeRequestState: 'open' })] });
    open(main);
    expect(within(glance()).getByRole('button', { name: 'Merge request !12' }).textContent).toBe('!12');
    const popover = mergeRequestPopover();
    expect(within(popover).getByRole('heading').textContent).toBe('Merge request !12Open');
    expect(within(popover).queryByRole('button', { name: 'Create Merge request' })).toBeNull();

    fireEvent.click(within(popover).getByRole('button', { name: 'Open !12' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url }]));
    fireEvent.click(within(mergeRequestPopover()).getByRole('button', { name: 'Link Merge request…' }));
    expect(within(mergeRequestPopover()).getByRole('form', { name: 'Link Merge request' })).toBeTruthy();
    fireEvent.click(within(mergeRequestPopover()).getByRole('button', { name: 'Update Merge request' }));
    await waitFor(() => expect(calls(main, 'sessions.requestMergeRequest')).toEqual([{ id: 1 }]));
    // Asking closes it: the agent's reply is in the conversation.
    expect(screen.queryByRole('dialog', { name: 'Merge request' })).toBeNull();
  });

  it("shows a merged one's state, and just opens it from an archived Session", async () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ status: 'archived', mergeRequest: { number: 12, url }, mergeRequestState: 'merged' })] });
    renderApp(main);
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fix login' }));
    expect(within(glance()).getByRole('button', { name: 'Merge request !12' }).textContent).toBe('!12Merged');
    const popover = mergeRequestPopover();

    for (const name of ['Update Merge request', 'Link Merge request…', 'Babysit', 'Auto-prompt']) expect(within(popover).queryByRole('button', { name })).toBeNull();
    expect(within(popover).queryAllByRole('switch')).toEqual([]);
    fireEvent.click(within(popover).getByRole('button', { name: 'Open !12' }));
    await waitFor(() => expect(calls(main, 'links.open')).toEqual([{ url }]));
  });

  it('asks the agent to create one when none is linked, and offers nothing with the Forge off', () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session()] });
    open(main);
    expect(within(glance()).getByRole('button', { name: 'No Merge request yet' }).textContent).toBe('Merge request');
    fireEvent.click(within(mergeRequestPopover()).getByRole('button', { name: 'Create Merge request' }));
    expect(calls(main, 'sessions.requestMergeRequest')).toEqual([{ id: 1 }]);
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

    fireEvent.click(within(mergeRequestPopover()).getByRole('button', { name: 'Link Merge request…' }));
    const dialog = within(mergeRequestPopover()).getByRole('form', { name: 'Link Merge request' });
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Merge request number or URL' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Merge request number or URL' }), { target: { value: ' !41 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('That Merge request is closed: only an open one can be linked.');

    refuse = false;
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Merge request number or URL' }), { target: { value: url } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Merge request' })).toBeNull());
    expect(calls(main, 'sessions.linkMergeRequest')).toEqual([
      { id: 1, mergeRequest: '!41' },
      { id: 1, mergeRequest: url },
    ]);
  });

  it('opens Link Merge request from the palette', () => {
    const main = new FakeMain({ projects: [gitlab], sessions: [session({ mergeRequest: { number: 12, url } })] });
    open(main);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const palette = screen.getByRole('dialog', { name: 'Command palette' });
    expect(within(palette).getByRole('option', { name: 'Update Merge request !12 for this Session' })).toBeTruthy();
    fireEvent.click(within(palette).getByRole('option', { name: 'Link Merge request…' }));

    const popover = screen.getByRole('dialog', { name: 'Merge request' });
    expect(within(popover).getByRole('form', { name: 'Link Merge request' })).toBeTruthy();
    expect(document.activeElement).toBe(within(popover).getByRole('textbox', { name: 'Merge request number or URL' }));
  });
});
