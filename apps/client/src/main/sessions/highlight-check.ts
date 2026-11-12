// What a Session highlights check (ADR 0010) sends its model, and what Loom
// reads of the answer. The model sees the open Highlights and the turns since
// the last check, never the whole conversation again, and answers with JSON:
// Highlights to add, and open ones to resolve.
import { HIGHLIGHT_KINDS, isHighlightKind, type Highlight, type HighlightKind, type TranscriptItem } from '../../shared/api';

/** One turn as the check sees it: the user's message, what the agent said, and what it did. */
export interface TurnDigest {
  /** The transcript item it starts at: the user's message, or the first item checked when that came before. */
  itemId: number;
  lines: string[];
}

/** What the model asked for: Highlights to add, and open ones to resolve, each with the turn it came from. */
export interface CheckAnswer {
  add: Array<{ kind: HighlightKind; text: string; turn: number }>;
  resolve: Array<{ id: number; reason: string; turn: number }>;
}

/** The longest a message or reply goes into the prompt, in characters: its head, then a marker. */
const MAX_TEXT = 4_000;
/** The most tool calls listed per turn: the last ones. */
const MAX_TOOLS = 40;
/** The most a check's turns take of the prompt, in characters: the newest turns first; older ones are left out. */
const MAX_TURNS_TEXT = 60_000;
/** The longest a Highlight's text, or a resolution's reason, is kept. */
const MAX_HIGHLIGHT = 600;

/** The turns of `items` after item `after`, oldest first; none when nothing came after it. */
export function turnsOf(items: TranscriptItem[], after: number): TurnDigest[] {
  const turns: TurnDigest[] = [];
  let turn: TurnDigest | undefined;
  let tools: string[] = [];
  const close = () => {
    if (!turn) return;
    if (tools.length > MAX_TOOLS) turn.lines.push(`Tools: ${tools.length - MAX_TOOLS} earlier calls left out`);
    for (const tool of tools.slice(-MAX_TOOLS)) turn.lines.push(`Tool: ${tool}`);
    turns.push(turn);
    tools = [];
  };
  for (const item of items) {
    if (item.id <= after) continue;
    if (item.kind === 'user' || !turn) {
      close();
      turn = { itemId: item.id, lines: [] };
    }
    const line = lineOf(item);
    if (item.kind === 'tool') tools.push(line!);
    else if (line) turn.lines.push(line);
  }
  close();
  return turns;
}

/** What an item says in the prompt; undefined for what the check leaves out. */
function lineOf(item: TranscriptItem): string | undefined {
  switch (item.kind) {
    case 'user': {
      const files = item.attachments?.length ? ` [${item.attachments.length} attached]` : '';
      return `User: ${capped(item.text) || '(no text)'}${files}`;
    }
    case 'agent':
      return item.text.trim() ? `Agent: ${capped(item.text)}` : undefined;
    case 'tool':
      // Its name and what it acted on; its output is left out.
      return `${item.toolKind ? `${item.toolKind} ` : ''}${oneLine(item.title)}${item.status === 'failed' ? ' (failed)' : ''}`;
    case 'question':
      return `Agent asked the user: ${capped(item.message)} (${item.state})`;
    case 'approval':
      return `Approval request: ${oneLine(item.title)}${item.detail ? ` (${oneLine(item.detail)})` : ''}: ${item.state}${item.message ? `, saying "${capped(item.message)}"` : ''}`;
    case 'error':
      return `The run failed: ${capped(item.message)}`;
    case 'interruption':
      return item.by === 'quit' ? 'Loom quit during the run' : 'The user stopped the run';
    case 'merge-request':
      return `Merge request linked: ${item.url}`;
    case 'feedback':
      return `Merge request feedback: ${item.items.length} new ${item.items.length === 1 ? 'item' : 'items'}`;
    default:
      // Thinking, trust, model changes and the rest: not what the user should know of the work.
      return undefined;
  }
}

