// Approval requests: the agent paused before an action reaching beyond its
// Session's working copy. The card shows the exact command or paths, and
// decides it: Approve once, Approve for this Session (naming the category),
// or Deny with an optional message to the agent. Kept, read-only, once decided.
import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { APPROVAL_CATEGORIES, type ApprovalDecision, type ApprovalState, type TranscriptItem } from '../shared/api';
import { AskCard, ErrorAlert, useAction } from './Questions';

type Approval = Extract<TranscriptItem, { kind: 'approval' }>;

const STATES: Record<ApprovalState, string | undefined> = {
  asked: undefined,
  approved: 'Approved once',
  'approved-session': 'Approved for this Session',
  denied: 'Denied',
  expired: 'No longer asked',
};

/** An Approval request's card: its decisions while asked, what was decided once settled. */
export function ApprovalCard({ item, onDecide }: { item: Approval; onDecide: (decision: ApprovalDecision, message?: string) => Promise<void> }) {
  const asked = item.state === 'asked';
  const { busy, error, run } = useAction();
  const [message, setMessage] = useState('');
  const category = item.category ? APPROVAL_CATEGORIES[item.category] : undefined;
  const decide = (decision: ApprovalDecision) => run(() => onDecide(decision, decision === 'deny' && message.trim() ? message.trim() : undefined));
  return (
    <AskCard label="Approval request" icon={<ShieldAlert className="sm" />} name={item.tool} asked={asked} state={STATES[item.state]}>
      <pre className="tech approval-detail">{item.detail}</pre>
      {category && <p className="muted ask-hint">{category.label}</p>}
      {item.defaultBranch && asked && <p className="muted ask-hint">{`A push to ${item.defaultBranch}, the default branch, always asks.`}</p>}
      {!asked && item.message && <p className="ask-hint">{`Told the agent: ${item.message}`}</p>}
      {asked && (
        <>
          <ErrorAlert error={error} />
          <input
            className="approval-message"
            aria-label="Message to the agent"
            placeholder="Message to the agent, if you deny it (optional)"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <div className="opts">
            <button className="primary" type="button" disabled={busy} onClick={() => void decide('once')}>
              Approve once
            </button>
            {category && !item.defaultBranch && (
              <button type="button" disabled={busy} onClick={() => void decide('session')}>
                {`Approve for this Session: ${category.label}`}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void decide('deny')}>
              Deny
            </button>
          </div>
        </>
      )}
    </AskCard>
  );
}
