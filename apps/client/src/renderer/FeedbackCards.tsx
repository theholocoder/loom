// What Babysit found on the Session's Merge request, in its transcript: a card
// of feedback the agent may need to act on, and quiet notes of progress.
import { CircleCheckBig, CircleX, Eye, GitMerge, GitPullRequestClosed, MessageSquare, type LucideIcon } from 'lucide-react';
import { codePlace, MAX_AUTO_PROMPTS, mergeRequestRef, FORGE_NAMES, type BabysitCi, type EndedMergeRequestState, type FeedbackItem, type ForgeKind, type TranscriptItem } from '../shared/api';
import { ErrorAlert, useAction } from './Questions';
import { unsavedWorkSummary } from './Archive';

const CI_LABELS: Record<BabysitCi, string> = { pending: 'CI pending', passed: 'CI passed', failed: 'CI failed' };

/** How a Merge request no longer open shows: its icon, and what became of it. */
export const ENDED: Record<EndedMergeRequestState, { icon: LucideIcon; label: string }> = {
  merged: { icon: GitMerge, label: 'Merged' },
  closed: { icon: GitPullRequestClosed, label: 'Closed' },
};

/**
 * The feedback, in the style of the agent's tool calls: each item on one line,
 * its places in the code taking Changes to their notes; its CI status, Send to
 * agent while it can be sent, and Open on GitHub or GitLab.
 */
export function FeedbackCard({
  item,
  forge,
  readOnly,
  onSend,
  onOpen,
  onShowPlace,
}: {
  item: Extract<TranscriptItem, { kind: 'feedback' }>;
  forge: ForgeKind | undefined;
  readOnly: boolean;
  onSend: () => Promise<void>;
  onOpen: (url: string) => void;
  /** Shows the file a comment is on in Changes, where its note is. */
  onShowPlace: (path: string) => void;
}) {
  const { busy, error, run } = useAction();
  const sent = item.state === 'sent';
  const asked = !sent && !readOnly;
  const ref = mergeRequestRef(forge, item.number);
  // A failed CI is an item of its own already.
  const ci = item.ci && !item.items.some((entry) => entry.kind === 'ci-failed') ? CI_LABELS[item.ci] : undefined;
  return (
    <div className="tools">
      <div className={`tool feedback${asked ? ' asked' : ''}`} role="group" aria-label={`Feedback on Merge request ${ref}`}>
        <div className="tool-head">
          <Eye className="sm" />
          <span className="tool-name">babysit</span>
          <span className="grow muted tool-title">{`New feedback on Merge request ${ref}`}</span>
          {sent && <span className="chip">Sent to the agent</span>}
        </div>
        <div className="tool-body">
          <ul className="feedback-lines">
            {item.items.map((entry, at) => (
              <FeedbackLine key={at} entry={entry} onOpen={onOpen} onShowPlace={onShowPlace} />
            ))}
          </ul>
          {ci && <p className="muted ask-hint">{ci}</p>}
          {item.paused && !sent && <p className="muted ask-hint">Auto-prompt paused after {MAX_AUTO_PROMPTS} attempts with no message from you. Sending this, or any message, starts it again.</p>}
          <ErrorAlert error={error} />
          <div className="opts">
            {asked && (
              <button className="primary" type="button" disabled={busy} onClick={() => void run(onSend)}>
                Send to agent
              </button>
            )}
            <button type="button" onClick={() => onOpen(item.url)}>
              Open on {forge ? FORGE_NAMES[forge] : 'the Forge'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One item of the feedback on one line, with its icon; what it says in full on hover. */
function FeedbackLine({ entry, onOpen, onShowPlace }: { entry: FeedbackItem; onOpen: (url: string) => void; onShowPlace: (path: string) => void }) {
  const places = (comments: Array<{ path: string; line?: number }>) =>
    comments.map((comment, at) => (
      <span key={at}>
        {at > 0 && ', '}
        <button type="button" className="feedback-link tech" onClick={() => onShowPlace(comment.path)}>
          {codePlace(comment)}
        </button>
      </span>
    ));
  switch (entry.kind) {
    case 'review': {
      const verdict = `${entry.author} ${entry.verdict === 'changes-requested' ? 'requested changes' : 'reviewed'}`;
      const count = entry.comments.length;
      return (
        <li title={entry.excerpt || undefined}>
          <MessageSquare className={`sm ${entry.verdict === 'changes-requested' ? 'tone-pending' : 'tone-accent'}`} />
          <span className="feedback-line">
            <Linked url={entry.url} onOpen={onOpen}>{verdict}</Linked>
            {count > 0 ? (
              <>
                {`: ${count} ${count === 1 ? 'comment' : 'comments'} on `}
                {places(entry.comments)}
              </>
            ) : (
              entry.excerpt && <span className="muted">{`: ${entry.excerpt}`}</span>
            )}
          </span>
        </li>
      );
    }
    case 'comment':
      return (
        <li title={entry.excerpt || undefined}>
          <MessageSquare className="sm tone-accent" />
          <span className="feedback-line">
            <Linked url={entry.url} onOpen={onOpen}>{`${entry.author} commented`}</Linked>
            {entry.path ? (
              <>
                {' on '}
                {places([{ path: entry.path, ...(entry.line ? { line: entry.line } : {}) }])}
              </>
            ) : (
              <span className="muted">{`: ${entry.excerpt}`}</span>
            )}
          </span>
        </li>
      );
    case 'ci-failed':
      return (
        <li>
          <CircleX className="sm tone-failed" />
          <span className="feedback-line">
            {'CI failed: '}
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
          </span>
        </li>
      );
    case 'conflicts':
      return (
        <li>
          <GitMerge className="sm tone-failed" />
          <span className="feedback-line">Conflicts with its target branch</span>
        </li>
      );
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

/**
 * "Merge request #12 was merged. Loom archived this Session.", or, a worktree
 * holding unsaved work, why it wasn't and what is left to do.
 */
export function MergeRequestEndedCard({ item, forge, onOpen }: { item: Extract<TranscriptItem, { kind: 'merge-request-ended' }>; forge: ForgeKind | undefined; onOpen: () => void }) {
  const Icon = ENDED[item.state].icon;
  const ended = `Merge request ${mergeRequestRef(forge, item.number)} was ${item.state === 'merged' ? 'merged' : 'closed without merging'}`;
  const outcome = item.archived
    ? `${ended}. Loom archived this Session.`
    : item.unsavedWork
      ? `${ended}, but this Session's worktree has ${unsavedWorkSummary(item.unsavedWork)}, so Loom didn't archive it. Archive it, or carry on.`
      : `${ended}, but Loom couldn't archive this Session.`;
  return (
    <div className="interruption merge-request" role="note">
      <Icon className="sm" />
      <span>{outcome}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="link" onClick={onOpen}>
        Open
      </button>
    </div>
  );
}
