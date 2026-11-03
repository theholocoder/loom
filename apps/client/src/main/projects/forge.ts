// Detecting a checkout's Forge through its Environment's bridge: which Forge
// `origin` is on (`git remote get-url origin`), and whether that Forge's CLI
// is installed and signed in to its host (`gh`/`glab auth status --hostname`).
// Loom reaches the Forge only through that login (ADR 0002).
import { FORGE_CLI, type ForgeKind, type ForgeStatus } from '../../shared/api';
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';

export const GIT_TIMEOUT_MS = 10_000;
const AUTH_STATUS_TIMEOUT_MS = 15_000;

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
  let kind = forgeKind(parsed.host);
  let host = parsed.host;
  if (!kind) {
    // A self-hosted GitLab not named after GitLab: glab knows it once signed in.
    const known = await glabHostFor(call, parsed.host);
    if (!known) return { state: 'unsupported', remote: url, host: parsed.host };
    kind = 'gitlab';
    host = known;
  }

  const found = { kind, host, repository: parsed.repository, remote: url };
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

/**
 * The GitLab host glab is configured for that `host` is, or whose alternate
 * SSH hostname (`ssh_host`) it is; none when glab isn't installed or doesn't
 * know it. Hosts are listed with `glab auth status --all --output json` where
 * supported, else from the plain `glab auth status` listing. Never asks for
 * tokens.
 */
async function glabHostFor(call: BridgeCall, host: string): Promise<string | undefined> {
  const run = async (args: string[]): Promise<ExecResult | undefined> => {
    try {
      return await exec(call, 'glab', args, AUTH_STATUS_TIMEOUT_MS);
    } catch {
      return undefined;
    }
  };
  let known = jsonHosts((await run(['auth', 'status', '--all', '--output', 'json']))?.stdout);
  if (!known) {
    const listing = await run(['auth', 'status']);
    if (!listing) return undefined;
    known = listedHosts(`${listing.stdout}\n${listing.stderr}`);
  }
  if (known.includes(host)) return host;
  for (const candidate of known) {
    const ssh = await run(['config', 'get', 'ssh_host', '--host', candidate]);
    if (ssh?.exitCode === 0 && ssh.stdout.trim().toLowerCase() === host) return candidate;
  }
  return undefined;
}

/** The hosts in `glab auth status --all --output json`, if it printed JSON. */
function jsonHosts(stdout: string | undefined): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout ?? '');
  } catch {
    return undefined;
  }
  const hosts = new Set<string>();
  const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.entries(parsed).map(([key, value]) => ({ host: key, ...(value as object) })) : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = [e.host, e.hostname, e.Host, e.Hostname].find((v) => typeof v === 'string' && v.includes('.')) as string | undefined;
    if (name) hosts.add(name.toLowerCase());
  }
  return [...hosts];
}

/** The hosts in the plain `glab auth status` listing: a header line per host. */
function listedHosts(output: string): string[] {
  const hosts = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const header = /^([a-z0-9][a-z0-9.-]*\.[a-z0-9-]+(?::\d+)?)\s*$/i.exec(line.trim());
    if (header && !/^\s/.test(line)) hosts.add(header[1]!.toLowerCase().replace(/:\d+$/, ''));
    const status = /^\s*(?:[✓x✗×!]\s+)?(?:logged in to\s+)?([a-z0-9][a-z0-9.-]*\.[a-z0-9-]+)(?::|\s+as\b)/i.exec(line);
    if (status && /logged in to|^\s*[x✗×]\s/i.test(line)) hosts.add(status[1]!.toLowerCase());
  }
  return [...hosts];
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
  if (host === 'github.com' || host.split('.').includes('github')) return 'github';
  if (host === 'gitlab.com' || host.split('.').includes('gitlab')) return 'gitlab';
  return undefined;
}
