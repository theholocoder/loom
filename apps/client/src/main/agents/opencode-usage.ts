// OpenCode's own record of its sessions' usage, Loom's and the user's own
// alike (ADR 0012): its `GET /api/session` list, and each session's
// assistant messages (`GET /api/session/{id}/message`), one per step, with
// when it completed, its model, tokens and cost. Asked of a private server
// with `opencode api --standalone` through the Environment's bridge: never
// the user's shared background service, nor OpenCode's database, whose
// tables change between versions.
import type { TokenCounts } from '../../shared/api';
import { exec, type BridgeCall } from '../environments/exec';
import type { AgentConversation, AgentUsageSource, UsageStep } from './adapter';

/** Sessions asked for at a time, about 500 bytes each: well within what the bridge's `exec` keeps of its output (1 MB). */
export const OPENCODE_SESSIONS_PAGE = 200;
/**
 * Messages asked for at a time: each carries its content, usually a few KB.
 * A page that doesn't fit is asked again, smaller.
 */
export const OPENCODE_MESSAGES_PAGE = 20;
/** How many pages one listing reads at most. */
const MAX_PAGES = 500;
const PAGE_TIMEOUT_MS = 30_000;
/**
 * How long a step may take: messages are listed newest started first, so
 * the listing reads this far past `since` for one started before it that
 * completed after.
 */
const LONGEST_STEP_MS = 60 * 60_000;

/** A session as OpenCode 2.4.2's `GET /api/session` lists it: only what Loom reads. */
interface ApiSession {
  id?: unknown;
  parentID?: unknown;
  location?: { directory?: unknown };
  time?: { updated?: unknown };
  cost?: unknown;
  tokens?: ApiTokens;
}

interface ApiTokens {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: { read?: unknown; write?: unknown };
}

/** An assistant message, one step, as OpenCode 2.4.2's `GET /api/session/{id}/message` lists it: only what Loom reads. */
interface ApiMessage {
  id?: unknown;
  type?: unknown;
  model?: { id?: unknown; providerID?: unknown };
  cost?: unknown;
  tokens?: ApiTokens;
  time?: { created?: unknown; completed?: unknown };
}

export const openCodeUsage: AgentUsageSource = {
  /** Its sessions, newest change first as it lists them, until one changed before `since`. */
  async conversations(call: BridgeCall, since?: number): Promise<AgentConversation[]> {
    const found: AgentConversation[] = [];
    await pages<ApiSession>(call, ['session.list'], [], OPENCODE_SESSIONS_PAGE, (session) => {
      const conversation = conversationOf(session);
      if (!conversation) return true;
      if (since !== undefined && conversation.updatedAt < since) return false;
      found.push(conversation);
      return true;
    });
    return found;
  },

  /** The session's assistant messages, newest first as it lists them, until one started well before `since`. */
  async steps(call: BridgeCall, id: string, since?: number): Promise<UsageStep[]> {
    const found: UsageStep[] = [];
    // The cursor carries the order: it is given with the first page only.
    await pages<ApiMessage>(call, ['session.message.list', '--param', `sessionID=${id}`, '--param', 'type=assistant'], ['--param', 'order=desc'], OPENCODE_MESSAGES_PAGE, (message) => {
      const created = message.time?.created;
      if (since !== undefined && isCount(created) && created < since - LONGEST_STEP_MS) return false;
      const step = stepOf(message);
      if (step && (since === undefined || step.at >= since)) found.push(step);
      return true;
    });
    return found;
  },
};

/**
 * Reads `opencode api --standalone <operation>` page by page (`first` added
 * to the first page's arguments), giving `each` item in turn until it
 * returns false or the items run out. A page cut short by the bridge's limit
 * on output isn't JSON: it is asked again with half as many items.
 */
async function pages<T>(call: BridgeCall, operation: string[], first: string[], size: number, each: (item: T) => boolean): Promise<void> {
  const name = `opencode api ${operation[0]}`;
  let cursor: string | undefined;
  let limit = size;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ['api', '--standalone', ...operation, ...(cursor ? ['--param', `cursor=${cursor}`] : first), '--param', `limit=${limit}`];
    const result = await exec(call, 'opencode', args, PAGE_TIMEOUT_MS);
    if (result.exitCode !== 0) throw new Error(`${name} exited with code ${result.exitCode}: ${(result.stderr || result.stdout).trim().split('\n')[0] ?? ''}`);
    let listed: { data?: unknown; cursor?: { next?: unknown } };
    try {
      listed = JSON.parse(result.stdout) as typeof listed;
    } catch {
      if (limit === 1) throw new Error(`${name} printed something other than JSON`);
      limit = Math.ceil(limit / 2);
      continue;
    }
    if (!Array.isArray(listed.data)) throw new Error(`${name} listed nothing`);
    for (const item of listed.data as T[]) if (!each(item)) return;
    cursor = typeof listed.cursor?.next === 'string' ? listed.cursor.next : undefined;
    if (!cursor || listed.data.length < limit) return;
    limit = size;
  }
}

function conversationOf(session: ApiSession): AgentConversation | undefined {
  if (typeof session.id !== 'string' || !session.id || !isCount(session.time?.updated)) return undefined;
  const directory = session.location?.directory;
  return {
    id: session.id,
    ...(typeof session.parentID === 'string' && session.parentID ? { parentId: session.parentID } : {}),
    ...(typeof directory === 'string' && directory ? { directory } : {}),
    updatedAt: session.time!.updated as number,
    // Its steps' usage and its title's, which OpenCode asks a model for and counts with the session.
    ...(session.tokens ? { total: { tokens: tokensOf(session.tokens), cost: costOf(session.cost) } } : {}),
  };
}

function stepOf(message: ApiMessage): UsageStep | undefined {
  const at = message.time?.completed;
  if (message.type !== 'assistant' || typeof message.id !== 'string' || !message.tokens || !isCount(at)) return undefined;
  const { model } = message;
  return {
    id: message.id,
    at,
    ...(typeof model?.providerID === 'string' && typeof model.id === 'string' ? { model: `${model.providerID}/${model.id}` } : {}),
    tokens: tokensOf(message.tokens),
    cost: costOf(message.cost),
  };
}

function tokensOf(t: ApiTokens): TokenCounts {
  return { input: count(t.input), output: count(t.output), reasoning: count(t.reasoning), cacheRead: count(t.cache?.read), cacheWrite: count(t.cache?.write) };
}

function costOf(cost: unknown): number {
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function count(value: unknown): number {
  return isCount(value) ? value : 0;
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
