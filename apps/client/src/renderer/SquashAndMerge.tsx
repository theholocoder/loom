// Squash and merge, from the Merge request Panel (docs/prototypes/side-panels.html,
// shot B6-merge-dialog): a dialog naming the squash commit's title, which the
// user may change, and how many commits it squashes, warning when checks are
// failing or reviews ask for changes. Confirming it is the user's own say:
// no Approval request follows.
import { GitMerge, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { mergeRequestRef, type BabysitCheck, type ForgeKind, type MergeRequestDetails, type MergeRequestReview, type MergeRequestState, type Session } from '../shared/api';
import { ErrorText } from './ErrorText';
import { useApi } from './api';
import { countText } from './MergeRequestLooks';

/** The squash commit's title until the user changes it, as the Forge would give it: GitHub adds the number. */
function squashTitle(kind: ForgeKind | undefined, details: MergeRequestDetails): string {
  return kind === 'github' ? `${details.title} (#${details.number})` : details.title;
}

/** Who asks for changes now: each reviewer's latest verdict counts, a comment leaving it as it was. */
function changesRequestedBy(reviews: MergeRequestReview[]): string[] {
  const verdicts = new Map<string, MergeRequestReview['verdict']>();
  for (const review of reviews) if (review.verdict !== 'commented') verdicts.set(review.author, review.verdict);
  return [...verdicts].flatMap(([author, verdict]) => (verdict === 'changes-requested' ? [author] : []));
}

/**
 * The dialog asking to squash and merge `details`, `session`'s Merge request
 * on a `kind` Forge, with `checks` as last seen. `onMerged` gets its state
 * once the Forge took it; what the Forge refused shows in the dialog.
 */
export function SquashAndMergeDialog({
  session,
  kind,
  details,
  checks,
  onMerged,
  onCancel,
}: {
  session: Session;
  kind: ForgeKind | undefined;
  details: MergeRequestDetails;
  checks: BabysitCheck[];
  onMerged: (state: MergeRequestState | undefined) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const ids = useId();
  const [title, setTitle] = useState(() => squashTitle(kind, details));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const ref = mergeRequestRef(kind, details.number);
  const failing = checks.filter((check) => check.state === 'failed').map((check) => check.name);
  const askingForChanges = changesRequestedBy(details.reviews);
  const confirm = () => {
    setError(undefined);
    setBusy(true);
    api
      .invoke('sessions.squashAndMerge', { id: session.id, title, head: details.head ?? '' })
      .then(({ state }) => onMerged(state))
      .catch((e: unknown) => {
        setError((e as Error).message);
        setBusy(false);
      });
  };
  return createPortal(
    <div
      className="scrim"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="card modal merge-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-text`}>
        <div className="card-head">
          <GitMerge className="sm" />
          <h3 id={`${ids}-title`}>
            Squash and merge <span className="tech">{ref}</span>?
          </h3>
        </div>
        <p id={`${ids}-text`}>
          {countText(details.commits, 'commit', details.moreCommits)} will be squashed into one commit on <span className="tech">{details.targetBranch}</span>:
        </p>
        <input aria-label="Squash commit title" className="tech" value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
        {(failing.length > 0 || askingForChanges.length > 0) && (
          <div className="warnings">
            {failing.length > 0 && (
              <p className="warnline">
                <TriangleAlert className="sm" />
                <span>
                  {'CI failed on '}
                  {failing.map((name, i) => (
                    <span key={`${name}:${i}`}>
                      {i > 0 && ', '}
                      <span className="tech">{name}</span>
                    </span>
                  ))}
                  .
                </span>
              </p>
            )}
            {askingForChanges.length > 0 && (
              <p className="warnline">
                <TriangleAlert className="sm" />
                <span>{`${listed(askingForChanges)} asked for changes.`}</span>
              </p>
            )}
            <p className="warnline">Merge anyway?</p>
          </div>
        )}
        {error && (
          <div className="err" role="alert">
            <ErrorText text={error} />
          </div>
        )}
        <div className="row modal-actions">
          <button ref={cancel} type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy || !title.trim()} onClick={confirm}>
            <GitMerge className="sm" />
            {busy ? 'Merging…' : 'Squash and merge'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "erin", "erin and bob", "erin, bob and carol". */
function listed(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
