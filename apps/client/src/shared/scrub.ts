// What Loom sends Sentry, made safe to send: no conversations, Projects,
// repositories, files, paths, branches or people (issue #126). Every event,
// span, breadcrumb and log goes through here, in main and in the renderer, on
// top of the SDK's own data collection being turned off (main/telemetry.ts).
//
// It works by shape, not by knowing what's private: messages keep their first
// line only, cut short, with quoted text, paths, URLs and email addresses
// replaced, and the machine's home folder, user name and host name taken out
// of every string. What Loom quotes in a message is what the user named (a
// branch, a folder, a Session's title), and what follows a message's first
// line is what a command printed.

/** What names this machine and its user, taken out wherever it shows up. */
export interface Machine {
  home?: string;
  user?: string;
  host?: string;
}

/** The longest message kept, after its first line is taken. */
export const MAX_MESSAGE = 300;

const DETAILS = '\n\nDetails:\n';

/** URLs Loom's own code lives at, which stack frames point to and source maps are found by. */
const APP_URL = /\bapp:\/\/\/[^\s'"`<>()]*/g;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]*/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const WINDOWS_PATH = /(?:\b[a-z]:|\\\\[^\s\\'"`]+)\\[^\s'"`<>|:]*/gi;
// An absolute or `~` path: a slash that starts a word.
const UNIX_PATH = /(^|[\s(=:,[{])~?\/[^\s'"`<>)\]},;:]+/g;
// Something with slashes in it, which in a message is a path or a branch.
const RELATIVE_PATH = /\b[\w.@+-]+(?:\/[\w.@+-]+)+\/?/g;
// Quoted text. A single quote counts only away from letters, so "isn't" stays.
const QUOTED = /"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’|«[^»\n]*»/g;
// A host name, such as a self-hosted Forge's: names under the common top-level
// domains, so that `options.clock` in a TypeError stays.
const HOST =
  /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|me|sh|cloud|tech|site|xyz|info|biz|local|lan|internal|intranet|corp|home|example|test|localdomain|eu|de|fr|uk|nl|ch|be|es|it|pt|ca|us|jp|cn|ru|br|in|au|nz|se|no|fi|dk|pl|cz|at|ie|il|kr|tw|sg)\b/gi;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `text` with the machine's names, quoted text, paths, URLs and email addresses taken out.
 * Loom's own `app:///` URLs stay, as stack frames need them.
 */
export function scrubText(text: string, machine: Machine = {}): string {
  const kept: string[] = [];
  let out = text.replace(APP_URL, (url) => `\u0000${kept.push(url) - 1}\u0000`);
  if (machine.home && machine.home.length > 1) out = out.replace(new RegExp(escaped(machine.home), 'gi'), '~');
  out = out.replace(QUOTED, '"<redacted>"').replace(URL, '<url>').replace(EMAIL, '<email>').replace(WINDOWS_PATH, '<path>').replace(UNIX_PATH, '$1<path>');
  for (const name of [machine.user, machine.host]) {
    if (name && name.length >= 3) out = out.replace(new RegExp(`(?<![\\w-])${escaped(name)}(?![\\w-])`, 'gi'), name === machine.user ? '<user>' : '<host>');
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]!);
}

/**
 * A message as it may be sent: its first line, with no Details, quoted text
 * or paths, and no longer than MAX_MESSAGE.
 */
