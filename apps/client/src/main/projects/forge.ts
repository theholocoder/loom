// Detecting a checkout's Forge through its Environment's bridge: which Forge
// `origin` is on (`git remote get-url origin`), and whether that Forge's CLI
// is installed and signed in to its host (`gh`/`glab auth status --hostname`).
// Loom reaches the Forge only through that login (ADR 0002).
import { FORGE_CLI, type ForgeKind, type ForgeStatus } from '../../shared/api';
import type { BridgeCall } from '../agents/opencode';
import { BridgeRequestError } from '../environments/bridge-connection';

const GIT_TIMEOUT_MS = 10_000;
const AUTH_STATUS_TIMEOUT_MS = 15_000;

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
  const kind = parsed && forgeKind(parsed.host);
  if (!parsed || !kind) return { state: 'unsupported', remote: url, host: parsed?.host };

  const found = { kind, host: parsed.host, repository: parsed.repository, remote: url };
  const cli = FORGE_CLI[kind];
  let status: ExecResult;
  try {
    status = await exec(call, cli, ['auth', 'status', '--hostname', parsed.host], AUTH_STATUS_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof BridgeRequestError && error.code === 'not_found') return { ...found, state: 'cli-missing' };
    return { ...found, state: 'error', error: `${cli} auth status failed: ${(error as Error).message}` };
  }
  if (status.exitCode !== 0) return { ...found, state: 'signed-out', error: (status.stderr || status.stdout).trim() || undefined };
  return { ...found, state: 'available' };
}

function exec(call: BridgeCall, command: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return call<ExecResult>('exec', timeoutMs + 5_000, { command, args, timeoutMs });
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
