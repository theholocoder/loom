// The Issue Panel (docs/prototypes/side-panels.html): the Session's linked
// issue as its Forge has it, read when the Panel shows and again on asking.
// Its state, `owner/repo#12`, labels, title, author and age, how many
// comments it has, then its body; at the foot, opening it on the Forge or
// unlinking it.
import { CircleCheck, CircleDot, ExternalLink, Link2Off, MessageSquare, RotateCw, User } from 'lucide-react';
import { useState } from 'react';
import { forgeName as forgeNameOf, type Project, type Session } from '../shared/api';
import { ErrorText } from './ErrorText';
import { useApi } from './api';
import { useDates } from './dates';
import { useForgeRead } from './forge-read';
import { Markdown } from './Markdown';
import { countText } from './MergeRequestLooks';
import { useNow } from './now';
import { attempt } from './SessionDetails';

/**
 * The Issue Panel of `session`. What goes wrong running an action goes to
 * `onError`; `onUnlinked` follows unlinking the issue.
 */
export function IssuePanel({ session, project, onUnlinked, onError }: { session: Session; project: Project | undefined; onUnlinked: () => void; onError: (message: string | undefined) => void }) {
  const api = useApi();
  const now = useNow();
  const dates = useDates();
  const { issue } = session;
  /** Moves on each refresh: the issue is read again. */
  const [generation, setGeneration] = useState(0);
  const read = useForgeRead('sessions.issue', session.id, issue?.url, [generation]);
  if (!issue) {
    return (
      <div className="issue-panel">
        <div className="mr-none">
          <CircleDot />
          <h2>No issue linked</h2>
          <p className="muted">Link one from the Glance strip.</p>
        </div>
      </div>
    );
  }

  const forgeName = forgeNameOf(project?.forge.kind);
  // Issues are #12 on both Forges.
  const ref = `${project?.forge.repository ?? ''}#${issue.number}`;
  const details = read.value;
  const refresh = () => setGeneration((n) => n + 1);
  const unlink = () =>
    attempt(onError, async () => {
      await api.invoke('sessions.unlinkIssue', { id: session.id });
      onUnlinked();
    });
  return (
    <div className="issue-panel">
      <div className="mr-scroll">
        <header className="mr-head">
          <div className="mr-meta">
            {details &&
              (details.state === 'open' ? (
                <span className="chip state-open">
                  <CircleDot className="sm" />
                  Open
                </span>
              ) : (
                <span className="chip tone-accent">
                  <CircleCheck className="sm" />
                  Closed
                </span>
              ))}
            <span className="tech">{ref}</span>
            {details && details.labels.length > 0 && (
              <ul className="labels" aria-label="Labels">
                {details.labels.map((label) => (
                  <li key={label} className="chip">
                    {label}
                  </li>
                ))}
              </ul>
            )}
            <button className="icon-btn sm refresh" type="button" title="Read it again from the Forge" aria-label="Refresh the issue" disabled={read.loading} onClick={refresh}>
              <RotateCw />
            </button>
          </div>
          <h2>{details ? details.title : `Issue #${issue.number}`}</h2>
          {details && (
            <div className="mr-meta">
              <span className="row">
                <User className="sm" />
                {details.at === undefined ? `Opened by ${details.author}` : `Opened by ${details.author} · ${dates.ago(details.at, now)}`}
              </span>
              <span className="row">
                <MessageSquare className="sm" />
                {countText(details.comments, 'comment')}
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
        {details && (
          <section className="mr-sec mr-desc" aria-label="Description">
            {details.body.trim() ? <Markdown text={details.body} flavour="forge" /> : <p className="muted">No description.</p>}
          </section>
        )}
      </div>
      <footer className="mr-foot">
        <button type="button" onClick={() => attempt(onError, () => api.invoke('links.open', { url: issue.url }))}>
          <ExternalLink className="sm" />
          Open on {forgeName}
        </button>
        {project && (
          <button type="button" onClick={unlink}>
            <Link2Off className="sm" />
            Unlink
          </button>
        )}
      </footer>
    </div>
  );
}
