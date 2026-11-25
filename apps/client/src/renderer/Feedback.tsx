// The feedback form (issue #126): a bug or an idea, in the user's own words,
// sent to Loom's makers through main (`feedback.send`), with an email address
// to answer at if they want one. Only Loom's version and the system's
// details go with it; the form says so, and asks for nothing private.
import { Bug, Lightbulb, MessageSquareText, Send } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FeedbackKind } from '../shared/api';
import { ErrorText } from './ErrorText';
import { useApi } from './api';
import { useToast } from './Toast';

const KINDS: { kind: FeedbackKind; label: string; icon: typeof Bug; placeholder: string }[] = [
  { kind: 'bug', label: 'Something went wrong', icon: Bug, placeholder: 'What happened, and what did you expect?' },
  { kind: 'idea', label: 'An idea', icon: Lightbulb, placeholder: 'What would make Loom better for you?' },
];

/** The form, over the window; `onClose` once it's sent or cancelled. */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const ids = useId();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => text.current?.focus(), []);
  const shown = KINDS.find((k) => k.kind === kind)!;
  const send = () => {
    setError(undefined);
    setBusy(true);
    api
      .invoke('feedback.send', { kind, message, email: email.trim() || undefined })
      .then(() => {
        toast.show({ message: 'Thanks: your feedback was sent' });
        onClose();
      })
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
        if (!busy) onClose();
      }}
    >
      <form
        className="card modal feedback-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-text`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && message.trim()) send();
        }}
      >
        <div className="card-head">
          <MessageSquareText className="sm" />
          <h3 id={`${ids}-title`}>Send feedback</h3>
        </div>
        <span className="seg" role="radiogroup" aria-label="Feedback about">
          {KINDS.map(({ kind: k, label, icon: Icon }) => (
            <button key={k} type="button" role="radio" className={k === kind ? 'on' : undefined} aria-checked={k === kind} disabled={busy} onClick={() => setKind(k)}>
              <Icon className="sm" />
              {label}
            </button>
          ))}
        </span>
        <textarea
          ref={text}
          aria-label="Your feedback"
          rows={6}
          placeholder={shown.placeholder}
          value={message}
          disabled={busy}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) event.currentTarget.form?.requestSubmit();
          }}
        />
        <input type="email" aria-label="Your email address, to get an answer (optional)" placeholder="Email, to get an answer (optional)" value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} />
        <p id={`${ids}-text`}>Only what you write here is sent, with Loom's version and your system's details. Leave out code and anything private.</p>
        {error && (
          <div className="err" role="alert">
            <ErrorText text={error} />
          </div>
        )}
        <div className="row modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !message.trim()}>
            <Send className="sm" />
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
