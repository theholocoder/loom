import { describe, expect, it } from 'vitest';
import { git, startMain, tempDir, tempMachine, waitFor, type AcpTurn, type Machine, type PermissionToolCall } from './harness';
import type { EnvironmentStatus, Session, TranscriptItem } from '../../src/shared/api';

const ready = (envs: EnvironmentStatus[]) => envs.find((e) => e.id === 'native')?.agent?.state === 'ready';
const signedIn = [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }];

const session = (id: number, check: (s: Session) => boolean) => (sessions: Session[]) => sessions.some((s) => s.id === id && check(s));
const waitingOn = (id: number, reason: Session['waitingReason']) => session(id, (s) => s.status === 'waiting' && s.waitingReason === reason);
type Approval = Extract<TranscriptItem, { kind: 'approval' }>;
const approvals = (items: TranscriptItem[]) => items.filter((i): i is Approval => i.kind === 'approval');

/** A shell tool call, as OpenCode 2.2.5 asks permission for it. */
function shell(command: string, cwd: string, toolCallId = 'call_sh'): { permission: PermissionToolCall } {
  return { permission: { toolCallId, name: 'shell', title: command, kind: 'execute', locations: [{ path: cwd }], rawInput: { command, cwd } } };
}

/** A write tool call outside the working copy, as OpenCode asks for its external directory. */
function write(path: string, toolCallId = 'call_w'): { permission: PermissionToolCall } {
  return { permission: { toolCallId, name: 'write', title: path, kind: 'edit', locations: [{ path }], rawInput: { path, content: 'hi\n' } } };
}

interface Setup {
  machine: Machine;
  checkout: string;
}

/** A machine with OpenCode playing `turns`, and a clone of a Forge repository whose default branch is `main`. */
function machineWith(turns: AcpTurn[] | ((checkout: string) => AcpTurn[])): Setup {
  const machine = tempMachine();
  const checkout = machine.gitClone(machine.gitOrigin('billing-api', 'main'), 'billing-api');
  machine.installOpencode({ version: 'opencode v2.1.4', integrations: signedIn, acp: { turns: typeof turns === 'function' ? turns(checkout) : turns } });
  return { machine, checkout };
}

async function started(machine: Machine, userDataDir?: string) {
  const main = await startMain({ machine, userDataDir });
  await waitFor(main.api, 'environments', ready);
  return main;
}

/** Starts a Session and waits until its agent stops: on an Approval request, or finished. */
async function startSession({ machine, checkout }: Setup, workingCopy: 'checkout' | 'worktree', userDataDir?: string) {
  const main = await started(machine, userDataDir);
  const project = await main.api.invoke('projects.link', { path: checkout });
  const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy, prompt: 'Ship it' });
  const stopped = await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'waiting'));
  const items = await waitFor(main.api, 'transcript', () => true, { sessionId: id });
  return { main, id, session: stopped.find((s) => s.id === id)!, items };
}

/** What Loom answered the agent's permission requests with, by option id. */
const permissionAnswers = (machine: Machine) => {
  const asked = new Set(machine.acpMessages().filter((m) => m.message.method === undefined && m.message.id !== undefined && m.message.id >= 1000).map((m) => m.message.id));
  const seen = new Set<number>();
  return machine
    .acpMessages()
    .filter(({ message }) => message.id !== undefined && asked.has(message.id) && message.method === undefined && !seen.has(message.id) && seen.add(message.id))
    .map(({ message }) => (message.result as { outcome?: { optionId?: string } } | undefined)?.outcome?.optionId);
};

/** Resolves once `check` holds, looking every 20 ms for up to 5 s. */
async function until(check: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 5000; !check(); ) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The OPENCODE_CONFIG_CONTENT each agent process started with. */
const configs = (machine: Machine) => [...new Set(machine.acpMessages().map((m) => m.config))].map((c) => (c === undefined ? undefined : (JSON.parse(c) as Record<string, unknown>)));

