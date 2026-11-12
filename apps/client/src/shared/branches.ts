// Naming the branches Loom creates for worktree Sessions. Shared so the
// composer shows the name main will use.
import type { ExistingBranch } from './api';

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

/** The branch Loom suggests for a worktree Session started from an issue: `<prefix>/<issue#>-<slug of its title>`. */
export function issueBranch(prefix: string, issue: { number: number; title: string }): string {
  return `${prefix}/${issue.number}-${slugOf(issue.title)}`;
}

/** How git names a branch on `origin` or a local one: `origin/<name>`, or its name. */
export function branchName(branch: ExistingBranch): string {
  return branch.remote ? `origin/${branch.name}` : branch.name;
}

/**
 * Why git would refuse `<prefix>/<slug>` as a branch name, following
 * `git check-ref-format --branch`; undefined if it wouldn't.
 */
export function branchPrefixProblem(prefix: string): string | undefined {
  if (!prefix) return 'it is empty';
  if (prefix.startsWith('-')) return "it starts with '-'";
  if (prefix === '@') return "it is '@'";
  // Control characters and DEL, then the characters git reserves.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(prefix)) return 'it contains a space, a control character or one of ~ ^ : ? * [ \\';
  if (prefix.includes('..')) return "it contains '..'";
  if (prefix.includes('@{')) return "it contains '@{'";
  const parts = prefix.split('/');
  if (parts.some((part) => part === '')) return "it starts or ends with '/', or contains '//'";
  if (parts.some((part) => part.startsWith('.'))) return "a part of it starts with '.'";
  if (parts.some((part) => part.endsWith('.lock'))) return "a part of it ends with '.lock'";
  return undefined;
}

/**
 * Why git would refuse `name` as a branch name, following
 * `git check-ref-format --branch`; undefined if it wouldn't.
 */
export function branchNameProblem(name: string): string | undefined {
  return branchPrefixProblem(name) ?? (name.endsWith('.') ? "it ends with '.'" : undefined);
}
