// The opt-in real OpenCode contract suite, for models and Effort: Loom's
// ACP adapter reads the user's own OpenCode's `model` and `effort` config
// options and switches them, as seam A's stand-in assumes. Skipped unless
// LOOM_OPENCODE_CONTRACT=1. It sends no prompt, so spends nothing; it leaves
// one empty session in the user's OpenCode, in a throwaway repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../../src/main/agents/acp-adapter';
import type { AgentEvent } from '../../src/main/agents/adapter';
import { OPENCODE_ACP } from '../../src/main/agents/opencode';
import { DEFAULT_APPROVALS, type AgentConfig } from '../../src/shared/api';
import { local } from './local';

const enabled = process.env.LOOM_OPENCODE_CONTRACT === '1';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe.skipIf(!enabled)('real OpenCode: model and Effort config options', () => {
  it('offers its models as provider/model, and switches to one taking Effort levels and to one of its levels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-opencode-models-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', dir]);
    const configs: AgentConfig[] = [];
    const agent = await new AcpAdapter(OPENCODE_ACP, '0.0.0-contract').open({
      environment: local,
      workingCopy: dir,
      tempDir: tmpdir(),
      approvals: DEFAULT_APPROVALS,
      onEvent: (event: AgentEvent) => void (event.type === 'config' && configs.push(event.config)),
    });
    cleanups.push(() => void agent.close());

    const first = configs.at(-1)!;
    expect(first.models.length).toBeGreaterThan(0);
    for (const model of first.models) expect(model.id).toMatch(/^[^/]+\/.+/);
    expect(first.models.map((m) => m.id)).toContain(first.model);

    // Any model taking Effort levels will do: switch to it, then to its last level that isn't the default.
    let switched: AgentConfig | undefined;
    for (const { id } of first.models) {
      await agent.configure({ model: id });
      if (configs.at(-1)!.efforts.length > 0) {
        switched = configs.at(-1);
        break;
      }
    }
    if (!switched) return; // the user's providers have no model with Effort levels
    expect(switched.efforts).toContain('default');
    expect(switched.effort).toBe('default');
    const level = switched.efforts.filter((e) => e !== 'default').at(-1)!;
    await agent.configure({ effort: level });
    expect(configs.at(-1)).toMatchObject({ model: switched.model, effort: level });
  });
});
