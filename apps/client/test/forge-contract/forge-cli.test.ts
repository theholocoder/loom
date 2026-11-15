// The opt-in Forge contract suite: runs the user's real `gh` and `glab`
// against sandbox repositories, checks Loom reads their output, records it
// under recordings/, and checks seam A's scripted stand-in (stand-ins/
// forge-cli.mjs) prints the same shape: the issue picker's list, the Issue
// Panel's read of one issue, and the Merge request Panel's read of one. Skipped unless LOOM_FORGE_CONTRACT=1;
// see the README's "Forge contract suite". Never point it at a real project:
// it only reads, but it is meant for throwaway sandboxes with an open issue
// and a Merge request.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listIssues, readIssue } from '../../src/main/projects/issues';
import { readMergeRequestDetails } from '../../src/main/projects/merge-request-details';
import type { BridgeCall, ExecResult } from '../../src/main/environments/exec';
import { FORGE_CLI, type ForgeKind } from '../../src/shared/api';

const enabled = process.env.LOOM_FORGE_CONTRACT === '1';
const sandboxes: Record<ForgeKind, string | undefined> = {
  github: process.env.LOOM_FORGE_CONTRACT_GITHUB,
  gitlab: process.env.LOOM_FORGE_CONTRACT_GITLAB,
};
const recordings = fileURLToPath(new URL('./recordings/', import.meta.url));
const standIn = fileURLToPath(new URL('../seam-a/stand-ins/forge-cli.mjs', import.meta.url));

function run(command: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ path: command, exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

/** What `local` ran, and what each printed. */
const ran: { args: string[]; stdout: string }[] = [];

/** Runs commands on this machine, as the bridge's `exec` would in the native Environment. */
const local: BridgeCall = async <T,>(_method: string, _timeoutMs: number, params?: unknown) => {
  const { command, args, cwd } = params as { command: string; args: string[]; cwd?: string };
  const result = await run(command, args, cwd);
  ran.push({ args, stdout: result.stdout });
  return result as T;
};

/** Runs the stand-in for `cli` on `args`, scripted with `script`. */
function standInRun(cli: string, script: unknown, args: string[]): Promise<ExecResult> {
  const path = join(mkdtempSync(join(tmpdir(), 'loom-forge-contract-')), `${cli}.json`);
  writeFileSync(path, JSON.stringify(script));
  return run(process.execPath, [standIn, path, ...args]);
}

function record(name: string, args: string[], stdout: string) {
  mkdirSync(recordings, { recursive: true });
  writeFileSync(join(recordings, name), JSON.stringify({ args, output: JSON.parse(stdout) }, null, 2) + '\n');
}

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
      record(`${cli}-issue-list.json`, args, real.stdout);

      const scripted = await standInRun(cli, { signedInHosts: [host], issues: [{ number: 1, title: 'T', body: 'B', url: 'https://example.org/1' }] }, args);
      // gh prints exactly the fields asked for; glab prints many, of which the stand-in fakes those Loom reads.
      if (kind === 'github') expect(keysOf(scripted.stdout)).toEqual(keysOf(real.stdout));
      else expect(keysOf(real.stdout)).toEqual(expect.arrayContaining(keysOf(scripted.stdout)));
    });

    it('reads an issue as its Panel shows it, which the stand-in prints in the same shape', async () => {
      const [first] = await listIssues(local, forge);
      expect(first, 'the sandbox needs at least one open issue').toBeDefined();
      // glab finds the repository from the working copy's remote, as in a Session's.
      const workingCopy = mkdtempSync(join(tmpdir(), 'loom-forge-contract-'));
      await run('git', ['init', '-q'], workingCopy);
      await run('git', ['remote', 'add', 'origin', `https://${host}/${forge.repository}.git`], workingCopy);

      ran.length = 0;
      const issue = await readIssue(local, forge, workingCopy, first!.number);
      expect(issue).toMatchObject({ number: first!.number, url: first!.url, title: first!.title, state: 'open' });
      expect(issue.labels.every((label) => typeof label === 'string')).toBe(true);
      expect(typeof issue.author).toBe('string');
      expect(typeof issue.at).toBe('number');
      expect(Number.isInteger(issue.comments)).toBe(true);
      expect(typeof issue.body).toBe('string');

      // What the read printed, recorded, then the stand-in's answer to the same command.
      const read = ran.find(({ args }) => args[0] === 'api')!;
      record(`${cli}-issue.json`, read.args, read.stdout);
      const scripted = await standInRun(cli, { signedInHosts: [host], issues: [{ number: first!.number, title: 'T', body: 'B', url: 'https://example.org/1', labels: ['bug'] }] }, read.args);
      // Both APIs print many fields, of which the stand-in fakes those Loom reads.
      expect(Object.keys(JSON.parse(read.stdout) as object)).toEqual(expect.arrayContaining(Object.keys(JSON.parse(scripted.stdout) as object)));
    });

    it("reads a Merge request as its Panel shows it, description and reviewers too, which the stand-in prints in the same shape", async () => {
      const list =
        kind === 'github'
          ? await run(cli, ['pr', 'list', '--repo', `${host}/${forge.repository}`, '--state', 'all', '--limit', '1', '--json', 'number'])
          : await run(cli, ['mr', 'list', '--repo', `https://${host}/${forge.repository}`, '--all', '--per-page', '1', '--output', 'json']);
      const [first] = JSON.parse(list.stdout) as { number?: number; iid?: number }[];
      expect(first, 'the sandbox needs at least one Merge request').toBeDefined();
      const number = (first!.number ?? first!.iid)!;
      // glab finds the repository from the working copy's remote, as in a Session's.
      const workingCopy = mkdtempSync(join(tmpdir(), 'loom-forge-contract-'));
      await run('git', ['init', '-q'], workingCopy);
      await run('git', ['remote', 'add', 'origin', `https://${host}/${forge.repository}.git`], workingCopy);

      ran.length = 0;
      const details = await readMergeRequestDetails(local, forge, workingCopy, number);
      expect(details.number).toBe(number);
      expect(typeof details.title).toBe('string');
      expect(typeof details.description).toBe('string');
      expect(details.reviewers.every((reviewer) => typeof reviewer === 'string' && reviewer !== details.author)).toBe(true);

      // What the Panel's read printed, recorded, then the stand-in's answer to the same command.
      const read = ran.find(({ args }) => (kind === 'github' ? args[1] === 'graphql' : args[0] === 'mr' && args[1] === 'view'))!;
      record(`${cli}-merge-request-details.json`, read.args, read.stdout);
      const scripted = await standInRun(cli, { signedInHosts: [host], mergeRequests: [{ number, url: 'https://example.org/1', branch: 'b', description: 'D', reviewers: ['r'] }] }, read.args);
      const merge = (stdout: string) => {
        const json = JSON.parse(stdout) as { data?: { repository: { pullRequest: Record<string, unknown> } } } & Record<string, unknown>;
        return kind === 'github' ? json.data!.repository.pullRequest : json;
      };
      const realKeys = Object.keys(merge(read.stdout)).sort();
      const scriptedKeys = Object.keys(merge(scripted.stdout)).sort();
      // gh prints exactly the fields asked for, which the stand-in has among those Babysit asks for; glab prints many, of which the stand-in fakes those Loom reads.
      if (kind === 'github') expect(scriptedKeys).toEqual(expect.arrayContaining(realKeys));
      else expect(realKeys).toEqual(expect.arrayContaining(scriptedKeys));
    });
  });
}
