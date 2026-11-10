// The opt-in real OpenCode contract suite, for commands: the user's own
// OpenCode announces its commands over ACP once a session is up, the
// Project's own among them, as seam A's stand-in assumes. Skipped unless
// LOOM_OPENCODE_CONTRACT=1. It sends no prompt, so spends nothing; it leaves
// one empty session in the user's OpenCode, in a throwaway repository.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../../src/main/agents/acp-adapter';
import type { AgentEvent } from '../../src/main/agents/adapter';
import { OPENCODE_ACP } from '../../src/main/agents/opencode';
import { DEFAULT_APPROVALS, type AgentCommand } from '../../src/shared/api';
import { local } from './local';

const enabled = process.env.LOOM_OPENCODE_CONTRACT === '1';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe.skipIf(!enabled)('real OpenCode: commands', () => {
  it("announces its commands once a session is up, the Project's own among them", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-opencode-commands-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', dir]);
    mkdirSync(join(dir, '.opencode', 'command'), { recursive: true });
    writeFileSync(join(dir, '.opencode', 'command', 'loom-contract.md'), '---\ndescription: A contract command\n---\nSay hi $ARGUMENTS\n');
    let announced: AgentCommand[] | undefined;
    const agent = await new AcpAdapter(OPENCODE_ACP, '0.0.0-contract').open({
      environment: local,
      workingCopy: dir,
      tempDir: tmpdir(),
      approvals: DEFAULT_APPROVALS,
      onEvent: (event: AgentEvent) => void (event.type === 'commands' && (announced = event.commands)),
    });
    cleanups.push(() => agent.close());

    const deadline = Date.now() + 10_000;
    while (!announced && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(announced).toContainEqual({ kind: 'command', name: 'loom-contract', description: 'A contract command' });
    expect(announced?.map((c) => c.name)).toContain('compact');
  });
});
