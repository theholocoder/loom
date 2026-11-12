// How a Session whose run ended early can go on: Retry sends again a prompt
// that went unanswered; Continue has the agent carry on with a run that was
// stopped, interrupted by Loom quitting, or failed partway through its answer
// (not an error after it had ended, which leaves nothing to go on with).
// Main refuses either unless this says so; the renderer offers each on the
// card that ends the conversation by the same rule.
import type { Session, TranscriptItem } from './api';

export type GoingOn = 'retry' | 'continue';

/**
 * By kind, whether an item before an error is the agent's work in the run
 * that failed, as opposed to a card Loom added between runs. Every kind is
 * listed, so that a new one is decided here.
 */
const PARTWAY: Record<TranscriptItem['kind'], boolean> = {
  agent: true,
  thinking: true,
  tool: true,
  plan: true,
  question: true,
  approval: true,
  trust: true,
  user: false,
  error: false,
  interruption: false,
  model: false,
  'merge-request': false,
  'merge-request-refused': false,
  'merge-request-ended': false,
  feedback: false,
  'feedback-info': false,
};

/** How the Session can go on from where its conversation ends, if its run ended early. */
export function goingOn(session: Pick<Session, 'status' | 'waitingReason' | 'worktreeMissing'>, items: readonly TranscriptItem[]): GoingOn | undefined {
  if (session.status !== 'waiting' || session.worktreeMissing) return undefined;
  const last = items.at(-1);
  switch (session.waitingReason) {
    case 'interrupted':
      return 'continue';
    case 'stopped':
      return last?.kind === 'interruption' && last.by === 'stop' ? 'continue' : undefined;
    case 'error': {
      if (last?.kind !== 'error' || last.betweenRuns) return undefined;
      const before = items.at(-2);
      if (before?.kind === 'user') return 'retry';
      return before && PARTWAY[before.kind] ? 'continue' : undefined;
    }
    default:
      return undefined;
  }
}
