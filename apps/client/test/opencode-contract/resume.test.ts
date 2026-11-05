// The opt-in real OpenCode contract suite, for resuming: the user's own
// OpenCode takes up a conversation by its `ses_…` id in a new process, as
// seam A's stand-in assumes, and turns down one it doesn't know. Skipped
// unless LOOM_OPENCODE_CONTRACT=1. It sends no prompt, so spends nothing; it
// leaves one empty session in the user's OpenCode, in a throwaway repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../../src/main/agents/acp-adapter';
import { ResumeRefused, type AgentEvent, type OpenOptions } from '../../src/main/agents/adapter';
import { OPENCODE_ACP } from '../../src/main/agents/opencode';
import { DEFAULT_APPROVALS, type AgentConfig } from '../../src/shared/api';
import { local } from './local';

const enabled = process.env.LOOM_OPENCODE_CONTRACT === '1';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe.skipIf(!enabled)('real OpenCode: resuming a conversation', () => {
  it('takes up a conversation in a new process by its id, and turns down one it does not know', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-opencode-resume-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', dir]);
    const configs: AgentConfig[] = [];
    const options: OpenOptions = {
      environment: local,
      workingCopy: dir,
      tempDir: tmpdir(),
      approvals: DEFAULT_APPROVALS,
      onEvent: (event: AgentEvent) => void (event.type === 'config' && configs.push(event.config)),
    };
    const adapter = new AcpAdapter(OPENCODE_ACP, '0.0.0-contract');
    const first = await adapter.open(options);
    await first.close();

    configs.length = 0;
    const resumed = await adapter.open({ ...options, resume: first.id });
    cleanups.push(() => resumed.close());

    expect(resumed.id).toBe(first.id);
    expect(configs.at(-1)?.models.length).toBeGreaterThan(0);
    await expect(adapter.open({ ...options, resume: 'ses_loomcontractunknown' })).rejects.toBeInstanceOf(ResumeRefused);
  });
});
