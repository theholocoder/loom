// The opt-in Forge contract suite: runs the user's real `gh` and `glab`
// against sandbox repositories, checks Loom reads their output, records it
// under recordings/, and checks seam A's scripted stand-in (stand-ins/
// forge-cli.mjs) prints the same shape. Skipped unless LOOM_FORGE_CONTRACT=1;
// see the README's "Forge contract suite". Never point it at a real project:
// it only reads, but it is meant for throwaway sandboxes with an open issue.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listIssues } from '../../src/main/projects/issues';
import type { BridgeCall, ExecResult } from '../../src/main/environments/exec';
import { FORGE_CLI, type ForgeKind } from '../../src/shared/api';

const enabled = process.env.LOOM_FORGE_CONTRACT === '1';
const sandboxes: Record<ForgeKind, string | undefined> = {
  github: process.env.LOOM_FORGE_CONTRACT_GITHUB,
  gitlab: process.env.LOOM_FORGE_CONTRACT_GITLAB,
};
const recordings = fileURLToPath(new URL('./recordings/', import.meta.url));
const standIn = fileURLToPath(new URL('../seam-a/stand-ins/forge-cli.mjs', import.meta.url));

function run(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ path: command, exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

/** Runs commands on this machine, as the bridge's `exec` would in the native Environment. */
const local: BridgeCall = async <T,>(_method: string, _timeoutMs: number, params?: unknown) => {
  const { command, args } = params as { command: string; args: string[] };
  return (await run(command, args)) as T;
};

/** The keys of the first item of a JSON list. */
const keysOf = (stdout: string) => Object.keys((JSON.parse(stdout) as Record<string, unknown>[])[0] ?? {}).sort();

for (const kind of ['github', 'gitlab'] as const) {
  const sandbox = sandboxes[kind];
  const cli = FORGE_CLI[kind];
  describe.skipIf(!enabled || !sandbox)(`${cli} against the sandbox ${sandbox ?? `(set LOOM_FORGE_CONTRACT_${kind.toUpperCase()})`}`, () => {
    const [host, ...path] = (sandbox ?? '').split('/');
    const forge = { state: 'available' as const, checking: false, kind, host, repository: path.join('/') };

    it('is signed in to the sandbox host', async () => {
      expect((await run(cli, ['auth', 'status', '--hostname', host!])).exitCode).toBe(0);
    });

    it('lists open issues Loom can read, which the stand-in prints in the same shape', async () => {
      const issues = await listIssues(local, forge);
      expect(issues.length, 'the sandbox needs at least one open issue').toBeGreaterThan(0);
      for (const issue of issues) {
        expect(Number.isInteger(issue.number) && issue.number > 0).toBe(true);
        expect(issue.url).toMatch(/^https:\/\//);
        expect(typeof issue.title).toBe('string');
        expect(typeof issue.body).toBe('string');
      }

      // The same command, raw, recorded.
      const args =
        kind === 'github'
          ? ['issue', 'list', '--repo', `${host}/${forge.repository}`, '--state', 'open', '--json', 'number,title,body,url']
          : ['issue', 'list', '--repo', `https://${host}/${forge.repository}`, '--output', 'json'];
      const real = await run(cli, args);
      mkdirSync(recordings, { recursive: true });
      writeFileSync(join(recordings, `${cli}-issue-list.json`), JSON.stringify({ args, output: JSON.parse(real.stdout) }, null, 2) + '\n');

      const scripts = mkdtempSync(join(tmpdir(), 'loom-forge-contract-'));
      const script = join(scripts, `${cli}.json`);
      writeFileSync(script, JSON.stringify({ signedInHosts: [host], issues: [{ number: 1, title: 'T', body: 'B', url: 'https://example.org/1' }] }));
      const scripted = await run(process.execPath, [standIn, script, ...args]);
      // gh prints exactly the fields asked for; glab prints many, of which the stand-in fakes those Loom reads.
      if (kind === 'github') expect(keysOf(scripted.stdout)).toEqual(keysOf(real.stdout));
      else expect(keysOf(real.stdout)).toEqual(expect.arrayContaining(keysOf(scripted.stdout)));
    });
  });
}
