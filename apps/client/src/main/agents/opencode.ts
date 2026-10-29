// Detecting the user's installed OpenCode in an Environment, through its
// bridge: installed (on the PATH), version (`opencode --version`) and signed
// in (a private `opencode serve --stdio` lists a connected integration). It
// never runs `opencode auth list` or `opencode models`, which start the
// user's shared background service.
import { OPENCODE_MIN_VERSION, type AgentStatus } from '../../shared/api';
import { BridgeRequestError } from '../environments/bridge-connection';

/** Sends one request to an Environment's bridge. */
export type BridgeCall = <T>(method: string, timeoutMs: number, params?: unknown) => Promise<T>;

const NAME = 'OpenCode';
const VERSION_TIMEOUT_MS = 10_000;
// The bridge gives the probe 15 s; this leaves it room to answer.
const PROBE_REQUEST_TIMEOUT_MS = 20_000;

interface ExecResult {
  path: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Integration {
  connections?: unknown[];
}

export async function detectOpenCode(call: BridgeCall): Promise<Omit<AgentStatus, 'checking'>> {
  let exec: ExecResult;
  try {
    exec = await call<ExecResult>('exec', VERSION_TIMEOUT_MS + 5_000, { command: 'opencode', args: ['--version'], timeoutMs: VERSION_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof BridgeRequestError && error.code === 'not_found') return { name: NAME, state: 'missing' };
    return { name: NAME, state: 'error', error: `opencode --version failed: ${(error as Error).message}` };
  }
  const found = { name: NAME, path: exec.path };
  if (exec.exitCode !== 0) {
    return { ...found, state: 'error', error: `opencode --version exited with code ${exec.exitCode}: ${(exec.stderr || exec.stdout).trim()}` };
  }
  const version = parseVersion(exec.stdout);
  if (!version) return { ...found, state: 'error', error: `opencode --version printed no version: ${exec.stdout.trim()}` };
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
