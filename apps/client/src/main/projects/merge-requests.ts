// Finding a Session's Merge request on its Project's Forge, through the
// Forge's CLI and the user's login (ADR 0002): the open one whose source
// branch is a given branch (`gh pr list --head`, `glab mr list
// --source-branch`), or one by its number (`gh pr view`, `glab mr view`).
// Loom never creates or changes a Merge request itself.
import { FORGE_CLI, type ForgeLink, type ForgeStatus } from '../../shared/api';
import { exec, type BridgeCall } from '../environments/exec';

const MERGE_REQUEST_TIMEOUT_MS = 20_000;

export type MergeRequestState = 'open' | 'merged' | 'closed';

/** A Merge request as the Forge has it now. */
export interface FoundMergeRequest extends ForgeLink {
  state: MergeRequestState;
  /** Its source branch. */
  branch: string;
}

/** The open Merge request whose source branch is `branch`, if there is one; the lowest-numbered of several. */
export async function findMergeRequest(call: BridgeCall, forge: ForgeStatus, workingCopy: string, branch: string): Promise<FoundMergeRequest | undefined> {
  const { kind, repo } = forgeOf(forge);
  const args =
    kind === 'github'
      ? ['pr', 'list', ...repo, '--head', branch, '--state', 'open', '--json', 'number,url,state,headRefName', '--limit', '20']
      : ['mr', 'list', '--source-branch', branch, '--output', 'json', '--per-page', '20'];
  const listed = await run(call, forge, args, workingCopy);
  if (!Array.isArray(listed)) throw new Error(`${FORGE_CLI[kind]} ${args[0]} list printed something other than a list.`);
  return listed
    .map((item) => mergeRequestOf(kind, item))
    .filter((found): found is FoundMergeRequest => !!found && found.state === 'open' && found.branch === branch)
    .sort((a, b) => a.number - b.number)[0];
}

/** The Merge request numbered `number`, in whatever state; rejects when the Forge has none. */
export async function viewMergeRequest(call: BridgeCall, forge: ForgeStatus, workingCopy: string, number: number): Promise<FoundMergeRequest> {
  const { kind, repo } = forgeOf(forge);
  const args = kind === 'github' ? ['pr', 'view', String(number), ...repo, '--json', 'number,url,state,headRefName'] : ['mr', 'view', String(number), '--output', 'json'];
  const found = mergeRequestOf(kind, await run(call, forge, args, workingCopy));
  if (!found || found.number !== number) throw new Error(`${FORGE_CLI[kind]} ${args[0]} view printed something unexpected.`);
  return found;
}

function forgeOf(forge: ForgeStatus): { kind: 'github' | 'gitlab'; repo: string[] } {
  if (forge.state === 'unknown') throw new Error("Loom hasn't checked this Project's Forge yet.");
  if (forge.state !== 'available' || !forge.kind || !forge.host || !forge.repository) throw new Error("Merge requests need the Project's Forge, which is off.");
  // glab resolves the repository from the working copy it runs in, knowing the SSH/web host mapping.
  return { kind: forge.kind, repo: forge.kind === 'github' ? ['--repo', `${forge.host}/${forge.repository}`] : [] };
}

/** Runs the Forge's CLI, in the working copy for glab, and parses the JSON it prints. */
async function run(call: BridgeCall, forge: ForgeStatus, args: string[], workingCopy: string): Promise<unknown> {
  const cli = FORGE_CLI[forge.kind!];
  const result = await exec(call, cli, args, MERGE_REQUEST_TIMEOUT_MS, forge.kind === 'gitlab' ? workingCopy : undefined);
  const what = `${cli} ${args[0]} ${args[1]}`;
  if (result.exitCode !== 0) throw new Error(`${what} exited with code ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
  try {
    return JSON.parse(result.stdout || 'null');
  } catch {
    throw new Error(`${what} printed something other than JSON: ${result.stdout.slice(0, 200)}`);
  }
}

/** A Merge request in the JSON `gh` or `glab` prints; undefined if Loom couldn't link to it. */
function mergeRequestOf(kind: 'github' | 'gitlab', value: unknown): FoundMergeRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const raw =
    kind === 'github'
      ? { number: item.number, url: item.url, state: String(item.state ?? '').toLowerCase(), branch: item.headRefName }
      : { number: item.iid, url: item.web_url, state: item.state === 'opened' ? 'open' : String(item.state ?? ''), branch: item.source_branch };
  const number = Number(raw.number);
  const url = String(raw.url ?? '');
  if (!Number.isInteger(number) || number <= 0 || !/^https?:\/\//i.test(url)) return undefined;
  const state: MergeRequestState = raw.state === 'open' ? 'open' : raw.state === 'merged' ? 'merged' : 'closed';
  return { number, url, state, branch: String(raw.branch ?? '') };
}
