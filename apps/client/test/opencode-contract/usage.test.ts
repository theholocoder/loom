// The opt-in real OpenCode contract suite, for usage (ADR 0012): the user's
// own OpenCode lists its sessions with their usage, through
// `opencode api --standalone session.list`, as seam A's stand-in assumes.
// Skipped unless LOOM_OPENCODE_CONTRACT=1. It only reads: it sends no prompt
// and starts no session.
import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { openCodeUsage } from '../../src/main/agents/opencode-usage';
import type { BridgeCall, ExecResult } from '../../src/main/environments/exec';

const enabled = process.env.LOOM_OPENCODE_CONTRACT === '1';

/** Runs `exec` on this machine, as the bridge's would in the native Environment. */
const call: BridgeCall = async <T,>(method: string, _timeoutMs: number, params?: unknown): Promise<T> => {
  if (method !== 'exec') throw new Error(`unexpected bridge method ${method}`);
  const { command, args, timeoutMs } = params as { command: string; args: string[]; timeoutMs: number };
  return new Promise<T>((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ path: command, exitCode, stdout, stderr } satisfies ExecResult as T);
    });
  });
};

describe.skipIf(!enabled)("real OpenCode: its sessions' usage", () => {
  it('lists its sessions, newest change first, each with when it changed', async () => {
    const sessions = await openCodeUsage.conversations(call);

    // A user who runs this suite has used OpenCode at least once.
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.id).toMatch(/^ses_/);
      expect(session.updatedAt).toBeGreaterThan(0);
    }
    const updated = sessions.map((s) => s.updatedAt);
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
  });

  it('lists only what changed since a time, when given one', async () => {
    const all = await openCodeUsage.conversations(call);
    const since = all[Math.min(2, all.length - 1)]!.updatedAt;

    const recent = await openCodeUsage.conversations(call, since);

    expect(recent.map((s) => s.id)).toEqual(all.filter((s) => s.updatedAt >= since).map((s) => s.id));
  });

  it("lists a session's steps, each with when it completed, its model, tokens and cost, and those completed since a time", async () => {
    const sessions = await openCodeUsage.conversations(call);
    let steps: Awaited<ReturnType<typeof openCodeUsage.steps>> = [];
    let id = '';
    for (const session of sessions) {
      steps = await openCodeUsage.steps(call, session.id);
      id = session.id;
      if (steps.length >= 2) break;
    }
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.id).toMatch(/^msg_/);
      expect(step.at).toBeGreaterThan(0);
      expect(step.model).toMatch(/^[^/]+\/.+/);
      expect(Object.values(step.tokens).every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
      expect(step.cost).toBeGreaterThanOrEqual(0);
    }
    const since = Math.max(...steps.map((s) => s.at));
    expect((await openCodeUsage.steps(call, id, since)).map((s) => s.id)).toEqual(steps.filter((s) => s.at >= since).map((s) => s.id));
  });
});
