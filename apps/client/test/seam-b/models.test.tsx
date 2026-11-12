import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { AgentConfig, Commands, ModelChoice, Project, Session, TranscriptItem } from '../../src/shared/api';
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

const project: Project = {
  id: 1,
  name: 'billing-api',
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path: '/home/dev/billing-api' },
  forge: { state: 'no-remote', checking: false },
};

const probed: ModelChoice[] = [
  { id: 'opencode/pulse-free', name: 'Pulse Free', efforts: [] },
  { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'high', 'max', 'default'] },
];

const agentConfig: AgentConfig = {
  model: 'anthropic/claude-sonnet-5-5',
  models: [
    { id: 'opencode/pulse-free', name: 'Pulse Free' },
    { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  ],
  effort: 'high',
  efforts: ['low', 'high', 'max', 'default'],
};

const finished: Session = {
  id: 7,
  projectId: 1,
  title: 'Say hello',
  workingCopy: { kind: 'checkout', path: '/home/dev/billing-api' },
  agent: 'OpenCode',
  status: 'waiting',
  waitingReason: 'finished',
  agentConfig,
  unread: false,
  createdAt: 1,
  updatedAt: 1,
};

function startNewSession() {
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
  const filter = screen.queryByRole('combobox', { name: 'Filter Projects' });
  if (filter) fireEvent.keyDown(filter, { key: 'Enter' });
  return screen.getByRole('main', { name: 'New Session' });
}

function open(session: Session) {
  if (session.status === 'working') fireEvent.click(screen.getByRole('button', { name: 'Working' }));
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: session.title }));
  return screen.getByRole('form', { name: 'Composer' });
}

/** The options a picker lists, as shown. */
function listed(name: string) {
  return within(screen.getByRole('listbox', { name })).getAllByRole('option').map((o) => o.textContent);
}

describe('the model and Effort pickers before a Session exists', () => {
  it("lists the models OpenCode offers in the Project's checkout by name, provider/model beside, starting on the one picked with its Effort", async () => {
    const created: unknown[] = [];
    const main = renderApp(
      new FakeMain(
        { projects: [project] },
        {
          'projects.models': () => probed,
          'sessions.create': (params) => {
            created.push(params);
            return finished;
          },
        },
      ),
    );
    const pane = startNewSession();
    const model = within(pane).getByRole('button', { name: 'Model' });
    expect(model.textContent).toBe('Default model');
    expect(within(pane).queryByRole('button', { name: 'Effort' })).toBeNull();

    fireEvent.click(model);
    await waitFor(() => expect(listed('Models')).toEqual(['Pulse Freeopencode/pulse-free', 'Claude Sonnet 5.5anthropic/claude-sonnet-5-5']));
    expect(main.invoked.filter((i) => i.command === 'projects.models')).toEqual([{ command: 'projects.models', params: { id: 1 } }]);
    fireEvent.click(screen.getByRole('option', { name: /claude-sonnet-5-5/ }));
    expect(model.textContent).toBe('Claude Sonnet 5.5');
    // The id stays in its tooltip.
    expect(model.title).toBe('anthropic/claude-sonnet-5-5');

    const effort = within(pane).getByRole('button', { name: 'Effort' });
    expect(effort.textContent).toBe('Effort: default');
    fireEvent.click(effort);
    expect(listed('Effort')).toEqual(['Effort: low', 'Effort: high', 'Effort: max', 'Effort: default']);
    fireEvent.click(screen.getByRole('option', { name: 'Effort: high' }));

    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Hi' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', effort: 'high', prompt: 'Hi' });
  });

  it("leaves the model to the agent when none is picked, and offers no Effort for a model that takes none", async () => {
    const created: Array<Commands['sessions.create']['params']> = [];
    renderApp(
      new FakeMain(
        { projects: [project] },
        {
          'projects.models': () => probed,
          'sessions.create': (params) => {
            created.push(params);
            return finished;
          },
        },
      ),
    );
    const pane = startNewSession();
    fireEvent.click(within(pane).getByRole('button', { name: 'Model' }));
    await waitFor(() => screen.getByRole('option', { name: /pulse-free/ }));
    fireEvent.click(screen.getByRole('option', { name: /pulse-free/ }));
    expect(within(pane).queryByRole('button', { name: 'Effort' })).toBeNull();

    fireEvent.change(within(pane).getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Hi' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.model).toBe('opencode/pulse-free');
    expect(created[0]).not.toHaveProperty('effort');
  });

  it('says which model the default is, once OpenCode has said', async () => {
    renderApp(new FakeMain({ projects: [project] }, { 'projects.models': () => [{ ...probed[0]!, default: true }, probed[1]!] }));
    const pane = startNewSession();
    const model = within(pane).getByRole('button', { name: 'Model' });

    await waitFor(() => expect(model.textContent).toBe('Pulse Free (default)'));
    expect(model.title).toBe("OpenCode's default model: opencode/pulse-free");
  });

  it("says why the models couldn't be listed", async () => {
    renderApp(
      new FakeMain(
        { projects: [project] },
        {
          'projects.models': () => {
            throw new Error('could not ask OpenCode');
          },
        },
      ),
    );
    const pane = startNewSession();
    fireEvent.click(within(pane).getByRole('button', { name: 'Model' }));
    expect((await screen.findByRole('alert')).textContent).toContain('could not ask OpenCode');
  });
});

