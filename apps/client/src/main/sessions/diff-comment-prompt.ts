// The blocks the user's comments on a Session's diff become, after the text
// of the prompt they go with.
import { diffCommentRange, type DiffComment } from '../../shared/api';

/** The blocks for the comments sent with a prompt, none when absent; rejects a comment that isn't whole, or has no note. */
export function diffCommentBlocks(comments: DiffComment[] | undefined): string[] {
  return checkComments(comments).map(commentBlock);
}

/** The diff comments sent with a prompt, none when absent; rejects one that isn't whole, or has no note. */
function checkComments(comments: DiffComment[] | undefined): DiffComment[] {
  if (comments === undefined) return [];
  if (!Array.isArray(comments)) throw new Error('Diff comments must be a list.');
  for (const { path, start, end, lines, note } of comments) {
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
