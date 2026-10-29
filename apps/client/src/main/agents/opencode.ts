// Detecting the user's installed OpenCode in an Environment, through its
// bridge: installed (on the PATH), version (`opencode --version`) and signed
// in (a private `opencode serve --stdio` lists a connected integration). It
// never runs `opencode auth list` or `opencode models`, which start the
// user's shared background service.
import { OPENCODE_MIN_VERSION, OPENCODE_NAME, type AgentStatus } from '../../shared/api';
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';
import type { AcpProfile } from './acp-adapter';


/** Sessions run on `opencode acp`, one process each. */
export const OPENCODE_ACP: AcpProfile = { name: OPENCODE_NAME, command: 'opencode', args: ['acp'] };
const VERSION_TIMEOUT_MS = 10_000;
// The bridge gives the probe 15 s; this leaves it room to answer.
const PROBE_REQUEST_TIMEOUT_MS = 20_000;

interface Integration {
  connections?: unknown[];
}

export async function detectOpenCode(call: BridgeCall): Promise<Omit<AgentStatus, 'checking'>> {
  let result: ExecResult;
  try {
    result = await exec(call, 'opencode', ['--version'], VERSION_TIMEOUT_MS);
  } catch (error) {
    if (isNotFound(error)) return { name: OPENCODE_NAME, state: 'missing' };
    return { name: OPENCODE_NAME, state: 'error', error: `opencode --version failed: ${(error as Error).message}` };
  }
  const found = { name: OPENCODE_NAME, path: result.path };
  if (result.exitCode !== 0) {
    return { ...found, state: 'error', error: `opencode --version exited with code ${result.exitCode}: ${(result.stderr || result.stdout).trim()}` };
  }
  const version = parseVersion(result.stdout);
  if (!version) return { ...found, state: 'error', error: `opencode --version printed no version: ${result.stdout.trim()}` };
  const status = { ...found, version: version.join('.') };
  if (compare(version, parseVersion(OPENCODE_MIN_VERSION)!) < 0) return { ...status, state: 'unsupported' };

  let integrations: Integration[];
  try {
    ({ integrations } = await call<{ integrations: Integration[] }>('opencode.probe', PROBE_REQUEST_TIMEOUT_MS));
  } catch (error) {
    return { ...status, state: 'error', error: `could not ask OpenCode whether it is signed in: ${(error as Error).message}` };
  }
  const signedIn = Array.isArray(integrations) && integrations.some((i) => Array.isArray(i.connections) && i.connections.length > 0);
  return { ...status, state: signedIn ? 'ready' : 'signed-out' };
}

/** `opencode v2.1.4`, `v2.1.4` or `1.19.4` → [major, minor, patch]. */
function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare([a1, a2, a3]: [number, number, number], [b1, b2, b3]: [number, number, number]): number {
  return a1 - b1 || a2 - b2 || a3 - b3;
}
