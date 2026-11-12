// Detecting the user's installed OpenCode in an Environment, through its
// bridge: installed (on the PATH), version (`opencode --version`) and signed
// in (a private `opencode serve --stdio` lists a connected integration). It
// never runs `opencode auth list` or `opencode models`, which start the
// user's shared background service.
import { DEFAULT_EFFORT, OPENCODE_MIN_VERSION, OPENCODE_NAME, type AgentCommand, type AgentStatus, type ModelChoice } from '../../shared/api';
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';
import type { AcpProfile } from './acp-adapter';
import { agentCommandsOf } from './commands';
import { NO_TOOLS, OPENCODE_TOOLS, openCodePermission } from './opencode-permission';

/**
 * Sessions run on `opencode acp`, one process each, with Loom's approval
 * rules in OPENCODE_CONFIG_CONTENT, which OpenCode merges over the user's
 * own config. It carries the rules and nothing else.
 */
export const OPENCODE_ACP: AcpProfile = {
  name: OPENCODE_NAME,
  command: 'opencode',
  args: ['acp'],
  env: ({ approvals, workingCopy, tempDir, toolsOff }) => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: toolsOff ? NO_TOOLS : openCodePermission({ policy: approvals, workingCopy, tempDir }) }),
  }),
  ownTools: new Set(OPENCODE_TOOLS),
  // OpenCode keeps its to-do list with a tool, and tells ACP nothing else of it.
  planTool: 'todowrite',
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

/** What OpenCode offers in a checkout: its models, and its commands and skills. */
export interface CheckoutOffer {
  models: ModelChoice[];
  commands: AgentCommand[];
}

/**
 * What OpenCode offers in the checkout `directory`, from a private
 * `opencode serve --stdio`: its models as `provider/model`, with their Effort
 * levels as its ACP bridge offers them (their variants, then `default`),
 * leaving out the models the user turned off; then its commands and skills,
 * none if it didn't list them, each skill with where it comes from as the
 * bridge tells.
 */
export async function probeOpenCodeCheckout(call: BridgeCall, directory: string): Promise<CheckoutOffer> {
  const { models, commands, skills } = await call<{ models?: ApiModel[]; commands?: unknown; skills?: unknown }>('opencode.probe', PROBE_REQUEST_TIMEOUT_MS, { directory });
  if (!Array.isArray(models)) throw new Error('OpenCode listed no models');
  return {
    models: models.flatMap((model) => {
      if (typeof model?.providerID !== 'string' || typeof model.id !== 'string' || model.enabled === false) return [];
      const variants = (Array.isArray(model.variants) ? model.variants : []).flatMap((v) => (typeof v?.id === 'string' ? [v.id] : []));
      const id = `${model.providerID}/${model.id}`;
      return [{ id, name: typeof model.name === 'string' && model.name ? model.name : id, efforts: variants.length ? [...new Set([...variants, DEFAULT_EFFORT])] : [] }];
    }),
    commands: [...agentCommandsOf('command', commands), ...agentCommandsOf('skill', skills)],
  };
}

/** `opencode v2.1.4`, `v2.1.4` or `1.19.4` → [major, minor, patch]. */
function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare([a1, a2, a3]: [number, number, number], [b1, b2, b3]: [number, number, number]): number {
  return a1 - b1 || a2 - b2 || a3 - b3;
}
