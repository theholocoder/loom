// The Merge request Panel (docs/prototypes/side-panels.html): the Session's
// Merge request as its Forge has it, read when the Panel shows and again
// after each Babysit poll. Its state, branches, title, author, reviewers,
// commits and changes; the Babysit and Auto-prompt switches; then, on its
// Overview tab, its checks, its reviews and comments and its description, or
// on its Diff tab what it changes; and, at the foot, squashing and merging
// it, opening it on the Forge, asking the agent to update it, or linking
// another. With none linked, it offers to create or link one.
import { Bot, ExternalLink, Eye, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestCreate, GitPullRequestDraft, Link, MessageSquare, RotateCw, User } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { codePlace, forgeName as forgeNameOf, mergeRequestRef, type MergeRequestComment, type MergeRequestDetails, type MergeRequestReview, type Project, type ReviewVerdict, type Session } from '../shared/api';
import { ErrorText } from './ErrorText';
import { useApi } from './api';
import { useDates } from './dates';
import type { DiffComments } from './Changes';
import { MergeRequestDiffView } from './MergeRequestDiff';
import { usePanelRequest, usePanelState, type PanelState } from './panel-context';
import type { ReviewNotes } from './ReviewNotes';
import { useMergeRequestRead } from './forge-read';
import { Markdown } from './Markdown';
import { useNow } from './now';
import { attempt } from './SessionDetails';
import { SquashAndMergeDialog } from './SquashAndMerge';
import { Avatar, canActOnForge, CHECK_STATES, checksSummary, countText, ENDED_LOOKS } from './MergeRequestLooks';

/** The Panel's tabs: its checks, reviews and description, or its diff. */
export type MergeRequestTab = 'overview' | 'diff';
const TABS: MergeRequestTab[] = ['overview', 'diff'];

/** What the Panel keeps its tab under (see `usePanelState`). */
const TAB = 'tab';

/** Whether the Panel, as it keeps itself, can take Review mode: on its Diff tab only. */
export function mergeRequestCanReview(state: PanelState): boolean {
  return state[TAB] === 'diff';
}

const VERDICTS: Record<ReviewVerdict, { label: string; className: string }> = {
  approved: { label: 'Approved', className: 'chip verdict approved' },
  'changes-requested': { label: 'Changes requested', className: 'chip verdict changes' },
  commented: { label: 'Commented', className: 'chip verdict' },
  dismissed: { label: 'Dismissed', className: 'chip verdict' },
};

/**
 * The Merge request Panel of `session`, on the tab it was last left on: its
 * Overview at first. Leaving the Diff tab calls `onLeftDiff`. What goes wrong
 * running an action goes to `onError`; a request (see `usePanelRequest`)
 * opens the link form or scrolls to the reviews and comments, on the
 * Overview. The Diff tab's lines can be commented on while `comments` is
 * given, and show the review threads in `reviewNotes` as notes.
 */
