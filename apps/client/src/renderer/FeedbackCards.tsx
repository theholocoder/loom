// What Babysit found on the Session's Merge request, in its transcript: a card
// of feedback the agent may need to act on, and quiet notes of progress.
import { CircleCheckBig, MessageSquareWarning } from 'lucide-react';
import { codePlace, MAX_AUTO_PROMPTS, mergeRequestRef, type BabysitCi, type FeedbackItem, type ForgeKind, type TranscriptItem } from '../shared/api';
import { AskCard, ErrorAlert, useAction } from './Questions';

export const CI_LABELS: Record<BabysitCi, string> = { pending: 'CI pending', passed: 'CI passed', failed: 'CI failed' };

/** The feedback, its CI status, Send to agent while it can be sent, and Open on Forge. */
export function FeedbackCard({
  item,
  forge,
  readOnly,
  onSend,
  onOpen,
}: {
  item: Extract<TranscriptItem, { kind: 'feedback' }>;
  forge: ForgeKind | undefined;
  readOnly: boolean;
  onSend: () => Promise<void>;
  onOpen: (url: string) => void;
}) {
  const { busy, error, run } = useAction();
  const sent = item.state === 'sent';
  const ref = mergeRequestRef(forge, item.number);
  return (
    <AskCard label={`Feedback on Merge request ${ref}`} icon={<MessageSquareWarning className="sm" />} name={`Feedback on ${ref}`} asked={!sent && !readOnly} hint="New feedback from the Forge" state={sent ? 'Sent to the agent' : undefined}>
      <ul className="feedback-items">
        {item.items.map((entry, at) => (
          <li key={at}>
            <Entry entry={entry} onOpen={onOpen} />
          </li>
        ))}
      </ul>
      {item.ci && <p className="muted ask-hint">{CI_LABELS[item.ci]}</p>}
      {item.paused && !sent && <p className="muted ask-hint">Auto-prompt paused after {MAX_AUTO_PROMPTS} attempts with no message from you. Sending this, or any message, starts it again.</p>}
      <ErrorAlert error={error} />
      <div className="opts">
        {!sent && !readOnly && (
          <button className="primary" type="button" disabled={busy} onClick={() => void run(onSend)}>
            Send to agent
          </button>
        )}
        <button type="button" onClick={() => onOpen(item.url)}>
          Open on Forge
        </button>
      </div>
    </AskCard>
  );
}

function Entry({ entry, onOpen }: { entry: FeedbackItem; onOpen: (url: string) => void }) {
  switch (entry.kind) {
    case 'review':
      return (
        <>
          <Linked url={entry.url} onOpen={onOpen}>{`${entry.author} ${entry.verdict === 'changes-requested' ? 'requested changes' : 'reviewed'}`}</Linked>
          {entry.excerpt && <p className="feedback-excerpt">{entry.excerpt}</p>}
          {entry.comments.length > 0 && (
            <ul className="feedback-items">
              {entry.comments.map((comment) => (
                <li key={comment.url}>
                  <Linked url={comment.url} onOpen={onOpen} tech>{codePlace(comment)}</Linked>
                  <p className="feedback-excerpt">{comment.excerpt}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    case 'comment':
      return (
        <>
          <Linked url={entry.url} onOpen={onOpen}>{`${entry.author} commented${entry.path ? ` on ${codePlace(entry)}` : ''}`}</Linked>
          <p className="feedback-excerpt">{entry.excerpt}</p>
        </>
      );
    case 'ci-failed':
      return (
        <>
          Failing checks:{' '}
          {entry.checks.map((check, at) => (
            <span key={check.name}>
              {at > 0 && ', '}
              {check.url ? (
                <Linked url={check.url} onOpen={onOpen} tech>
                  {check.name}
                </Linked>
              ) : (
                <span className="tech">{check.name}</span>
              )}
            </span>
          ))}
        </>
      );
    case 'conflicts':
      return <>Conflicts with its target branch</>;
  }
}

function Linked({ url, onOpen, tech, children }: { url: string; onOpen: (url: string) => void; tech?: boolean; children: string }) {
  return (
    <button type="button" className={`feedback-link${tech ? ' tech' : ''}`} onClick={() => onOpen(url)}>
      {children}
    </button>
  );
}

/** "alice approved · Open", "CI passed · Open": nothing to do, nobody woken. */
export function FeedbackInfoCard({ item, onOpen }: { item: Extract<TranscriptItem, { kind: 'feedback-info' }>; onOpen: () => void }) {
  return (
    <div className="interruption merge-request" role="note">
      <CircleCheckBig className="sm" />
      <span>{item.event === 'approved' ? `${item.author} approved the Merge request` : 'CI passed'}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="link" onClick={onOpen}>
        Open
      </button>
    </div>
  );
}
