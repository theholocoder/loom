// Detecting a checkout's Forge through its Environment's bridge: which Forge
// `origin` is on (`git remote get-url origin`), and whether that Forge's CLI
// is installed and signed in to its host (`gh`/`glab auth status --hostname`).
// Loom reaches the Forge only through that login (ADR 0002).
import { FORGE_CLI, type ForgeKind, type ForgeStatus } from '../../shared/api';
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';

export const GIT_TIMEOUT_MS = 10_000;
const AUTH_STATUS_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 8_000;

type RepoView = { kind: 'found'; host: string; repository: string } | { kind: 'missing' } | { kind: 'error'; error: string };

/** What `glab repo view --output json` says of the checkout's repository, run in it. */
async function glabRepoView(call: BridgeCall, checkoutPath: string): Promise<RepoView> {
  let result: ExecResult;
  try {
    result = await exec(call, 'glab', ['repo', 'view', '--output', 'json'], PROBE_TIMEOUT_MS, checkoutPath);
  } catch (error) {
    if (isNotFound(error)) return { kind: 'missing' };
    return { kind: 'error', error: `glab repo view failed: ${(error as Error).message}` };
  }
  if (result.exitCode !== 0) return { kind: 'error', error: (result.stderr || result.stdout).trim() || `glab repo view exited with code ${result.exitCode}` };
  try {
    const view = JSON.parse(result.stdout) as { path_with_namespace?: unknown; web_url?: unknown };
    const host = new URL(String(view.web_url)).host.toLowerCase();
    const repository = String(view.path_with_namespace ?? '');
    if (host && repository) return { kind: 'found', host, repository };
  } catch {
    // falls through
  }
  return { kind: 'error', error: `glab repo view printed something unexpected: ${result.stdout.slice(0, 200)}` };
}

export async function detectForge(call: BridgeCall, checkoutPath: string): Promise<Omit<ForgeStatus, 'checking'>> {
  let remote: ExecResult;
  try {
    remote = await exec(call, 'git', ['-C', checkoutPath, 'remote', 'get-url', 'origin'], GIT_TIMEOUT_MS);
  } catch (error) {
    return { state: 'error', error: `git remote get-url origin failed: ${(error as Error).message}` };
  }
  // git exits with 2 when the remote doesn't exist.
  if (remote.exitCode === 2) return { state: 'no-remote' };
  if (remote.exitCode !== 0) {
    return { state: 'error', error: `git remote get-url origin exited with code ${remote.exitCode}: ${(remote.stderr || remote.stdout).trim()}` };
  }
  const url = remote.stdout.trim();
  const parsed = parseRemote(url);
  if (!parsed) return { state: 'unsupported', remote: url };
  const kind = forgeKind(parsed.host);
  const host = parsed.host;
  const repository = parsed.repository;
  if (!kind || kind === 'gitlab') {
    // glab resolves the repository from the checkout, which copes with a
    // GitLab reached over a different (SSH) host than its web one.
    const repo = await glabRepoView(call, checkoutPath);
    // glab just talked to the host, so it's signed in.
    if (repo.kind === 'found') return { state: 'available', kind: 'gitlab', host: repo.host, repository: repo.repository, remote: url };
    if (!kind) {
      if (repo.kind === 'missing') return { state: 'unsupported', remote: url, host: parsed.host };
      return { state: 'unsupported', remote: url, host: parsed.host, error: repo.error };
    }
  }

  const found = { kind, host, repository, remote: url };
  const cli = FORGE_CLI[kind];
  let status: ExecResult;
  try {
    status = await exec(call, cli, ['auth', 'status', '--hostname', host], AUTH_STATUS_TIMEOUT_MS);
  } catch (error) {
    if (isNotFound(error)) return { ...found, state: 'cli-missing' };
    return { ...found, state: 'error', error: `${cli} auth status failed: ${(error as Error).message}` };
  }
  const output = `${status.stdout}\n${status.stderr}`.trim();
  if (authState(output, host) === 'signed-out') return { ...found, state: 'signed-out', error: output || undefined };
  return { ...found, state: 'available' };
}

/**
 * Whether `gh`/`glab auth status --hostname <host>` says it's signed in to
 * host. Both write to stderr, and exit codes vary across versions (some glab
 * exit 0 when signed out, or 1 on any warning), so the text decides: a "Logged
 * in to <host>" line means signed in, then a known signed-out phrase or a
 * failure line for host means signed out. Anything else counts as signed in,
 * so the feature stays on and listing issues surfaces the real error.
 */
export function authState(output: string, host: string): 'signed-in' | 'signed-out' {
  const h = escapeRegExp(host);
  if (new RegExp(`logged in to ${h}\\b`, 'i').test(output) && !/not logged in/i.test(output)) return 'signed-in';
  if (/has not been authenticated|not logged in|not authenticated|no token|\b401\b|unauthorized/i.test(output)) return 'signed-out';
  if (new RegExp(`^\\s*[x✗×]\\s+${h}\\b`, 'im').test(output)) return 'signed-out';
  return 'signed-in';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The host and repository path of a remote URL in any form git accepts for a
 * network remote: `https://host/owner/repo.git`, `ssh://git@host:22/owner/repo`
 * or scp-like `git@host:owner/repo.git`. Local paths and `file://` give none.
 */
function parseRemote(url: string): { host: string; repository: string } | undefined {
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.protocol === 'file:' || !parsed.hostname) return undefined;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else {
    // scp-like syntax; a one-letter "host" is a Windows drive (C:\code\repo).
    const scp = /^(?:[^@/]+@)?([^/:]{2,}):(.+)$/.exec(url);
    if (!scp) return undefined;
    host = scp[1]!;
    path = scp[2]!;
  }
  const repository = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  return repository ? { host: host.toLowerCase(), repository } : undefined;
}

/**
 * GitHub and GitLab, by host: their public hosts, and self-hosted instances
 * named after them (`github.acme.com`, `gitlab.example.org`).
 */
function forgeKind(host: string): ForgeKind | undefined {
  // Any hyphen-separated word of a label: `gitlab-ssh.acme.net`, `ssh-gitlab.x.y`.
  const words = host.split(/[.-]/);
  if (words.includes('github')) return 'github';
  if (words.includes('gitlab')) return 'gitlab';
  return undefined;
}
