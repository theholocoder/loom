// The opt-in real OpenCode contract suite, for Loom's link tools: the user's
// own OpenCode, given Loom's MCP server (the built bridge, run as `mcp`),
// reports a call of `link_merge_request` as seam A's stand-in does: a tool
// call of its own, or one its Code Mode script made, named in the script's
// ended call. Skipped unless LOOM_OPENCODE_CONTRACT=1; needs the bridge built
// (`pnpm bridge:build`). It spends one prompt of the user's default model, in
// a throwaway git repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../../src/main/agents/acp-adapter';
import type { AgentEvent } from '../../src/main/agents/adapter';
import { OPENCODE_ACP } from '../../src/main/agents/opencode';
import { bridgeBinaryPath } from '../../src/main/environments/bridge-path';
import { DEFAULT_APPROVALS } from '../../src/shared/api';
import { local } from './local';

const enabled = process.env.LOOM_OPENCODE_CONTRACT === '1';
const bridge = bridgeBinaryPath(fileURLToPath(new URL('../../../../bridge/dist', import.meta.url)));

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe.skipIf(!enabled)('real OpenCode: link tools', () => {
  it('reports a call of link_merge_request, directly or from a Code Mode script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-opencode-link-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('git', ['-C', dir, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', 'init', '--quiet', '--initial-branch=main']);
    const events: AgentEvent[] = [];
    let settle!: (event: AgentEvent) => void;
    const ended = new Promise<AgentEvent>((resolve) => (settle = resolve));
    const agent = await new AcpAdapter(OPENCODE_ACP, '0.0.0-contract').open({
      environment: local,
      workingCopy: dir,
      tempDir: tmpdir(),
      approvals: DEFAULT_APPROVALS,
      loomTools: { command: bridge, args: ['mcp'] },
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'run-settled' || event.type === 'run-failed' || event.type === 'closed') settle(event);
      },
    });
    cleanups.push(() => agent.close());

    agent.prompt({ text: "Link Merge request 12 to this Loom session with Loom's link_merge_request tool. Do nothing else, then reply with one word: done.", files: [] });
    expect((await ended).type).toBe('run-settled');

    const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool-started' | 'tool-updated' }> => e.type === 'tool-started' || e.type === 'tool-updated');
    const direct = tools.some((e) => /^loom[_.]link_merge_request$/.test(e.title ?? '') && /"number":\s*12/.test(e.input ?? ''));
    const scripted = tools.flatMap((e) => e.scriptCalls ?? []).some((c) => c.name === 'loom.link_merge_request' && c.status === 'completed' && /"number":\s*12/.test(c.input ?? ''));
    expect(direct || scripted).toBe(true);
  });
});
