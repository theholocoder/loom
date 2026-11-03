import { describe, expect, it } from 'vitest';
import { startMain, tempDir, tempMachine, waitFor, type AcpTurn, type Machine } from './harness';
import type { EnvironmentStatus, QuestionField, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

function machineWith(turns: AcpTurn[]): { machine: Machine; checkout: string } {
  const machine = tempMachine();
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns } });
  return { machine, checkout: machine.gitRepo('billing-api') };
}

async function started(machine: Machine, userDataDir?: string) {
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  return main;
}

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => sessions.some((s) => s.id === id && check(s));
const asking = (id: number) => session(id, (s) => s.status === 'waiting' && s.waitingReason === 'question');
const finished = (id: number) => session(id, (s) => s.status === 'waiting' && s.waitingReason === 'finished');
const questionCard = (items: TranscriptItem[]) => items.find((i): i is Extract<TranscriptItem, { kind: 'question' }> => i.kind === 'question');

/** OpenCode's `question` tool, as its ACP bridge elicits it: a select, and a free-text answer of one's own. */
const colorQuestion = {
  elicit: {
    message: 'Which color should the button be?',
    toolCallId: 'call_q',
    requestedSchema: {
      type: 'object',
      properties: {
        q0: { type: 'string', title: 'Color', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue', description: 'Like the sky' }] },
        q0_custom: { type: 'string', title: 'Color (other)', description: 'Type your own answer' },
      },
      required: [],
    },
  },
};

const colorFields: QuestionField[] = [
  { type: 'select', key: 'q0', title: 'Color', required: false, options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue', description: 'Like the sky' }] },
  { type: 'text', key: 'q0_custom', title: 'Color (other)', description: 'Type your own answer', required: false },
];

/** Starts a Session on `turns`' first turn and waits until its agent asks something. */
async function askedSession(turns: AcpTurn[], userDataDir?: string) {
  const { machine, checkout } = machineWith(turns);
  const main = await started(machine, userDataDir);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Add a button' });
  await waitFor(main.api, 'sessions', asking(id));
  const items = await waitFor(main.api, 'transcript', (list) => !!questionCard(list), { sessionId: id });
  return { machine, main, id, card: questionCard(items)! };
}

/** What Loom answered the agent's elicitations with. */
const elicitationResponses = (machine: Machine) => {
  const asked = new Set<number>();
  return machine
    .acpMessages()
    .filter(({ message }) => {
      if (message.method === undefined && message.id !== undefined && message.id >= 1000) return !asked.has(message.id) && asked.add(message.id);
      return false;
    })
    .map(({ message }) => message.result ?? message.error);
};

describe("the agent's questions", () => {
  it('advertises form elicitation, so OpenCode shows its questions instead of skipping them', async () => {
    const { machine } = await askedSession([{ chunks: [colorQuestion] }]);
    const initialize = machine.acpMessages().find((m) => m.message.method === 'initialize')!;
    expect(initialize.message.params?.clientCapabilities).toMatchObject({ elicitation: { form: {} } });
  });

  it('puts the Session in Waiting (question) with a question card, and answering resumes the run', async () => {
    const userDataDir = tempDir('loom-questions-');
    const { machine, main, id, card } = await askedSession([{ chunks: ['Let me ask.', colorQuestion, { hold: 'answered' }, 'Blue it is.'] }], userDataDir);
    expect(card).toEqual({ kind: 'question', id: 2, message: 'Which color should the button be?', fields: colorFields, state: 'asked' });

    await main.api.invoke('sessions.answer', { id, itemId: card.id, answer: { q0: 'blue' } });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'working'));
    machine.release('answered');
    await waitFor(main.api, 'sessions', finished(id));

    expect(elicitationResponses(machine)).toEqual([{ action: 'accept', content: { q0: 'blue' } }]);
    const answered = { ...card, state: 'answered', answer: { q0: 'blue' } };
    const items = await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'agent' && i.text === 'Blue it is.'), { sessionId: id });
    expect(items[2]).toEqual(answered);

    // The card stays in the transcript.
    await main.close();
    const again = await started(machine, userDataDir);
    const replayed = await waitFor(again.api, 'transcript', (list) => list.length > 0, { sessionId: id });
    expect(replayed[2]).toEqual(answered);
  });

  it("shows a plugin's or MCP server's dialog as a generic form, refuses answers that don't fit it, and dismissing declines it", async () => {
    const deployForm = {
      elicit: {
        message: 'Deploy settings',
        requestedSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', title: 'Target', enum: ['staging', 'production'], enumNames: ['Staging', 'Production'], default: 'staging' },
            notes: { type: 'string', title: 'Release notes', maxLength: 20 },
            regions: { type: 'array', title: 'Regions', items: { anyOf: [{ const: 'eu', title: 'Europe' }, { const: 'us', title: 'Americas' }] }, minItems: 1 },
            replicas: { type: 'integer', title: 'Replicas', minimum: 1, maximum: 5 },
            confirm: { type: 'boolean', title: 'Run migrations?', default: false },
          },
          required: ['target', 'regions', 'confirm'],
        },
      },
    };
    const { machine, main, id, card } = await askedSession([{ chunks: [deployForm, colorQuestion, 'Done.'] }]);
    expect(card.fields).toEqual([
      { type: 'select', key: 'target', title: 'Target', required: true, default: 'staging', options: [{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }] },
      { type: 'text', key: 'notes', title: 'Release notes', required: false, maxLength: 20 },
      { type: 'multiselect', key: 'regions', title: 'Regions', required: true, minItems: 1, options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'Americas' }] },
      { type: 'number', key: 'replicas', title: 'Replicas', required: false, integer: true, minimum: 1, maximum: 5 },
      { type: 'boolean', key: 'confirm', title: 'Run migrations?', required: true, default: false },
    ]);

    const answer = (values: Record<string, unknown>) => main.api.invoke('sessions.answer', { id, itemId: card.id, answer: values as never });
    await expect(answer({ target: 'production', confirm: true })).rejects.toThrow('"Regions" needs an answer.');
    await expect(answer({ target: 'qa', regions: ['eu'], confirm: true })).rejects.toThrow('"Target" can\'t be "qa".');
    await expect(answer({ target: 'staging', regions: ['eu'], replicas: 9, confirm: true })).rejects.toThrow('"Replicas" must be at most 5.');
    await expect(answer({ target: 'staging', regions: ['eu'], replicas: 2.5, confirm: true })).rejects.toThrow('"Replicas" can\'t be 2.5.');
    await expect(answer({ target: 'staging', regions: ['eu'], notes: 'x'.repeat(21), confirm: true })).rejects.toThrow('"Release notes" takes at most 20 characters.');
    const asked = await waitFor(main.api, 'transcript', () => true, { sessionId: id });
    expect(questionCard(asked)?.state).toBe('asked');

    await answer({ target: 'production', notes: '', regions: ['eu', 'us'], replicas: 3, confirm: true, extra: 'dropped' });
    await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'question' && i.message === 'Which color should the button be?' && i.state === 'asked'), { sessionId: id });
    const second = questionCard((await waitFor(main.api, 'transcript', () => true, { sessionId: id })).filter((i) => i.id !== card.id))!;
    await main.api.invoke('sessions.answer', { id, itemId: second.id, answer: null });
    await waitFor(main.api, 'sessions', finished(id));

    expect(elicitationResponses(machine)).toEqual([
      { action: 'accept', content: { target: 'production', regions: ['eu', 'us'], replicas: 3, confirm: true } },
      { action: 'decline' },
    ]);
    const items = await waitFor(main.api, 'transcript', () => true, { sessionId: id });
    expect(items.filter((i) => i.kind === 'question').map((i) => i.kind === 'question' && i.state)).toEqual(['answered', 'dismissed']);
    await expect(answer({ target: 'staging', regions: ['eu'], confirm: true })).rejects.toThrow('The agent is no longer asking this question.');
  });

  it('holds new prompts while a question is asked, and a question lost with its run can no longer be answered', async () => {
    const userDataDir = tempDir('loom-questions-');
    const { machine, main, id, card } = await askedSession([{ chunks: [colorQuestion] }], userDataDir);
    await expect(main.api.invoke('sessions.send', { id, prompt: 'Make it green' })).rejects.toThrow('answer or dismiss it first');

    // The Client quits with the question unanswered: its run is gone with the agent's process.
    await main.close();
    const again = await started(machine, userDataDir);
    await waitFor(again.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'interrupted'));
    const items = await waitFor(again.api, 'transcript', (list) => list.length > 0, { sessionId: id });
    expect(questionCard(items)).toEqual({ ...card, state: 'expired' });
    await expect(again.api.invoke('sessions.answer', { id, itemId: card.id, answer: { q0: 'red' } })).rejects.toThrow('The agent is no longer asking this question.');
  });

  it('shows why an archive stopped a Session waiting on a question but kept it', async () => {
    const machine = tempMachine();
    machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: [{ chunks: [colorQuestion] }], writeOnExit: 'late.txt' } });
    const checkout = machine.gitClone(machine.gitOrigin('billing-api', 'main'), 'billing-api');
    const main = await started(machine);
    const project = await main.api.invoke('projects.link', { path: checkout });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Add a button' });
    await waitFor(main.api, 'sessions', asking(id));

    // The agent writes as it stops, so the archive holds back.
    expect(await main.api.invoke('sessions.archive', { id })).toMatchObject({ archived: false, unsavedWork: { uncommitted: true } });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting' && s.waitingReason === 'error'));
    const items = await waitFor(main.api, 'transcript', (list) => list.at(-1)?.kind === 'error', { sessionId: id });
    expect(questionCard(items)?.state).toBe('expired');
  });
});
