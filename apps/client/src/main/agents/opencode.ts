// Detecting the user's installed OpenCode in an Environment, through its
// bridge: installed (on the PATH), version (`opencode --version`) and signed
// in (a private `opencode serve --stdio` lists a connected integration). It
// never runs `opencode auth list` or `opencode models`, which start the
// user's shared background service.
import { OPENCODE_MIN_VERSION, OPENCODE_NAME, type AgentStatus, type ModelChoice } from '../../shared/api';
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';
import type { AcpProfile } from './acp-adapter';
import { OPENCODE_TOOLS, openCodePermission } from './opencode-permission';

/**
 * Sessions run on `opencode acp`, one process each, with Loom's approval
 * rules in OPENCODE_CONFIG_CONTENT, which OpenCode merges over the user's
 * own config. It carries the rules and nothing else.
 */
export const OPENCODE_ACP: AcpProfile = {
  name: OPENCODE_NAME,
  command: 'opencode',
  args: ['acp'],
  env: ({ approvals, workingCopy, tempDir }) => ({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: openCodePermission({ policy: approvals, workingCopy, tempDir }) }) }),
  ownTools: new Set(OPENCODE_TOOLS),
};
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

/** A model as OpenCode's `GET /api/model` lists it; only what Loom reads. */
interface ApiModel {
  id?: unknown;
  providerID?: unknown;
  name?: unknown;
  enabled?: unknown;
  variants?: Array<{ id?: unknown }>;
}

/** OpenCode's ACP bridge offers every model's variants as Effort levels, with this one besides. */
const DEFAULT_EFFORT = 'default';

/**
 * The models OpenCode offers in the checkout `directory`, from a private
 * `opencode serve --stdio`: as `provider/model`, with their Effort levels as
 * its ACP bridge offers them (their variants, then `default`), leaving out
 * the models the user turned off.
 */
export async function listOpenCodeModels(call: BridgeCall, directory: string): Promise<ModelChoice[]> {
  const { models } = await call<{ models?: ApiModel[] }>('opencode.probe', PROBE_REQUEST_TIMEOUT_MS, { directory });
  if (!Array.isArray(models)) throw new Error('OpenCode listed no models');
  return models.flatMap((model) => {
    if (typeof model?.providerID !== 'string' || typeof model.id !== 'string' || model.enabled === false) return [];
    const variants = (Array.isArray(model.variants) ? model.variants : []).flatMap((v) => (typeof v?.id === 'string' ? [v.id] : []));
    const id = `${model.providerID}/${model.id}`;
    return [{ id, name: typeof model.name === 'string' && model.name ? model.name : id, efforts: variants.length ? [...new Set([...variants, DEFAULT_EFFORT])] : [] }];
  });
}

/** `opencode v2.1.4`, `v2.1.4` or `1.19.4` → [major, minor, patch]. */
function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare([a1, a2, a3]: [number, number, number], [b1, b2, b3]: [number, number, number]): number {
  return a1 - b1 || a2 - b2 || a3 - b3;
}
