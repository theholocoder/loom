// Listing a Project's open issues for the issue picker, through its Forge's
// CLI and the user's login (ADR 0002): `gh issue list` or `glab issue list`
// on the repository `origin` is on. Any open issue, not only the user's.
import type { ForgeStatus, Issue } from '../../shared/api';
import { FORGE_CLI } from '../../shared/api';
import { exec, type BridgeCall } from '../environments/exec';

const ISSUE_LIST_TIMEOUT_MS = 20_000;

export async function listIssues(call: BridgeCall, forge: ForgeStatus, search?: string): Promise<Issue[]> {
  if (forge.state === 'unknown') throw new Error("Loom hasn't checked this Project's Forge yet.");
  if (forge.state !== 'available' || !forge.kind || !forge.host || !forge.repository) throw new Error("Issues need the Project's Forge, which is off.");
  const query = search?.trim() ? ['--search', search.trim()] : [];
  const cli = FORGE_CLI[forge.kind];
  const args =
    forge.kind === 'github'
      ? ['issue', 'list', '--repo', `${forge.host}/${forge.repository}`, '--state', 'open', '--json', 'number,title,body,url', '--limit', '100', ...query]
      : ['issue', 'list', '--repo', `https://${forge.host}/${forge.repository}`, '--output', 'json', '--per-page', '100', ...query];
  const result = await exec(call, cli, args, ISSUE_LIST_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new Error(`${cli} issue list exited with code ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
  }
  let listed: unknown;
  try {
    listed = JSON.parse(result.stdout || '[]');
  } catch {
    throw new Error(`${cli} issue list printed something other than JSON: ${result.stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(listed)) throw new Error(`${cli} issue list printed something other than a list.`);
  return listed
    .filter((item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) =>
      forge.kind === 'github'
        ? { number: Number(item.number), title: String(item.title ?? ''), body: String(item.body ?? ''), url: String(item.url ?? '') }
        : { number: Number(item.iid), title: String(item.title ?? ''), body: String(item.description ?? ''), url: String(item.web_url ?? '') },
    )
    // Skips what Loom couldn't link a Session to.
    .filter((issue) => Number.isInteger(issue.number) && issue.number > 0 && /^https?:\/\//i.test(issue.url));
}