/** The prompt of a check: what to note, the open Highlights, then the turns, newest kept when they don't all fit. */
export function checkPrompt(open: Highlight[], turns: TurnDigest[]): string {
  const blocks: string[] = [];
  let size = 0;
  let left = 0;
  for (const turn of [...turns].reverse()) {
    const block = [`## Turn ${turn.itemId}`, ...turn.lines].join('\n');
    if (blocks.length > 0 && size + block.length > MAX_TURNS_TEXT) {
      left++;
      continue;
    }
    blocks.unshift(block);
    size += block.length;
  }
  return [
    "You keep the Highlights of a coding agent's session for its user: the few things they should know about the work, which they would otherwise have to dig out of the conversation. You can't use any tools: read what is below, and answer.",
    '',
    'The kinds of Highlight:',
    '- for-you: something a human has to do, such as a migration to run, a secret to set or a check by hand.',
    '- not-done: something asked that the agent skipped, could not do, or left as a TODO.',
    '- risk: something that could break, or needs care.',
    '- assumption: something the agent took as given without checking.',
    '- decision: a choice the agent made between options.',
    '',
    'Leave out progress, lists of files changed and test results. Most turns add nothing: add a Highlight only when the user would want to know it later, in one or two sentences, naming files as `path:line` where it helps. Never repeat one already listed. Resolve an open Highlight when a turn below settles it (something not done is done, an assumption is confirmed), saying why in a few words.',
    '',
    'Open Highlights:',
    ...(open.length ? open.map((h) => `#${h.id} [${h.kind}] ${h.text}`) : ['(none)']),
    '',
    `The turns since the last check, oldest first${left ? ` (${left} older ${left === 1 ? 'turn' : 'turns'} left out)` : ''}:`,
    '',
    blocks.join('\n\n'),
    '',
    'Answer with one JSON object and nothing else, `turn` being the turn a Highlight or a resolution comes from:',
    `{"add":[{"kind":"${HIGHLIGHT_KINDS[2]}","text":"One or two sentences.","turn":${turns.at(-1)?.itemId ?? 0}}],"resolve":[{"id":12,"reason":"A few words.","turn":${turns.at(-1)?.itemId ?? 0}}]}`,
    'With nothing to add or resolve: {"add":[],"resolve":[]}',
  ].join('\n');
}

/**
 * What Loom takes of the model's answer `text`: its JSON object, in a code
 * fence or not. Entries that don't fit are dropped: a kind Loom hasn't, an
 * empty text, a Highlight that isn't open; one naming a turn not checked is
 * filed under the last. Throws when there is no such object.
 */
export function readAnswer(text: string, { open, turns }: { open: ReadonlySet<number>; turns: readonly number[] }): CheckAnswer {
  const parsed = jsonObjectIn(text);
  if (!parsed) throw new Error("Its answer wasn't the JSON Loom asked for.");
  const last = turns.at(-1)!;
  const turnOf = (value: unknown) => (typeof value === 'number' && turns.includes(value) ? value : last);
  const list = (value: unknown) => (Array.isArray(value) ? (value as Array<Record<string, unknown> | null>).filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null) : []);
  const add = list(parsed.add).flatMap((entry) => {
    const said = typeof entry.text === 'string' ? entry.text.trim() : '';
    return isHighlightKind(entry.kind) && said ? [{ kind: entry.kind, text: said.slice(0, MAX_HIGHLIGHT), turn: turnOf(entry.turn) }] : [];
  });
  const resolving = new Set<number>();
  const resolve = list(parsed.resolve).flatMap((entry) => {
    const id = entry.id;
    if (typeof id !== 'number' || !open.has(id) || resolving.has(id)) return [];
    resolving.add(id);
    const reason = typeof entry.reason === 'string' ? entry.reason.trim().slice(0, MAX_HIGHLIGHT) : '';
    return [{ id, reason, turn: turnOf(entry.turn) }];
  });
  return { add, resolve };
}

/** The JSON object `text` holds: all of it, the inside of a code fence, or from its first `{` to its last `}`. */
function jsonObjectIn(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  for (const candidate of [text, fenced, start >= 0 && end > start ? text.slice(start, end + 1) : undefined]) {
    if (candidate === undefined) continue;
    try {
      const value: unknown = JSON.parse(candidate.trim());
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

function capped(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)} […]` : trimmed;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