describe('the model and Effort pickers in a Session', () => {
  it("offer what the Session's agent offers, and change the model and Effort from the next prompt", async () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [finished] }));
    const composer = open(finished);

    const model = within(composer).getByRole('button', { name: 'Model' });
    expect(model.textContent).toBe('Claude Sonnet 5.5');
    expect(model.title).toBe('anthropic/claude-sonnet-5-5');
    fireEvent.click(model);
    expect(listed('Models')).toEqual(['Pulse Freeopencode/pulse-free', 'Claude Sonnet 5.5anthropic/claude-sonnet-5-5']);
    fireEvent.click(screen.getByRole('option', { name: /pulse-free/ }));
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'sessions.setModel', params: { id: 7, model: 'opencode/pulse-free' } }));

    const effort = within(composer).getByRole('button', { name: 'Effort' });
    expect(effort.textContent).toBe('Effort: high');
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole('option', { name: 'Effort: max' }));
    await waitFor(() => expect(main.invoked).toContainEqual({ command: 'sessions.setModel', params: { id: 7, effort: 'max' } }));
    // Only what the Session's agent offers: never asked of the probe.
    expect(main.invoked.map((i) => i.command)).not.toContain('projects.models');
  });

  it('shows the model and Effort picked before the agent says what it offers, from the models of the checkout', async () => {
    const picked: Session = { ...finished, agentConfig: undefined, model: 'anthropic/claude-sonnet-5-5', effort: 'low' };
    renderApp(new FakeMain({ projects: [project], sessions: [picked] }, { 'projects.models': () => probed }));
    const composer = open(picked);

    await waitFor(() => expect(within(composer).getByRole('button', { name: 'Effort' }).textContent).toBe('Effort: low'));
    expect(within(composer).getByRole('button', { name: 'Model' }).textContent).toBe('Claude Sonnet 5.5');
  });

  it('are disabled while the agent is Working, or waits on an answer', () => {
    const working: Session = { ...finished, status: 'working', waitingReason: undefined };
    renderApp(new FakeMain({ projects: [project], sessions: [working] }));
    const composer = open(working);

    expect(within(composer).getByRole('button', { name: 'Model' })).toHaveProperty('disabled', true);
    expect(within(composer).getByRole('button', { name: 'Effort' })).toHaveProperty('disabled', true);
  });

  it("stay enabled while the Session's agent isn't running, as after a restart", () => {
    const stopped: Session = { ...finished, agentConfig: undefined, model: 'opencode/pulse-free' };
    renderApp(new FakeMain({ projects: [project], sessions: [stopped] }));
    const composer = open(stopped);

    expect(within(composer).getByRole('button', { name: 'Model' })).toHaveProperty('disabled', false);
  });

  it('shows why a change was refused', async () => {
    renderApp(
      new FakeMain(
        { projects: [project], sessions: [finished] },
        {
          'sessions.setModel': () => {
            throw new Error('OpenCode could not switch to the model opencode/pulse-free');
          },
        },
      ),
    );
    const composer = open(finished);
    fireEvent.click(within(composer).getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('option', { name: /pulse-free/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('could not switch');
  });

  it('says which model the default is before the agent runs, from the models of the checkout', async () => {
    const unpicked: Session = { ...finished, agentConfig: undefined };
    renderApp(new FakeMain({ projects: [project], sessions: [unpicked] }, { 'projects.models': () => [{ ...probed[0]!, default: true }, probed[1]!] }));
    const composer = open(unpicked);

    await waitFor(() => expect(within(composer).getByRole('button', { name: 'Model' }).textContent).toBe('Pulse Free (default)'));
  });

  it('marks each change in the timeline, by name, provider/model in its tooltip', () => {
    const main = renderApp(new FakeMain({ projects: [project], sessions: [finished] }));
    const items: TranscriptItem[] = [
      { kind: 'user', id: 0, text: 'Hi' },
      { kind: 'model', id: 1, model: 'opencode/pulse-free' },
      { kind: 'model', id: 2, effort: 'max' },
      { kind: 'model', id: 3, model: 'anthropic/claude-sonnet-5-5', effort: 'high' },
    ];
    main.publish('transcript', items, { sessionId: 7 });
    open(finished);

    const notes = within(screen.getByRole('log', { name: 'Conversation' })).getAllByRole('note').map((n) => n.textContent);
    expect(notes).toEqual([
      'Model Pulse Free from the next prompt',
      'Effort max from the next prompt',
      'Model Claude Sonnet 5.5, Effort high from the next prompt',
    ]);
    expect(screen.getByText('Pulse Free').title).toBe('opencode/pulse-free');
  });
});

describe('the context gauge', () => {
  it("shows how full the agent's context is, in the composer", () => {
    const filling: Session = { ...finished, context: { used: 50_000, size: 200_000 } };
    renderApp(new FakeMain({ projects: [project], sessions: [filling] }));
    const composer = open(filling);

    const gauge = within(composer).getByRole('meter', { name: 'Context' });
    expect(gauge.textContent).toBe('25%');
    expect(gauge.getAttribute('aria-valuenow')).toBe('25');
    expect(gauge.getAttribute('title')).toBe('50,000 of 200,000 tokens of context used');
  });

  it('is left out until the agent has said', () => {
    renderApp(new FakeMain({ projects: [project], sessions: [finished] }));
    const composer = open(finished);

    expect(within(composer).queryByRole('meter', { name: 'Context' })).toBeNull();
  });
});