export function scrubMessage(text: string, machine: Machine = {}): string {
  const at = text.indexOf(DETAILS);
  const sentence = (at < 0 ? text : text.slice(0, at)).trim();
  const firstLine = sentence.split(/\r?\n/, 1)[0] ?? '';
  const out = scrubText(firstLine, machine).replace(RELATIVE_PATH, '<path>').replace(HOST, '<host>');
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}…` : out;
}

/** Keys whose values are the SDK's own and safe as they are. */
const KEPT_KEYS = new Set(['event_id', 'timestamp', 'start_timestamp', 'release', 'dist', 'environment', 'platform', 'level', 'type', 'sdk', 'trace_id', 'span_id', 'parent_span_id', 'op', 'origin', 'status']);

/** Keys whose values are messages, scrubbed as such. */
const MESSAGE_KEYS = new Set(['message', 'value', 'formatted', 'description', 'transaction', 'reason']);

/** Keys never sent: who the user is, what they asked for, and the variables and data the SDK gathered. */
const DROPPED_KEYS = new Set(['user', 'request', 'server_name', 'extra', 'vars', 'params', 'modules', 'cookies', 'headers', 'data_collection']);

type Json = unknown;

function scrubValue(value: Json, key: string | undefined, machine: Machine): Json {
  if (typeof value === 'string') {
    if (key && KEPT_KEYS.has(key)) return value;
    if (key && MESSAGE_KEYS.has(key)) return scrubMessage(value, machine);
    return scrubText(value, machine);
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, undefined, machine));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROPPED_KEYS.has(k)) continue;
      out[k] = k === 'frames' && Array.isArray(v) ? v.map((frame) => scrubFrame(frame, machine)) : scrubValue(v, k, machine);
    }
    return out;
  }
  return value;
}

/** A stack frame keeps where in Loom's code it is: its file only if that's Loom's own or the runtime's, and never its variables. */
function scrubFrame(frame: Json, machine: Machine): Json {
  if (!frame || typeof frame !== 'object') return frame;
  const { vars: _vars, ...rest } = frame as Record<string, Json>;
  const out: Record<string, Json> = { ...rest };
  for (const key of ['filename', 'abs_path', 'module', 'package']) {
    const path = out[key];
    if (typeof path !== 'string') continue;
    if (path.startsWith('app:///') || path.startsWith('node:') || !/[\\/]/.test(path)) continue;
    out[key] = scrubText(path, machine);
  }
  // Source lines are shown only from Loom's own code.
  if (typeof out.filename === 'string' && !out.filename.startsWith('app:///')) {
    delete out.pre_context;
    delete out.context_line;
    delete out.post_context;
  }
  return out;
}

/**
 * An event (an error, a transaction, a native crash or feedback) as it may be
 * sent. Feedback keeps what the user wrote, and the email address they gave,
 * as they wrote it to be sent.
 */
export function scrubEvent<T extends object>(event: T, machine: Machine = {}): T {
  const feedback = (event as { type?: string; contexts?: { feedback?: Record<string, Json> } }).type === 'feedback' ? (event as { contexts?: { feedback?: Record<string, Json> } }).contexts?.feedback : undefined;
  const out = scrubValue(event, undefined, machine) as T & { breadcrumbs?: Json[]; contexts?: Record<string, Record<string, Json>> };
  // Not where the event came from either: an address set here is one Sentry
  // takes no other in place of, nor works out a location from.
  (out as { user?: unknown }).user = { ip_address: '0.0.0.0' };
  if (Array.isArray(out.breadcrumbs)) out.breadcrumbs = out.breadcrumbs.flatMap((crumb) => scrubBreadcrumb(crumb as Breadcrumb, machine) ?? []);
  if (feedback && out.contexts?.feedback) {
    for (const key of ['message', 'contact_email', 'name']) if (typeof feedback[key] === 'string') out.contexts.feedback[key] = feedback[key];
    delete out.contexts.feedback.url;
  }
  return out;
}

interface Breadcrumb {
  category?: string;
  message?: string;
  data?: unknown;
}

/**
 * Only Electron's own breadcrumbs (the app and its windows starting,
 * focusing, crashing) are kept, without their data. Clicks would name what
 * was clicked, console lines and requests could say anything.
 */
export function scrubBreadcrumb<T extends Breadcrumb>(crumb: T, machine: Machine = {}): T | null {
  if (!crumb.category?.startsWith('electron')) return null;
  const { data: _data, ...rest } = crumb;
  return { ...rest, ...(typeof rest.message === 'string' ? { message: scrubMessage(rest.message, machine) } : {}) } as unknown as T;
}

interface Log {
  message?: unknown;
  body?: unknown;
  attributes?: Record<string, unknown>;
}

/** A log line as it may be sent: its message scrubbed, and the values it was formatted from dropped. */
export function scrubLog<T extends Log>(log: T, machine: Machine = {}): T {
  const out = { ...log } as Log & Record<string, unknown>;
  for (const key of ['message', 'body'] as const) if (typeof out[key] === 'string') out[key] = scrubMessage(out[key], machine);
  if (out.attributes) {
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out.attributes)) {
      if (key.startsWith('sentry.message.parameter') || key === 'sentry.message.template') continue;
      attributes[key] = scrubValue(value, key, machine);
    }
    out.attributes = attributes;
  }
  return out as unknown as T;
}