export function MergeRequestPanel({
  session,
  project,
  comments,
  reviewNotes,
  onLeftDiff,
  onError,
}: {
  session: Session;
  project: Project | undefined;
  comments?: DiffComments;
  reviewNotes?: ReviewNotes;
  onLeftDiff: () => void;
  onError: (message: string | undefined) => void;
}) {
  const api = useApi();
  const [linking, setLinking] = useState(false);
  /** Whether the Squash and merge dialog is open. */
  const [merging, setMerging] = useState(false);
  /** Set once the Forge took the merge but left it open, to merge it later: the URL it was taken for. */
  const [queued, setQueued] = useState<string>();
  const reviews = useRef<HTMLHeadingElement>(null);
  const { mergeRequest } = session;
  const canAct = canActOnForge(session, project);
  /** Moves on each refresh: the overview and the diff are read again. */
  const [generation, setGeneration] = useState(0);
  const refresh = () => setGeneration((n) => n + 1);
  const read = useMergeRequestRead('sessions.mergeRequest', session, generation);
  const ids = useId();
  /** Set while the reviews are to be scrolled to: again once read, as what comes above them pushes them down. */
  const toReviews = useRef(false);
  const [tab, setTab] = usePanelState<MergeRequestTab>('merge-request', TAB, 'overview');
  const onTab = (next: MergeRequestTab) => {
    setTab(next);
    if (next !== 'diff') onLeftDiff();
  };
  /** Counts the asks for the reviews, which are scrolled to on each. */
  const [reviewsAsked, setReviewsAsked] = useState(0);
  usePanelRequest('merge-request', (to) => {
    if (to === 'link') return setLinking(true);
    // The reviews are on the Overview.
    onTab('overview');
    toReviews.current = true;
    setReviewsAsked((n) => n + 1);
  });
  useEffect(() => {
    if (!toReviews.current) return;
    reviews.current?.focus({ preventScroll: true });
    reviews.current?.scrollIntoView?.({ block: 'start' });
    if (read.value) toReviews.current = false;
  }, [reviewsAsked, read.value, tab]);
  const ask = () => attempt(onError, () => api.invoke('sessions.requestMergeRequest', { id: session.id }));
  const linkForm = canAct && linking && <LinkMergeRequestForm session={session} onLinked={() => setLinking(false)} onCancel={() => setLinking(false)} />;
  const linkButton = canAct && (
    <button type="button" aria-expanded={linking} onClick={() => setLinking(!linking)}>
      <Link className="sm" />
      Link Merge request…
    </button>
  );

  if (!mergeRequest) {
    return (
      <div className="mr-panel">
        <div className="mr-none">
          <GitPullRequestCreate />
          <h2>No Merge request yet</h2>
          <p className="muted">{canAct ? 'Ask the agent to open one for this branch, or link one it opened elsewhere.' : "This Session has no Merge request, and can't make one now."}</p>
          {canAct && (
            <div className="acts">
              <button className="primary" type="button" onClick={ask}>
                <GitPullRequestCreate className="sm" />
                Create Merge request
              </button>
              {linkButton}
            </div>
          )}
          {linkForm}
        </div>
      </div>
    );
  }

  const ref = mergeRequestRef(project?.forge.kind, mergeRequest.number);
  const details = read.value;
  const state = details?.state ?? session.mergeRequestState;
  // Babysit's checks are the latest; with Babysit off, the Panel's own read.
  const live = session.babysit?.checks;
  const checks = live ?? details?.checks;
  const ci = live ? session.babysit?.ci : details?.ci;
  const checkedAt = live ? session.babysit?.lastPollAt : read.at;
  const dates = useDates();
  // Babysit looks after an open one only.
  const watchable = session.status !== 'archived' && project?.forge.state === 'available' && state === 'open';
  const watching = !session.babysitOff;
  const forgeName = forgeNameOf(project?.forge.kind);
  // Offered on an open one; held back until it is read, and while it is a draft, which the Forge won't merge.
  const mergeable = canAct && state === 'open';
  const mergeBlockedBy = !details ? `Reading it from ${forgeName}…` : details.draft ? `${ref} is a draft: mark it ready on ${forgeName} first.` : !details.head ? `${forgeName} didn't say which commit ${ref} is at.` : undefined;
  // GitLab's +/− counts only the files it listed.
  const more = details?.moreFiles ? '+' : '';
  const stateChip =
    state === 'merged' || state === 'closed' ? (
      <span className={`chip ${ENDED_LOOKS[state].tone}`}>
        {ENDED_LOOKS[state].icon}
        {ENDED_LOOKS[state].label}
      </span>
    ) : details?.draft ? (
      <span className="chip">
        <GitPullRequestDraft className="sm" />
        Draft
      </span>
    ) : (
      state === 'open' && (
        <span className="chip state-open">
          <GitPullRequest className="sm" />
          Open
        </span>
      )
    );

  /** The arrow keys, Home and End move between the tabs. */
  const step = (event: KeyboardEvent) => {
    const at = TABS.indexOf(tab);
    const to = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length]!;
    onTab(next);
    event.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(`${ids}-tab-${next}`)}`)?.focus();
  };

  return (
    <div className="mr-panel">
      <div className={tab === 'diff' ? 'mr-scroll on-diff' : 'mr-scroll'}>
        <header className="mr-head">
          <div className="mr-meta">
            {stateChip}
            <span className="tech">{ref}</span>
            {details && (
              <span className="row branches" title={`${details.sourceBranch} into ${details.targetBranch}`}>
                <GitBranch className="sm" />
                <span className="tech">{details.sourceBranch}</span>→<span className="tech">{details.targetBranch}</span>
              </span>
            )}
            {session.babysit?.stale && (
              <span className="chip stale" title="Loom couldn't reach the Forge on its last check: this may be out of date.">
                Stale
              </span>
            )}
            <button className="icon-btn sm refresh" type="button" title="Read it again from the Forge" aria-label="Refresh the Merge request" disabled={read.loading} onClick={refresh}>
              <RotateCw />
            </button>
          </div>
          <h2>{details ? details.title : `Merge request ${ref}`}</h2>
          {details && (
            <div className="mr-meta">
              <span className="row">
                <User className="sm" />
                by {details.author}
              </span>
              {details.reviewers.length > 0 && (
                <span className="row reviewers">
                  {details.reviewers.length === 1 ? 'Reviewer' : 'Reviewers'}
                  {details.reviewers.map((reviewer) => (
                    <span key={reviewer} className="row">
                      <Avatar name={reviewer} />
                      {reviewer}
                    </span>
                  ))}
                </span>
              )}
              <span className="row">
                <GitCommitHorizontal className="sm" />
                {countText(details.commits, 'commit', details.moreCommits)}
              </span>
              <span
                className="diff-stat"
                title={details.moreFiles ? `${forgeName} listed only the first ${details.files} files: there are more, and more lines changed.` : undefined}
                aria-label={`${countText(details.files, 'file', details.moreFiles)}, ${details.added}${more} added, ${details.removed}${more} removed`}
              >
                <span className="files">{countText(details.files, 'file', details.moreFiles)}</span>
                <span className="add">
                  +{details.added}
                  {more}
                </span>
                <span className="del">
                  −{details.removed}
                  {more}
                </span>
              </span>
            </div>
          )}
          {read.loading && !details && (
            <p className="muted" role="status">
              Reading it from {forgeName}…
            </p>
          )}
          {read.error && (
            <div className="err" role="alert">
              <ErrorText text={`Couldn't read it from ${forgeName}: ${read.error}`}>
                {' '}
                <button type="button" className="link" onClick={refresh}>
                  Try again
                </button>
              </ErrorText>
            </div>
          )}
        </header>
        {(watchable || canAct) && (
          <div className="switches">
            {watchable && (
              <Switch
                label="Babysit"
                icon={<Eye className="sm" />}
                on={watching}
                hint={watching ? 'New reviews, failed checks and conflicts put the Session in the Inbox.' : `Babysit is off for ${ref}.`}
                onSwitch={(on) => attempt(onError, () => api.invoke('sessions.setBabysitting', { id: session.id, on }))}
              />
            )}
            {canAct && (
              <Switch
                label="Auto-prompt"
                icon={<Bot className="sm" />}
                on={!!session.autoPrompt}
                disabled={!watching}
                hint={!watching ? 'Auto-prompt needs Babysit on.' : session.autoPrompt ? 'New feedback goes straight to the agent, up to 3 times in a row.' : 'New feedback waits for you.'}
                onSwitch={(on) => attempt(onError, () => api.invoke('sessions.setAutoPrompt', { id: session.id, on }))}
              />
            )}
          </div>
        )}
        <div className="mr-tabs" role="tablist" aria-label="Merge request" onKeyDown={step}>
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`${ids}-tab-${t}`}
              aria-selected={t === tab}
              aria-controls={`${ids}-${t}`}
              tabIndex={t === tab ? 0 : -1}
              className={t === tab ? 'on' : undefined}
              aria-label={t === 'overview' ? 'Overview' : 'Diff'}
              aria-description={t === 'diff' && details ? countText(details.files, 'file', details.moreFiles) : undefined}
              onClick={() => onTab(t)}
            >
              {t === 'overview' ? 'Overview' : 'Diff'}
              {t === 'diff' && details && (
                <span className="badge" aria-hidden="true" title={countText(details.files, 'file', details.moreFiles)}>
                  {details.files}
                  {more}
                </span>
              )}
            </button>
          ))}
        </div>
        {tab === 'diff' ? (
          <div className="mr-tab-view" role="tabpanel" id={`${ids}-diff`} aria-labelledby={`${ids}-tab-diff`}>
            <MergeRequestDiffView session={session} forge={project?.forge.kind} generation={generation} comments={comments} reviews={reviewNotes} onRefresh={refresh} />
          </div>
        ) : (
        <div role="tabpanel" id={`${ids}-overview`} aria-labelledby={`${ids}-tab-overview`}>
        <section className="mr-sec" aria-labelledby={`${ids}-checks`}>
          <h3 id={`${ids}-checks`}>
            Checks
            {checks && checks.length > 0 && <span className="summary">{checksSummary(checks)}</span>}
          </h3>
          {checks?.length ? (
            <ul className="checks">
              {checks.map((check) => (
                <li key={`${check.name}:${check.url ?? ''}`}>
                  {CHECK_STATES[check.state].icon}
                  <span className="name tech">{check.name}</span>
                  <span className="muted">{CHECK_STATES[check.state].label}</span>
                  {check.url ? (
                    <button type="button" className="link" aria-label={`Details of ${check.name}`} onClick={() => attempt(onError, () => api.invoke('links.open', { url: check.url! }))}>
                      Details
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            checks && <p className="muted">{ci ? 'No checks listed.' : 'No CI checks.'}</p>
          )}
          {checks && checkedAt !== undefined && <p className="muted checked">{`Checked ${dates.time(checkedAt)}`}</p>}
        </section>
        <section className="mr-sec" aria-labelledby={`${ids}-reviews`}>
          <h3 id={`${ids}-reviews`} ref={reviews} tabIndex={-1}>
            Reviews and comments
          </h3>
          {details && <Discussion details={details} onOpen={(url) => attempt(onError, () => api.invoke('links.open', { url }))} />}
        </section>
        <section className="mr-sec mr-desc" aria-labelledby={`${ids}-description`}>
          <h3 id={`${ids}-description`}>Description</h3>
          {details && (details.description.trim() ? <Markdown text={details.description} flavour="forge" /> : <p className="muted">No description.</p>)}
        </section>
        </div>
        )}
      </div>
      <footer className="mr-foot">
        {mergeable && (
          <button type="button" className="primary" disabled={!!mergeBlockedBy} title={mergeBlockedBy} onClick={() => setMerging(true)}>
            <GitMerge className="sm" />
            Squash and merge
          </button>
        )}
        <button type="button" onClick={() => attempt(onError, () => api.invoke('links.open', { url: mergeRequest.url }))}>
          <ExternalLink className="sm" />
          Open on {forgeName}
        </button>
        {canAct && (
          <button type="button" onClick={ask}>
            <GitPullRequest className="sm" />
            Update Merge request
          </button>
        )}
        {linkButton}
        {queued === mergeRequest.url && state === 'open' && (
          <p className="muted queued" role="status">
            {`${forgeName} will merge ${ref} once it can.`}
          </p>
        )}
      </footer>
      {linkForm && <div className="mr-link">{linkForm}</div>}
      {merging && mergeable && details && (
        <SquashAndMergeDialog
          session={session}
          kind={project?.forge.kind}
          details={details}
          checks={checks ?? []}
          onCancel={() => setMerging(false)}
          onMerged={(after) => {
            setMerging(false);
            setQueued(after === 'open' ? mergeRequest.url : undefined);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** One entry of the reviews and comments: a review, or a comment outside one. */
type Entry = { kind: 'review'; review: MergeRequestReview } | { kind: 'comment'; comment: MergeRequestComment };

/** The Merge request's reviews and comments, oldest first, each opening on the Forge. */
function Discussion({ details, onOpen }: { details: MergeRequestDetails; onOpen: (url: string) => void }) {
  const now = useNow();
  const dates = useDates();
  const entries: Entry[] = [...details.reviews.map((review) => ({ kind: 'review' as const, review })), ...details.comments.map((comment) => ({ kind: 'comment' as const, comment }))];
  // Those the Forge gives no time for keep their place at the end.
  const at = (entry: Entry) => (entry.kind === 'review' ? entry.review.at : entry.comment.at) ?? Infinity;
  entries.sort((a, b) => at(a) - at(b));
  if (!entries.length) return <p className="muted">No reviews or comments yet.</p>;
  return (
    <ul className="discussion">
      {entries.map((entry) => {
        const item = entry.kind === 'review' ? entry.review : entry.comment;
        const verdict = entry.kind === 'review' ? VERDICTS[entry.review.verdict] : undefined;
        const label = verdict ? `Review by ${item.author}: ${verdict.label}` : `Comment by ${item.author}`;
        return (
          <li key={item.url} className="review-card" aria-label={label}>
            <div className="rh">
              <Avatar name={item.author} />
              <b>{item.author}</b>
              {verdict ? <span className={verdict.className}>{verdict.label}</span> : <MessageSquare className="sm muted" aria-hidden="true" />}
              <span className="grow" />
              {item.at !== undefined && (
                <time className="muted" dateTime={new Date(item.at).toISOString()} title={dates.full(item.at)}>
                  {dates.ago(item.at, now)}
                </time>
              )}
              <button type="button" className="icon-btn xs" title="Open on the Forge" aria-label={`Open the ${verdict ? 'review' : 'comment'} by ${item.author}`} onClick={() => onOpen(item.url)}>
                <ExternalLink />
              </button>
            </div>
            {entry.kind === 'comment' && entry.comment.path ? (
              <CodeComment comment={entry.comment} onOpen={onOpen} />
            ) : (
              item.body.trim() && (
                <div className="rb">
                  <Markdown text={item.body} flavour="forge" />
                </div>
              )
            )}
            {entry.kind === 'review' && entry.review.comments.map((comment) => <CodeComment key={comment.url} comment={comment} onOpen={onOpen} />)}
          </li>
        );
      })}
    </ul>
  );
}

/** A comment on a place in the code: the place, then what it says. */
function CodeComment({ comment, onOpen }: { comment: MergeRequestComment; onOpen: (url: string) => void }) {
  return (
    <div className="quote">
      <div className="qh">
        <button type="button" className="link tech" title="Open on the Forge" onClick={() => onOpen(comment.url)}>
          {codePlace(comment)}
        </button>
      </div>
      <div className="qt">
        <Markdown text={comment.body} flavour="forge" />
      </div>
    </div>
  );
}

/** A labelled switch: its name, whether it is on, and what that means, shown under it. */
function Switch({ label, icon, on, hint, disabled, onSwitch }: { label: string; icon: ReactNode; on: boolean; hint: string; disabled?: boolean; onSwitch: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} aria-description={hint} title={hint} disabled={disabled} onClick={() => onSwitch(!on)}>
      <span className="track" aria-hidden="true">
        <span />
      </span>
      <span className="t">
        <b>
          {icon}
          {label}
        </b>
        <span>{hint}</span>
      </span>
    </button>
  );
}

/** A number or URL to link, checked on the Forge; what went wrong shows under it. */
function LinkMergeRequestForm({ session, onLinked, onCancel }: { session: Session; onLinked: () => void; onCancel: () => void }) {
  const api = useApi();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [linking, setLinking] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || linking) return;
    setLinking(true);
    setError(undefined);
    try {
      await api.invoke('sessions.linkMergeRequest', { id: session.id, mergeRequest: value.trim() });
      onLinked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinking(false);
    }
  };
  return (
    <form
      className="link-mr"
      aria-label="Link Merge request"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onCancel();
      }}
    >
      <label>
        <span>Merge request number or URL</span>
        <input autoFocus aria-label="Merge request number or URL" className="tech" placeholder="12, or its URL" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      {error && (
        <div className="err" role="alert">
          <ErrorText text={error} />
        </div>
      )}
      <div className="acts">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" type="submit" disabled={!value.trim() || linking}>
          Link
        </button>
      </div>
    </form>
  );
}
