// How a Merge request and its checks look wherever Loom shows them: the
// Glance strip, its checks popover, the Merge request Panel and its tab, and
// its review threads' notes on the diff.
import { CircleCheck, CircleMinus, CircleX, Clock, GitMerge, GitPullRequestClosed } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BabysitCheck, BabysitCheckState, EndedMergeRequestState, Project, Session } from '../shared/api';

/** Whether the Session can act on its Project's Forge: not archived, its worktree there, the Forge on. */
export function canActOnForge(session: Session, project: Project | undefined): boolean {
  return session.status !== 'archived' && !session.worktreeMissing && project?.forge.state === 'available';
}

/** One CI check's state, as a word and an icon in its tone. */
export const CHECK_STATES: Record<BabysitCheckState, { label: string; icon: ReactNode }> = {
  passed: { label: 'Passed', icon: <CircleCheck className="sm tone-passed" /> },
  failed: { label: 'Failed', icon: <CircleX className="sm tone-failed" /> },
  pending: { label: 'Pending', icon: <Clock className="sm tone-pending" /> },
  'not-run': { label: 'Not run', icon: <CircleMinus className="sm muted" /> },
};

/** A merged or closed Merge request's state, as a word, an icon and its tone. */
export const ENDED_LOOKS: Record<EndedMergeRequestState, { label: string; icon: ReactNode; tone: string }> = {
  merged: { label: 'Merged', icon: <GitMerge className="sm" />, tone: 'tone-accent' },
  closed: { label: 'Closed', icon: <GitPullRequestClosed className="sm" />, tone: 'tone-failed' },
};

/** "1 failed, 5 passed": the checks by state, the ones needing attention first. */
export function checksSummary(checks: BabysitCheck[]): string {
  const order: BabysitCheckState[] = ['failed', 'passed', 'pending', 'not-run'];
  return order
    .flatMap((state) => {
      const count = checks.filter((check) => check.state === state).length;
      return count ? [`${count} ${CHECK_STATES[state].label.toLowerCase()}`] : [];
    })
    .join(', ');
}

/** "1 review", "3 reviews"; with `more`, "100+ files", the Forge having listed only so many. */
export function countText(count: number, noun: string, more = false): string {
  return `${count}${more ? '+' : ''} ${count === 1 && !more ? noun : `${noun}s`}`;
}

/** Someone's initials, standing in for their picture. */
export function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** "just now", "12 min ago", "3 h ago", "Yesterday", then the date. */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 48 * 60) return 'Yesterday';
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
