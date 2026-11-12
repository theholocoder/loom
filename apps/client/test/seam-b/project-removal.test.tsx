import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project, Session } from '../../src/shared/api';
import { emptyDashboard, FakeMain } from './fake-main';

afterEach(cleanup);

/** Projects' own Add a Project…, rather than the welcome's behind it. */
const addProjectButton = () => within(screen.getByRole('dialog', { name: 'Projects' })).getByRole('button', { name: 'Add a Project…' });

function renderApp(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const loom: Project = {
  id: 1,
  name: 'loom',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/code/loom' },
  forge: { state: 'available', checking: false, kind: 'github', repository: 'theholocoder/loom' },
};

let nextId = 1;
function session(change: Partial<Session>): Session {
  const id = nextId++;
  return {
    id,
    projectId: loom.id,
    title: `Session ${id}`,
    workingCopy: { kind: 'checkout', path: '/home/dev/code/loom' },
    agent: 'OpenCode',
    status: 'waiting',
    waitingReason: 'finished',
    unread: false,
    createdAt: 1,
    updatedAt: 2,
    ...change,
  };
}

function openProjects(main: FakeMain) {
  renderApp(main);
  fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
  return main;
}

const removeCalls = (main: FakeMain) => main.invoked.filter((i) => i.command === 'projects.remove');

describe('removing a Project from Projects', () => {
  it('asks first, saying the folder stays and how many Sessions go to the Archive', async () => {
    const sessions = [session({}), session({ status: 'working', waitingReason: undefined }), session({ status: 'archived', waitingReason: undefined })];
    const main = openProjects(new FakeMain({ projects: [loom], sessions }));

    fireEvent.click(within(screen.getByRole('row', { name: /loom/ })).getByRole('button', { name: 'Remove loom' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Remove loom?' });
    expect(dialog.textContent).toContain('/home/dev/code/loom');
    expect(dialog.textContent).toMatch(/stays on disk/);
    expect(dialog.textContent).toMatch(/3 Sessions/);
    expect(dialog.textContent).toMatch(/2 still Working or Waiting/);
    expect(removeCalls(main)).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removeCalls(main)).toEqual([{ command: 'projects.remove', params: { id: loom.id } }]));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('removes nothing when cancelled', () => {
    const main = openProjects(new FakeMain({ projects: [loom] }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove loom' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(removeCalls(main)).toEqual([]);
  });

  it('lists the Sessions with unsaved work, and removes only once told to discard it', async () => {
    let calls = 0;
    const main = openProjects(
      new FakeMain(
        { projects: [loom] },
        {
          'projects.remove': () =>
            calls++ === 0 ? { removed: false, unsaved: [{ sessionId: 7, title: 'Fix the login bug', unsavedWork: { uncommitted: true, unpushedCommits: 2, detached: false } }] } : { removed: true },
        },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove loom' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));

    const warning = await screen.findByRole('alertdialog', { name: 'Remove loom with unsaved work?' });
    expect(within(warning).getByRole('listitem').textContent).toMatch(/Fix the login bug.*uncommitted changes and 2 unpushed commits/);

    fireEvent.click(within(warning).getByRole('button', { name: 'Discard and remove' }));

    await waitFor(() => expect(removeCalls(main).at(-1)).toEqual({ command: 'projects.remove', params: { id: loom.id, discard: true } }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});

describe('adding a checkout of a removed Project', () => {
  const chosen = '/home/dev/elsewhere/loom';

  it('offers to restore it, Restore first, and restores it when chosen', async () => {
    const main = openProjects(
      new FakeMain(
        {},
        {
          'dialogs.chooseFolder': () => chosen,
          'projects.restorable': () => ({ id: 1, name: 'loom', sessions: 14 }),
          'projects.link': () => loom,
        },
      ),
    );

    fireEvent.click(addProjectButton());

    const offer = await screen.findByRole('alertdialog', { name: 'Restore loom?' });
    expect(offer.textContent).toMatch(/14 archived Sessions/);
    expect(document.activeElement).toBe(within(offer).getByRole('button', { name: 'Restore' }));
    expect(main.invoked.map((i) => i.command)).not.toContain('projects.link');

    fireEvent.click(within(offer).getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: chosen, restore: 1 } }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('offers to restore one with no archived Sessions without counting them', async () => {
    openProjects(
      new FakeMain({}, { 'dialogs.chooseFolder': () => chosen, 'projects.restorable': () => ({ id: 1, name: 'loom', sessions: 0 }), 'projects.link': () => loom }),
    );

    fireEvent.click(addProjectButton());

    const offer = await screen.findByRole('alertdialog', { name: 'Restore loom?' });
    expect(offer.textContent).toContain('Restore loom with its usage history, or start a new Project?');
    expect(offer.textContent).not.toMatch(/archived Session/);
  });

  it('starts a new Project instead when asked', async () => {
    const main = openProjects(
      new FakeMain({}, { 'dialogs.chooseFolder': () => chosen, 'projects.restorable': () => ({ id: 1, name: 'loom', sessions: 2 }), 'projects.link': () => loom }),
    );

    fireEvent.click(addProjectButton());
    fireEvent.click(await screen.findByRole('button', { name: 'New Project' }));

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: chosen } }));
  });

  it('links straight away when nothing matches', async () => {
    const main = openProjects(new FakeMain({}, { 'dialogs.chooseFolder': () => chosen, 'projects.link': () => loom }));

    fireEvent.click(addProjectButton());

    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'projects.link', params: { path: chosen } }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('a removed Project', () => {
  it("marks its Sessions in the Archive as the removed Project's", () => {
    renderApp(new FakeMain({ removedProjects: [{ id: 1, name: 'loom' }], sessions: [session({ title: 'Done long ago', status: 'archived', waitingReason: undefined })] }));

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));

    expect(screen.getByRole('button', { name: 'Done long ago' }).textContent).toContain('Project removed');
  });

  it("names it in an archived Session's header, marked removed", () => {
    renderApp(new FakeMain({ removedProjects: [{ id: 1, name: 'loom' }], sessions: [session({ title: 'Old work', status: 'archived', waitingReason: undefined })] }));

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: /Old work/ }));

    const header = screen.getByRole('region', { name: 'Session header' });
    expect(header.textContent).toContain('loom');
    expect(within(header).getByText('Project removed')).toBeTruthy();
  });

  it("turns its archived Sessions' composer off entirely", () => {
    renderApp(new FakeMain({ removedProjects: [{ id: 1, name: 'loom' }], sessions: [session({ title: 'Old work', status: 'archived', waitingReason: undefined })] }));

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: /Old work/ }));

    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    expect(composer.getAttribute('placeholder')).toBe("This Session's Project was removed.");
  });

  it('reopens an archived Session of a Project still there with a new message', async () => {
    const main = renderApp(new FakeMain({ projects: [loom], sessions: [session({ title: 'Old work', status: 'archived', waitingReason: undefined })] }));

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: /Old work/ }));
    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'One more thing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(main.invoked.find((i) => i.command === 'sessions.send')?.params).toMatchObject({ prompt: 'One more thing' }));
  });

  it('lets the message that reopens an archived Session pick a model and mention files', async () => {
    const main = renderApp(new FakeMain({ projects: [loom], sessions: [session({ title: 'Old work', status: 'archived', waitingReason: undefined })] }, { 'sessions.files': () => ['src/login.ts'] }));

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: /Old work/ }));

    expect((screen.getByRole('button', { name: 'Model' }) as HTMLButtonElement).disabled).toBe(false);
    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Look at @log', selectionStart: 12 } });
    await screen.findByRole('listbox', { name: 'Files' });
    expect(main.invoked.map((i) => i.command)).toContain('sessions.files');
  });

  it('is tagged removed in the Usage breakdowns', async () => {
    const dashboard = {
      ...emptyDashboard(7),
      tokens: 100,
      perProject: [{ projectId: 1, project: 'loom', tokens: 100, removed: true as const }],
      topSessions: [{ sessionId: 3, title: 'Fix the login bug', projectId: 1, project: 'loom', projectRemoved: true as const, model: 'anthropic/claude-sonnet-5-5', tokens: 100, workingMs: 0, outcome: 'archived' as const }],
    };
    renderApp(new FakeMain({}, { 'usage.dashboard': () => dashboard }));

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));

    const row = await screen.findByRole('row', { name: /Fix the login bug/ });
    expect(within(row).getByText('removed')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Tokens per Project' })).getByText('removed')).toBeTruthy();
  });
});
