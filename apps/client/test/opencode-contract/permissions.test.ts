// The opt-in real OpenCode contract suite: runs Loom's ACP adapter with its
// OpenCode profile against the user's own installed, signed-in `opencode`,
// to catch protocol drift and confirm the approval rules Loom passes in
// OPENCODE_CONFIG_CONTENT ask what seam A's stand-in assumes. Skipped unless
// LOOM_OPENCODE_CONTRACT=1; see the README's "Real OpenCode contract suite".
// It spends a few prompts of the user's default model, in throwaway git
// repositories under the temp directory; nothing it asks is ever approved.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../../src/main/agents/acp-adapter';
import type { AgentEvent, ApprovalAction } from '../../src/main/agents/adapter';
import { OPENCODE_ACP } from '../../src/main/agents/opencode';
import { local } from './local';
import { classifyApproval } from '../../src/main/sessions/approvals';
import { DEFAULT_APPROVALS } from '../../src/shared/api';

const enabled = process.env.LOOM_OPENCODE_CONTRACT === '1';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A git repository with one commit on `main`, in a new folder. */
function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loom-opencode-contract-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', ...args]);
  git('init', '--quiet', '--initial-branch=main');
  git('commit', '--quiet', '--allow-empty', '-m', 'Start');
  return dir;
}

/**
 * Prompts a real OpenCode session in `workingCopy` and rejects everything it
 * asks; resolves with what it asked, once the run ends.
 */
async function run(workingCopy: string, prompt: string): Promise<ApprovalAction[]> {
  const asked: ApprovalAction[] = [];
  let settle!: (event: AgentEvent) => void;
  const ended = new Promise<AgentEvent>((resolve) => (settle = resolve));
  const adapter = new AcpAdapter(OPENCODE_ACP, '0.0.0-contract');
  // A temp directory of its own, so the repository (under the OS one) isn't in it.
  const tempDir = join(homedir(), '.cache', 'loom-contract-temp');
  const agent = await adapter.open({
    environment: local,
    workingCopy,
    tempDir,
    approvals: DEFAULT_APPROVALS,
    onEvent: (event) => {
      if (event.type === 'approval-asked') {
        asked.push(event.action);
        agent.answer(event.requestId, { kind: 'approval', approved: false });
      }
      if (event.type === 'run-settled' || event.type === 'run-failed' || event.type === 'closed') settle(event);
    },
  });
  cleanups.push(() => void agent.close());
  agent.prompt({ text: prompt, files: [] });
  const outcome = await ended;
  if (outcome.type !== 'run-settled') throw new Error(`the run ended with ${JSON.stringify(outcome)}`);
  return asked;
}

describe.skipIf(!enabled)('real OpenCode: approval rules', () => {
  it('asks before a shell command under the `shell` rule, and a reject ends the turn', async () => {
    const workingCopy = repository();
    const asked = await run(workingCopy, 'Run exactly this shell command once, with your shell tool, and nothing else: git push --force origin HEAD:main . Then reply with one word: done.');
    expect(asked).toHaveLength(1);
    const [action] = asked;
    expect(action).toMatchObject({ tool: 'shell', toolKind: 'execute', extension: false });
    expect(action!.command).toContain('git push --force origin HEAD:main');
    expect(classifyApproval(action!, { workingCopy, tempDir: '/nowhere', currentBranch: 'main', defaultBranch: 'main' })).toEqual([{ category: 'otherPush', defaultBranch: 'main' }]);
  });

  it('asks before writing outside the working copy, and names the path', async () => {
    const workingCopy = repository();
    const outside = join(homedir(), `loom-contract-${process.pid}.txt`);
    cleanups.push(() => rmSync(outside, { force: true }));
    const asked = await run(workingCopy, `Use your write tool (not the shell) to create the file ${outside} containing the word hi. Then reply with one word: done.`);
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(asked[0]).toMatchObject({ toolKind: 'edit', paths: [outside], extension: false });
    expect(classifyApproval(asked[0]!, { workingCopy, tempDir: '/nowhere' })).toEqual([{ category: 'writeElsewhere' }]);
    expect(existsSync(outside)).toBe(false);
  });

  it('works in the working copy without asking', async () => {
    const workingCopy = repository();
    const asked = await run(workingCopy, 'Use your write tool to create the file notes.txt in the current folder containing the word hi, then run `git status --short` with your shell tool. Then reply with one word: done.');
    expect(asked).toEqual([]);
    expect(existsSync(join(workingCopy, 'notes.txt'))).toBe(true);
  });
});
