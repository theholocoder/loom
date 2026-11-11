// The blocks the user's comments on a Session's diff, or on its
// conversation, become, after the text of the prompt they go with.
import { diffCommentRange, isConversationComment, type ConversationComment, type DiffComment, type MessageComment } from '../../shared/api';

/** The blocks for the comments sent with a prompt, in order, none when absent; rejects a comment that isn't whole, or has no note. */
export function diffCommentBlocks(comments: MessageComment[] | undefined): string[] {
  return checkComments(comments).map((comment) => (isConversationComment(comment) ? quoteBlock(comment) : commentBlock(comment)));
}

/** The comments sent with a prompt, none when absent; rejects one that isn't whole, or has no note. */
function checkComments(comments: MessageComment[] | undefined): MessageComment[] {
  if (comments === undefined) return [];
  if (!Array.isArray(comments)) throw new Error('Comments must be a list.');
  for (const comment of comments) {
    if (typeof comment !== 'object' || comment === null) throw new Error('A comment needs a note.');
    if (isConversationComment(comment)) {
      if (typeof comment.note !== 'string' || !comment.note.trim()) throw new Error('A comment needs a note.');
      if (typeof comment.quote !== 'string' || !comment.quote.trim()) throw new Error('A comment on the conversation needs what it quotes.');
      continue;
    }
    const { path, start, end, lines, note } = comment;
    if (typeof path !== 'string' || !path || !Number.isInteger(start) || !Number.isInteger(end) || !Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) {
      throw new Error('A diff comment needs a path, a range and its lines.');
    }
    if (typeof note !== 'string' || !note.trim()) throw new Error('A diff comment needs a note.');
  }
  return comments;
}

/** A diff comment as the agent reads it: where, the lines quoted in a fence longer than any they hold, then the note. */
function commentBlock(comment: DiffComment): string {
  const longest = Math.max(0, ...comment.lines.map((line) => Math.max(0, ...[...line.matchAll(/`+/g)].map((m) => m[0].length))));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`Comment on \`${diffCommentRange(comment)}\`:`, '', `${fence}diff`, ...comment.lines, fence, '', comment.note.trim()].join('\n');
}

/** A conversation comment as the agent reads it: the passage as a Markdown quote, then the note. */
function quoteBlock({ quote, note }: ConversationComment): string {
  const quoted = quote
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>'));
  return ['Comment on this part of the conversation:', '', ...quoted, '', note.trim()].join('\n');
}
