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
          {/* The approvals first; Deny last, with the message that goes with it. */}
          <div className="opts approval-actions">
            <button className="primary" type="button" disabled={busy} onClick={() => void decide('once')}>
              Approve once
            </button>
            {category && !item.defaultBranch && (
              // The category is said above the buttons; the name says it again for a screen reader.
              <button type="button" aria-label={`Approve for this Session: ${category.label}`} title={`Approve every “${category.label}” request for the rest of this Session`} disabled={busy} onClick={() => void decide('session')}>
                Approve for this Session
              </button>
            )}
          </div>
          <div className="approval-deny">
            <input
              className="approval-message"
              type="text"
              aria-label="Message to the agent if you deny it"
              placeholder="Tell the agent why (optional)"
              value={message}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
              // Enter denies with the message, rather than sending anything else.
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (!busy) void decide('deny');
              }}
            />
            <button className="deny" type="button" disabled={busy} onClick={() => void decide('deny')}>
              Deny
            </button>
          </div>
        </>
      )}
    </AskCard>
  );
}
