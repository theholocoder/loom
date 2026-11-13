// The review threads of the Session's Merge request, as Babysit last saw
// them, shown as notes on their lines in Changes and in the Merge request's
// diff (docs/prototypes/side-panels.html, C2-review-note): who said what,
// and Ask the agent (a comment on the line, in the composer), Reply and
// Resolve, both on the Forge.
import { Bot, Check, ExternalLink, MessageSquareReply } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { FORGE_NAMES, type ForgeKind, type ReviewThread } from '../shared/api';
import { Markdown } from './Markdown';
import { useFocusOnceShown } from './FileDiffView';
import { Avatar } from './MergeRequestLooks';
import { useNow } from './now';
import { useDates } from './dates';

/** The review threads to show on a diff, and what can be done with them. */
export interface ReviewNotes {
  threads: ReviewThread[];
  forge: ForgeKind | undefined;
  onOpen: (url: string) => void;
  /** Posts a reply on the Forge; absent when the Session can't act on it. */
  reply?: (thread: ReviewThread, body: string) => Promise<void>;
  /** Resolves it on the Forge; absent when the Session can't act on it. */
  resolve?: (thread: ReviewThread) => Promise<void>;
}

/** What Ask the agent puts in the composer for `thread`: what it says, and where to find it. */
export function askNote(thread: ReviewThread): string {
  const said = thread.comments.flatMap((comment) => [
    `> ${comment.author} wrote:`,
    ...comment.body
      .trim()
      .split('\n')
      .map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>')),
    '>',
  ]);
  return [askHead(thread), '', ...said.slice(0, -1)].join('\n');
}

/** The first line of what Ask the agent puts in the composer: it names the thread, whatever replies came since. */
export function askHead(thread: ReviewThread): string {
  return `Address this review comment on the Merge request (${thread.comments[0]?.url ?? ''}):`;
}

/**
 * One review thread as a note: its first comment, the replies under it, and
 * its actions. `where` says where it is when it isn't under its line. Ask the
 * agent shows while `onAsk` is given.
 */
export function ReviewNote({ thread, reviews, where, onAsk }: { thread: ReviewThread; reviews: ReviewNotes; where?: string; onAsk?: () => void }) {
  const now = useNow();
  const dates = useDates();
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState<'reply' | 'resolve'>();
  const [error, setError] = useState<string>();
  const [first, ...replies] = thread.comments;
  if (!first) return null;
  const forge = reviews.forge ? FORGE_NAMES[reviews.forge] : 'the Forge';
  const run = async (what: 'reply' | 'resolve', action: () => Promise<void>): Promise<boolean> => {
    setBusy(what);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const { reply, resolve } = reviews;
  return (
    <div className="review-note" role="note" aria-label={`Review comment by ${first.author} on ${thread.path}${thread.line ? `:${thread.line}` : ''}`}>
      <div className="note-h">
        <Avatar name={first.author} />
        <b>{first.author}</b>
        <span className="muted ellipsis grow">
          {where ?? 'on the Merge request'}
          {first.at !== undefined && ` · ${dates.ago(first.at, now)}`}
        </span>
        {thread.changesRequested && <span className="chip verdict changes">Changes requested</span>}
        <button type="button" className="icon-btn xs" title={`Open on ${forge}`} aria-label={`Open the comment by ${first.author} on ${forge}`} onClick={() => reviews.onOpen(first.url)}>
          <ExternalLink />
        </button>
      </div>
      <div className="note-b">
        <Markdown text={first.body} flavour="forge" />
      </div>
      {replies.map((comment) => (
        <div key={comment.url} className="note-reply">
          <div className="note-h">
            <Avatar name={comment.author} />
            <b>{comment.author}</b>
            {comment.at !== undefined && <span className="muted">{dates.ago(comment.at, now)}</span>}
          </div>
          <div className="note-b">
            <Markdown text={comment.body} flavour="forge" />
          </div>
        </div>
      ))}
      {replying && reply ? (
        <ReplyForm
          forge={forge}
          busy={busy === 'reply'}
          onCancel={() => setReplying(false)}
          onReply={async (body) => {
            if (await run('reply', () => reply(thread, body))) setReplying(false);
          }}
        />
      ) : (
        (onAsk || reply || (resolve && thread.canResolve)) && (
          <div className="note-a">
            {onAsk && (
              <button type="button" onClick={onAsk}>
                <Bot className="sm" />
                Ask the agent
              </button>
            )}
            {reply && (
              <button type="button" disabled={busy !== undefined} onClick={() => setReplying(true)}>
                <MessageSquareReply className="sm" />
                Reply
              </button>
            )}
            {resolve && thread.canResolve && (
              <button type="button" disabled={busy !== undefined} onClick={() => void run('resolve', () => resolve(thread))}>
                <Check className="sm" />
                {busy === 'resolve' ? 'Resolving…' : 'Resolve'}
              </button>
            )}
          </div>
        )
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A reply to a thread, posted on the Forge: Ctrl+Enter posts it, Esc drops it. */
function ReplyForm({ forge, busy, onReply, onCancel }: { forge: string; busy: boolean; onReply: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useFocusOnceShown(field);
  const post = () => body.trim() && !busy && onReply(body.trim());
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      post();
    }
  };
  return (
    <div className="note-reply-form" role="group" aria-label="Reply">
      <textarea ref={field} aria-label="Reply" rows={3} placeholder={`Reply on ${forge}…`} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} onKeyDown={onKeyDown} />
      <div className="note-a">
        <span className="grow" />
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!body.trim() || busy} onClick={post}>
          {busy ? 'Replying…' : 'Reply'}
        </button>
      </div>
    </div>
  );
}