/** The temp directory Loom gives the agent: `/tmp`, or on Windows its usual place under the home. */
const tempOf = (machine: Machine) => (process.platform === 'win32' ? `${machine.home.replaceAll('\\', '/')}/AppData/Local/Temp` : '/tmp');

describe('Approval requests', () => {
  it("gives OpenCode Loom's policy as permission rules in OPENCODE_CONFIG_CONTENT, and nothing else", async () => {
    const setup = machineWith([{ chunks: ['Done.'] }]);
    const { session: s } = await startSession(setup, 'worktree');
    const [config] = configs(setup.machine);
    expect(Object.keys(config!)).toEqual(['permission']);
    const permission = config!.permission as Record<string, Record<string, string>>;
    // Writing elsewhere asks, but not in the working copy (the worktree) or the temp directory.
    expect(permission.external_directory).toEqual({ '*': 'ask', [`${s.workingCopy.path}/*`]: 'allow', [`${tempOf(setup.machine)}/*`]: 'allow' });
    // OpenCode's shell rule is `shell`; pushes, Forge CLIs and sudo ask, and Loom answers what its policy allows.
    expect(permission.shell).toMatchObject({ 'git push': 'ask', 'git push *': 'ask', 'gh *': 'ask', 'glab *': 'ask', 'sudo *': 'ask', 'npm * -g': 'ask' });
    expect(permission.shell!['*']).toBeUndefined();
    // MCP and extension tools are allowed: no rule for them.
    expect(permission['*']).toBeUndefined();
  });

  it('puts the Session in Waiting (approval) with a card showing the command, and Approve once lets the agent go on', async () => {
    const setup = machineWith((checkout) => [{ chunks: ['Pushing.', shell('git push --force origin HEAD', checkout), 'Pushed.'] }]);
    const { main, id, items } = await startSession(setup, 'worktree');
    await waitFor(main.api, 'sessions', waitingOn(id, 'approval'));
    const [card] = approvals(items);
    expect(card).toEqual({ kind: 'approval', id: 2, toolCallId: 'call_sh', title: 'git push --force origin HEAD', tool: 'shell', detail: 'git push --force origin HEAD', category: 'otherPush', state: 'asked' });

    await main.api.invoke('sessions.approve', { id, itemId: card!.id, decision: 'once' });
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));
    expect(permissionAnswers(setup.machine)).toEqual(['once']);
    const after = await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'agent' && i.text === 'Pushed.'), { sessionId: id });
    expect(approvals(after)[0]?.state).toBe('approved');
    await expect(main.api.invoke('sessions.approve', { id, itemId: card!.id, decision: 'once' })).rejects.toThrow('no longer asking');
  });

  it("answers itself what its policy allows: a plain push of the Session's own branch, a gh command that changes nothing, a read elsewhere", async () => {
    const setup = machineWith((checkout) => [
      { chunks: [shell('git push -u origin HEAD', checkout, 'call_1'), shell('gh pr view --json url', checkout, 'call_2'), { permission: { toolCallId: 'call_3', name: 'read', title: '/etc/hosts', kind: 'read', locations: [{ path: '/etc/hosts' }], rawInput: { path: '/etc/hosts' } } }, 'Done.'] },
    ]);
    const { items, session: s } = await startSession(setup, 'worktree');
    expect(s.waitingReason).toBe('finished');
    expect(approvals(items)).toEqual([]);
    expect(permissionAnswers(setup.machine)).toEqual(['once', 'once', 'once']);
  });

  it("always asks before a push to the Project's default branch, which can't be approved for the Session", async () => {
    // A checkout Session on main: its own branch is the default one.
    const setup = machineWith((checkout) => [{ chunks: [shell('git push', checkout), 'Pushed.'] }]);
    const { main, id, items } = await startSession(setup, 'checkout');
    const [card] = approvals(items);
    expect(card).toMatchObject({ category: 'otherPush', defaultBranch: 'main', detail: 'git push', state: 'asked' });
    await expect(main.api.invoke('sessions.approve', { id, itemId: card!.id, decision: 'session' })).rejects.toThrow('always asks');
    // Even with pushes to other branches allowed.
    await main.api.invoke('settings.setApproval', { category: 'otherPush', setting: 'allow' });
    await main.api.invoke('sessions.approve', { id, itemId: card!.id, decision: 'once' });
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));
    expect(permissionAnswers(setup.machine)).toEqual(['once']);
  });

  it('Approve for this Session approves the whole category for the rest of the Session, and never in OpenCode\'s config', async () => {
    const setup = machineWith((checkout) => [
      { chunks: [write('/home/elsewhere/a.txt', 'call_a'), write('/home/elsewhere/b.txt', 'call_b'), shell('sudo apt install jq', checkout, 'call_c'), 'Done.'] },
      { chunks: [write('/home/elsewhere/c.txt', 'call_d'), 'Done again.'] },
    ]);
    const { main, id, items: first } = await startSession(setup, 'worktree');
    const [card] = approvals(first);
    expect(card).toMatchObject({ tool: 'write', detail: '/home/elsewhere/a.txt', category: 'writeElsewhere' });
    await main.api.invoke('sessions.approve', { id, itemId: card!.id, decision: 'session' });
    // The second write goes through; sudo is another category, so it asks.
    const items = await waitFor(main.api, 'transcript', (list) => approvals(list).length === 2, { sessionId: id });
    expect(approvals(items).map((a) => [a.category, a.state])).toEqual([
      ['writeElsewhere', 'approved-session'],
      ['system', 'asked'],
    ]);
    expect(permissionAnswers(setup.machine)).toEqual(['once', 'once']);
    await main.api.invoke('sessions.approve', { id, itemId: approvals(items)[1]!.id, decision: 'once' });
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));

    // The next run's writes elsewhere go through too.
    await main.api.invoke('sessions.send', { id, prompt: 'Once more' });
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));
    expect(permissionAnswers(setup.machine)).toEqual(['once', 'once', 'once', 'once']);
    expect(approvals(await waitFor(main.api, 'transcript', () => true, { sessionId: id }))).toHaveLength(2);
    // Loom answers "once" itself: OpenCode's config never holds the grant.
    for (const config of configs(setup.machine)) expect(JSON.stringify(config)).not.toContain('elsewhere');
  });

  it('Deny rejects the action, and its message goes to the agent as the next prompt once the run ends', async () => {
    const setup = machineWith((checkout) => [{ chunks: [shell('gh pr merge 12 --squash', checkout), 'Merged.'] }, { chunks: ['Understood, leaving it open.'] }]);
    const { main, id, items } = await startSession(setup, 'worktree');
    const [card] = approvals(items);
    expect(card).toMatchObject({ category: 'forge', detail: 'gh pr merge 12 --squash' });
    await main.api.invoke('sessions.approve', { id, itemId: card!.id, decision: 'deny', message: '  Leave the PR open for review.  ' });
    const done = await waitFor(main.api, 'transcript', (list) => list.some((i) => i.kind === 'agent' && i.text === 'Understood, leaving it open.'), { sessionId: id });
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));
    expect(permissionAnswers(setup.machine)).toEqual(['reject']);
    expect(approvals(done)[0]).toMatchObject({ state: 'denied', message: 'Leave the PR open for review.' });
    // The rejected turn ended without the agent's "Merged."; the message was the next prompt.
    expect(done.filter((i) => i.kind === 'user' || i.kind === 'agent').map((i) => ('text' in i ? i.text : ''))).toEqual(['Ship it', 'Leave the PR open for review.', 'Understood, leaving it open.']);
    const prompts = setup.machine.acpMessages().filter((m) => m.message.method === 'session/prompt');
    expect((prompts.at(-1)?.message.params?.prompt as Array<{ text: string }>)[0]!.text).toBe('Leave the PR open for review.');
  });

  it('Deny with no message leaves the Session Waiting once the agent stops', async () => {
    const setup = machineWith((checkout) => [{ chunks: [shell('sudo rm -rf /var/cache/app', checkout), 'Removed.'] }]);
    const { main, id, items } = await startSession(setup, 'worktree');
    await main.api.invoke('sessions.approve', { id, itemId: approvals(items)[0]!.id, decision: 'deny' });
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));
    expect(permissionAnswers(setup.machine)).toEqual(['reject']);
  });

  it('archiving with a request still asked counts as Deny', async () => {
    const setup = machineWith((checkout) => [{ chunks: [shell('git push origin HEAD:release', checkout)] }]);
    const { main, id, items } = await startSession(setup, 'checkout');
    await waitFor(main.api, 'sessions', waitingOn(id, 'approval'));
    await main.api.invoke('sessions.archive', { id });
    await waitFor(main.api, 'sessions', session(id, (s) => s.status === 'archived'));
    // The archive shows before the agent, stopping, has read the answer.
    await until(() => permissionAnswers(setup.machine).length > 0);
    expect(permissionAnswers(setup.machine)).toEqual(['reject']);
    const after = await waitFor(main.api, 'transcript', () => true, { sessionId: id });
    expect(approvals(after)[0]).toMatchObject({ id: approvals(items)[0]!.id, state: 'denied' });
  });

  it('a request lost with its run when the Client quits can no longer be answered', async () => {
    const userDataDir = tempDir('loom-approvals-');
    const setup = machineWith((checkout) => [{ chunks: [shell('git push origin HEAD:release', checkout)] }]);
    const { main, id, items } = await startSession(setup, 'worktree', userDataDir);
    await main.close();
    const again = await started(setup.machine, userDataDir);
    await waitFor(again.api, 'sessions', waitingOn(id, 'interrupted'));
    const replayed = await waitFor(again.api, 'transcript', (list) => list.length > 0, { sessionId: id });
    expect(approvals(replayed)[0]).toMatchObject({ state: 'expired' });
    await expect(again.api.invoke('sessions.approve', { id, itemId: approvals(items)[0]!.id, decision: 'once' })).rejects.toThrow('no longer asking');
  });

  it("follows the Allow/Ask settings: Loom's rules for agents started after, and its own answers at once", async () => {
    const setup = machineWith((checkout) => [
      { chunks: [write('/home/elsewhere/a.txt'), { permission: { toolCallId: 'call_m', name: 'github_create_issue', title: 'github_create_issue', kind: 'other', locations: [], rawInput: { title: 'Bug' } } }, 'Done.'] },
    ]);
    const userDataDir = tempDir('loom-approvals-');
    const main = await started(setup.machine, userDataDir);
    await main.api.invoke('settings.setApproval', { category: 'writeElsewhere', setting: 'allow' });
    const settings = await main.api.invoke('settings.setApproval', { category: 'mcp', setting: 'ask' });
    expect(settings.approvals).toMatchObject({ writeElsewhere: 'allow', mcp: 'ask', otherPush: 'ask' });
    await expect(main.api.invoke('settings.setApproval', { category: 'network' as never, setting: 'allow' })).rejects.toThrow('not an approval category');
    await expect(main.api.invoke('settings.setApproval', { category: 'mcp', setting: 'deny' as never })).rejects.toThrow('"allow" or "ask"');

    const project = await main.api.invoke('projects.link', { path: setup.checkout });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Ship it' });
    await waitFor(main.api, 'sessions', waitingOn(id, 'approval'));
    const items = await waitFor(main.api, 'transcript', (list) => approvals(list).length > 0, { sessionId: id });
    // The write elsewhere went through; the MCP tool asks.
    expect(approvals(items)).toMatchObject([{ tool: 'github_create_issue', category: 'mcp', detail: 'github_create_issue' }]);
    const permission = configs(setup.machine)[0]!.permission as Record<string, unknown>;
    expect(Object.keys(permission)[0]).toBe('*');
    expect(permission).toMatchObject({ '*': 'ask', read: 'allow', edit: 'allow', shell: { '*': 'allow', 'git push *': 'ask' }, external_directory: 'allow' });

    await main.api.invoke('sessions.approve', { id, itemId: approvals(items)[0]!.id, decision: 'once' });
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));
    expect(permissionAnswers(setup.machine)).toEqual(['once', 'once']);

    // Kept across a restart.
    await main.close();
    const again = await started(setup.machine, userDataDir);
    expect((await waitFor(again.api, 'settings', () => true)).approvals).toMatchObject({ writeElsewhere: 'allow', mcp: 'ask', ownPush: 'allow' });
  });

  it('tells the categories apart from the command, on a best-effort basis', async () => {
    // Asks, by category; each is answered "once" and the agent goes on.
    const asks: Array<[string, string, string?]> = [
      ['git push --force-with-lease', 'otherPush'],
      ['git push origin +HEAD', 'otherPush'],
      ['git push origin --delete old-branch', 'otherPush'],
      ['git push origin :old-branch', 'otherPush'],
      ['git push --tags', 'otherPush'],
      ['git push origin feature/other', 'otherPush'],
      ['git -C . push origin HEAD:main', 'otherPush', 'main'],
      ['cd sub && git push', 'ownPush'],
      ['gh pr merge --squash', 'forge'],
      ['gh issue create --title Bug', 'forge'],
      ['gh api repos/acme/billing-api/issues -f title=Bug', 'forge'],
      ['glab mr note 3 -m hi', 'forge'],
      ['gh pr create --fill', 'ownMergeRequest'],
      ['glab mr update --title "Better"', 'ownMergeRequest'],
      ['npm install -g typescript', 'system'],
      ['FOO=1 sudo make install', 'system'],
      ['brew install jq', 'system'],
      ['rm -rf /srv/other-project', 'writeElsewhere'],
      ['echo hi > /etc/motd', 'writeElsewhere'],
    ];
    // Allowed by Loom's policy, whatever the settings: answered without a card.
    // Plain commands around them, and redirections, don't stop that.
    const allowed = [
      'gh pr view 3',
      'gh api repos/acme/billing-api/pulls',
      'glab mr list',
      'gh pr checks',
      'gh auth status && glab ci status',
      'glab mr list | head -20',
      'cd sub && glab mr view 3',
      'gh pr view 3 --comments 2>&1',
      'glab issue view 5 2>/dev/null | cat',
      'glab api projects/1/merge_requests &>/dev/null | jq .',
    ];
    // One turn, so the test doesn't pay for Loom's after-turn lookups once per command.
    const setup = machineWith((checkout) => [{ chunks: [...asks.map(([command], i) => shell(command, checkout, `call_ask${i}`)), ...allowed.map((command, i) => shell(command, checkout, `call_ok${i}`)), 'Done.'] }]);
    const main = await started(setup.machine);
    // Ask for every category, so the ones allowed by default show too.
    for (const category of ['ownPush', 'ownMergeRequest'] as const) await main.api.invoke('settings.setApproval', { category, setting: 'ask' });
    const project = await main.api.invoke('projects.link', { path: setup.checkout });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Ship it' });
    // One subscription, as the renderer has: opening the conversation again would read the branch and diff again each time.
    let items: TranscriptItem[] = [];
    const unsubscribe = main.api.subscribe('transcript', (list) => (items = list), { sessionId: id });
    const seen: Array<[string, string | undefined, string?]> = [];
    for (let n = 0; n < asks.length; n++) {
      await until(() => approvals(items).length === n + 1);
      const card = approvals(items).at(-1)!;
      seen.push(card.defaultBranch ? [card.detail, card.category, card.defaultBranch] : [card.detail, card.category]);
      await main.api.invoke('sessions.approve', { id, itemId: card.id, decision: 'once' });
    }
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));
    unsubscribe();
    expect(seen).toEqual(asks);
    expect(approvals(items)).toHaveLength(asks.length);
    expect(permissionAnswers(setup.machine)).toEqual([...asks.map(() => 'once'), ...allowed.map(() => 'once')]);
  });

  it('decides each part of a command line: an allowed part never lets the rest through', async () => {
    const setup = machineWith((checkout) => [{ chunks: [shell('sudo true && git push origin HEAD:main', checkout), { permission: { ...shell('sudo true && git push origin HEAD:main', checkout).permission } }, 'Pushed.'] }]);
    const main = await started(setup.machine);
    await main.api.invoke('settings.setApproval', { category: 'system', setting: 'allow' });
    const project = await main.api.invoke('projects.link', { path: setup.checkout });
    const { id } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Ship it' });
    await waitFor(main.api, 'sessions', waitingOn(id, 'approval'));
    const items = await waitFor(main.api, 'transcript', (list) => approvals(list).length > 0, { sessionId: id });
    expect(approvals(items)).toMatchObject([{ category: 'otherPush', defaultBranch: 'main', detail: 'sudo true && git push origin HEAD:main' }]);
    // Approved once, with the whole command line shown: another ask for the same call goes through.
    await main.api.invoke('sessions.approve', { id, itemId: approvals(items)[0]!.id, decision: 'once' });
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));
    expect(permissionAnswers(setup.machine)).toEqual(['once', 'once']);
  });

  it('approves everything the agent asks in a Full access Session, a push to the default branch included, with no card', async () => {
    const setup = machineWith((checkout) => [{ chunks: [shell('git push origin HEAD:main', checkout, 'call_1'), shell('sudo make install', checkout, 'call_2'), write('/srv/elsewhere/notes.md'), 'Done.'] }]);
    const userDataDir = tempDir('loom-user-data-');
    const main = await started(setup.machine, userDataDir);
    const project = await main.api.invoke('projects.link', { path: setup.checkout });
    const { id, fullAccess } = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Ship it', approvalMode: 'full' });
    expect(fullAccess).toBe(true);
    await waitFor(main.api, 'sessions', waitingOn(id, 'finished'));
    expect(approvals(await waitFor(main.api, 'transcript', () => true, { sessionId: id }))).toEqual([]);
    expect(permissionAnswers(setup.machine)).toEqual(['once', 'once', 'once']);
    await main.close();
    // Kept with the Session.
    const again = await started(setup.machine, userDataDir);
    expect((await waitFor(again.api, 'sessions', session(id, () => true))).find((s) => s.id === id)?.fullAccess).toBe(true);
  });

  it('starts Sessions in the default Approval mode from Settings, Supervised until changed', async () => {
    const setup = machineWith([{ chunks: ['Done.'] }, { chunks: ['Done.'] }, { chunks: ['Done.'] }]);
    const userDataDir = tempDir('loom-user-data-');
    const main = await started(setup.machine, userDataDir);
    expect((await waitFor(main.api, 'settings', () => true)).approvalModeDefault).toBe('supervised');
    const project = await main.api.invoke('projects.link', { path: setup.checkout });
    const first = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'One' });
    expect(first.fullAccess).toBeUndefined();
    expect((await main.api.invoke('settings.setApprovalModeDefault', { mode: 'full' })).approvalModeDefault).toBe('full');
    const second = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Two' });
    expect(second.fullAccess).toBe(true);
    // A mode picked wins over the default.
    const third = await main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Three', approvalMode: 'supervised' });
    expect(third.fullAccess).toBeUndefined();
    await expect(main.api.invoke('settings.setApprovalModeDefault', { mode: 'yolo' as never })).rejects.toThrow('not an Approval mode');
    await expect(main.api.invoke('sessions.create', { projectId: project.id, workingCopy: 'worktree', prompt: 'Four', approvalMode: 'yolo' as never })).rejects.toThrow('not an Approval mode');
    await main.close();
    expect((await waitFor((await started(setup.machine, userDataDir)).api, 'settings', () => true)).approvalModeDefault).toBe('full');
  });

  it("works freely in a checkout Session's checkout folder, its working copy", async () => {
    const setup = machineWith([{ chunks: ['Done.'] }]);
    const { session: s } = await startSession(setup, 'checkout');
    expect(s.workingCopy.path).toBe(setup.checkout);
    const permission = configs(setup.machine)[0]!.permission as Record<string, Record<string, string>>;
    expect(permission.external_directory).toEqual({ '*': 'ask', [`${setup.checkout}/*`]: 'allow', [`${tempOf(setup.machine)}/*`]: 'allow' });
  });
});
