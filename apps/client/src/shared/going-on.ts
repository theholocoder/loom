// How a Session whose run ended early can go on: Retry sends again a prompt
// that went unanswered; Continue has the agent carry on with a run that was
// stopped, interrupted by Loom quitting, or failed partway through its answer.
// Main refuses either unless this says so; the renderer offers each on the
// card that ends the conversation by the same rule.
import type { Session, TranscriptItem } from './api';

export type GoingOn = 'retry' | 'continue';

/** What the agent can have done before a run fails partway, as opposed to a card Loom added between runs. */
const PARTWAY: ReadonlySet<TranscriptItem['kind']> = new Set(['agent', 'thinking', 'tool', 'plan', 'question', 'approval', 'trust']);

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
      if (last?.kind !== 'error') return undefined;
      const before = items.at(-2);
      if (before?.kind === 'user') return 'retry';
      return before && PARTWAY.has(before.kind) ? 'continue' : undefined;
    }
    default:
      return undefined;
  }
}
