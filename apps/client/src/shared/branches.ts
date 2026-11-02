// Naming the branches Loom creates for worktree Sessions. Shared so the
// composer shows the name main will use.

const MAX_SLUG_LENGTH = 40;

/**
 * A branch-safe slug of the first line of `text`: lowercase ASCII letters and
 * digits joined by `-`, cut at a word boundary. `session` when nothing is left.
 */
export function slugOf(text: string): string {
  const words = (text.split('\n', 1)[0] ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG_LENGTH) {
      if (!slug) slug = word.slice(0, MAX_SLUG_LENGTH);
      break;
    }
    slug = next;
  }
  return slug || 'session';
}

/** The branch Loom suggests for a worktree Session: `<prefix>/<slug of the prompt>`. */
export function suggestBranch(prefix: string, prompt: string): string {
  return `${prefix}/${slugOf(prompt)}`;
}
