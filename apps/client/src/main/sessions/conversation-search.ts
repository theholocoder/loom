// Searching what was said in Sessions' conversations, for the Ctrl+K
// palette: the user's messages and the agent's, as stored in `events`.
import { sql } from 'kysely';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { ConversationMatch } from '../../shared/api';
import { FOLD_CASE, type LoomDatabase } from '../storage/database';

type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

/** How long an excerpt is at most, ellipses aside. */
const EXCERPT_LENGTH = 120;
/** How much of the message an excerpt keeps before the first word found. */
const EXCERPT_LEAD = 40;

/**
 * The Sessions among `sessionIds` whose messages hold any of `words`, case
 * aside, each with the words it holds and an excerpt of the message holding
 * the most of them, the first such. One row per Session comes back from the
 * database, its best message's.
 */
export async function searchConversations(db: LoomDatabase, sessionIds: ReadonlySet<number>, words: string[]): Promise<ConversationMatch[]> {
  const wanted = [...new Set(words.filter((w): w is string => typeof w === 'string' && w !== ''))];
  if (!wanted.length || !sessionIds.size) return [];
  const folded = sql`${sql.raw(FOLD_CASE)}(json_extract(data, '$.text'))`;
  // Per message, whether it holds each word (h0, h1…); per Session, whether any of its messages does (a0, a1…), and its best message first.
  const holds = wanted.map((word, i) => sql`(instr(${folded}, ${word.toLowerCase()}) > 0) as ${sql.ref(`h${i}`)}`);
  const anyHolds = wanted.map((_, i) => sql`max(${sql.ref(`h${i}`)}) over (partition by session_id) as ${sql.ref(`a${i}`)}`);
  const score = sql.join(wanted.map((_, i) => sql.ref(`h${i}`)), sql` + `);
  const { rows } = await sql<Record<string, number> & { session_id: number; text: string; rank: number }>`
    select * from (
      select session_id, text, ${sql.join(anyHolds)}, row_number() over (partition by session_id order by ${score} desc, seq) as rank
      from (
        select session_id, seq, json_extract(data, '$.text') as text, ${sql.join(holds)}
        from events
        where kind in ('user', 'agent')
      )
      where ${score} > 0
    )
    where rank = 1
    order by session_id
  `.execute(db);
  return rows.filter((row) => sessionIds.has(row.session_id)).map((row) => {
    const held = wanted.filter((_, i) => row[`a${i}`] === 1);
    return { id: row.session_id, words: held, excerpt: excerpt(plainText(row.text), held) };
  });
}

/**
 * What Markdown `text` says, as plain text, read as the conversation renders
 * it: no heading marks, table pipes, emphasis, code ticks or link targets, and
 * code as it is. Blocks and table cells are kept apart by a line break.
 */
function plainText(text: string): string {
  return said(fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
}

/** What a Markdown node says: its text, or its children's, a block's on a line of its own. */
function said(node: MarkdownNode): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      return node.value;
    case 'image':
      return node.alt ?? '';
    case 'html':
    case 'definition':
    case 'footnoteDefinition':
    case 'thematicBreak':
      return '';
    case 'break':
      return '\n';
  }
  if (!('children' in node)) return '';
  const inline = node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell' || node.type === 'link' || node.type === 'linkReference' || node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete';
  return (node.children as MarkdownNode[]).map(said).join(inline ? '' : '\n');
}

/** `text` on one line, cut down around the first of `words` it holds, with an ellipsis where cut. */
function excerpt(text: string, words: string[]): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= EXCERPT_LENGTH) return line;
  const lower = line.toLowerCase();
  const found = words.map((w) => lower.indexOf(w.toLowerCase())).filter((i) => i >= 0);
  // The best message holds a word, but perhaps only across the spaces that were folded, or in Markdown that isn't shown, such as a link's target.
  const at = found.length ? Math.min(...found) : 0;
  let start = Math.max(0, Math.min(at - EXCERPT_LEAD, line.length - EXCERPT_LENGTH));
  // From the start of a word.
  if (start > 0) {
    const space = line.indexOf(' ', start - 1);
    if (space >= 0 && space < at) start = space + 1;
  }
  let end = Math.min(line.length, start + EXCERPT_LENGTH);
  // To the end of a word.
  if (end < line.length) {
    const space = line.lastIndexOf(' ', end);
    if (space > start) end = space;
  }
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}
