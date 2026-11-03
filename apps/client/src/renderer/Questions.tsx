// What the agent asks the user, in a Session's transcript: its questions,
// dialogs from the user's plugins and MCP servers (both as question cards),
// and whether to trust the Project's local files. Highlighted while asked;
// kept, read-only, once answered.
import { MessageCircleQuestionMark, ShieldQuestionMark } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { Answer, AnswerValue, QuestionField, QuestionState, TranscriptItem, TrustState } from '../shared/api';

type Question = Extract<TranscriptItem, { kind: 'question' }>;
type Trust = Extract<TranscriptItem, { kind: 'trust' }>;

const QUESTION_STATES: Record<QuestionState, string | undefined> = { asked: undefined, answered: 'Answered', dismissed: 'Dismissed', expired: 'No longer asked' };
const TRUST_STATES: Record<TrustState, string | undefined> = { asked: undefined, trusted: 'Trusted', untrusted: 'Not trusted', expired: 'No longer asked' };

/** The frame both cards share: highlighted while the agent waits on the user. */
function AskCard({ label, icon, name, asked, state, children }: { label: string; icon: ReactNode; name: string; asked: boolean; state?: string; children: ReactNode }) {
  return (
    <div className="tools">
      <div className={`tool ask${asked ? ' question' : ''}`} role="group" aria-label={label}>
        <div className="tool-head">
          {icon}
          <span className="name">{name}</span>
          <span className="grow muted">{asked ? 'The agent is asking you' : ''}</span>
          {state && <span className="chip">{state}</span>}
        </div>
        <div className="tool-body">{children}</div>
      </div>
    </div>
  );
}

type TextField = Extract<QuestionField, { type: 'text' }>;

/**
 * The question's free answer, which the composer can give: its one text
 * field, when nothing else is needed (OpenCode's "type your own answer").
 * Undefined when the question needs more than a line of text.
 */
export function freeAnswerField(item: Question): TextField | undefined {
  const texts = item.fields.filter((f): f is TextField => f.type === 'text');
  if (texts.length !== 1) return undefined;
  const [text] = texts;
  return item.fields.every((f) => f === text || !f.required) ? text : undefined;
}

/**
 * A question card. When it is one choice, with nothing else it needs, an
 * option answers in one click; otherwise the form is filled in and sent
 * with Answer. Dismiss declines it. With `composerAnswers`, its free answer
 * (see freeAnswerField) is typed in the composer instead of on the card.
 */
export function QuestionCard({ item, composerAnswers = false, onAnswer }: { item: Question; composerAnswers?: boolean; onAnswer: (answer: Answer | null) => Promise<void> }) {
  const asked = item.state === 'asked';
  const free = composerAnswers ? freeAnswerField(item) : undefined;
  return (
    <AskCard label="Question" icon={<MessageCircleQuestionMark className="sm" />} name="question" asked={asked} state={QUESTION_STATES[item.state]}>
      {item.message && <p className="ask-message">{item.message}</p>}
      {asked ? (
        <>
          <QuestionForm fields={item.fields.filter((f) => f !== free)} onAnswer={onAnswer} />
          {free && <p className="muted ask-hint">Or type your own answer below.</p>}
        </>
      ) : (
        item.answer && <AnswerSummary fields={item.fields} answer={item.answer} />
      )}
    </AskCard>
  );
}

/** What a field holds while the user fills the form in: numbers as typed. */
type Draft = Record<string, AnswerValue | undefined>;

function QuestionForm({ fields, onAnswer }: { fields: QuestionField[]; onAnswer: (answer: Answer | null) => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(fields.map((f) => [f.key, initial(f)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (key: string, value: AnswerValue | undefined) => setDraft((d) => ({ ...d, [key]: value }));
  const selects = fields.filter((f) => f.type === 'select');
  // One choice and nothing else needed: an option is the whole answer.
  const quick = selects.length === 1 && fields.every((f) => f.type === 'select' || !f.required) ? selects[0] : undefined;
  const answer = answerOf(fields, draft);
  const complete = answer !== undefined && fields.every((f) => !f.required || answer[f.key] !== undefined);

  const send = async (response: Answer | null) => {
    setBusy(true);
    setError(undefined);
    try {
      await onAnswer(response);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="ask-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !busy) void send(answer);
      }}
    >
      {fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={draft[field.key]}
          disabled={busy}
          onChange={(value) => set(field.key, value)}
          onChoose={field === quick ? (value) => void send({ ...answerOf(fields, { ...draft, [field.key]: undefined }), [field.key]: value }) : undefined}
        />
      ))}
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      <div className="opts">
        {!(quick && fields.length === 1) && (
          <button className="primary" type="submit" disabled={!complete || busy}>
            Answer
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void send(null)}>
          Dismiss
        </button>
      </div>
    </form>
  );
}

/** One field of a question. A select given `onChoose` answers with the option clicked; otherwise it only selects it. */
function Field({ field, value, disabled, onChange, onChoose }: { field: QuestionField; value: AnswerValue | undefined; disabled: boolean; onChange: (value: AnswerValue | undefined) => void; onChoose?: (value: string) => void }) {
  const id = useId();
  const title = field.title ?? field.key;
  const hint = field.description && <div className="muted ask-hint">{field.description}</div>;
  switch (field.type) {
    case 'boolean':
      return (
        <div className="ask-field">
          <label className="ask-check">
            <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            {title}
          </label>
          {hint}
        </div>
      );
    case 'select':
      return (
        <fieldset className="ask-field">
          <legend>{title}</legend>
          {hint}
          <div className="opts">
            {field.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="ask-option"
                aria-pressed={onChoose ? undefined : value === option.value}
                disabled={disabled}
                onClick={() => (onChoose ? onChoose(option.value) : onChange(value === option.value && !field.required ? undefined : option.value))}
              >
                {option.label}
                {option.description && <span className="muted"> {option.description}</span>}
              </button>
            ))}
          </div>
        </fieldset>
      );
    case 'multiselect': {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <fieldset className="ask-field">
          <legend>{title}</legend>
          {hint}
          {field.options.map((option) => (
            <label key={option.value} className="ask-check">
              <input
                type="checkbox"
                checked={chosen.includes(option.value)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...chosen, option.value] : chosen.filter((v) => v !== option.value))}
              />
              {option.label}
              {option.description && <span className="muted"> {option.description}</span>}
            </label>
          ))}
        </fieldset>
      );
    }
    case 'number':
      return (
        <div className="ask-field">
          <label htmlFor={id}>{title}</label>
          {hint}
          <input
            id={id}
            type="number"
            step={field.integer ? 1 : 'any'}
            min={field.minimum}
            max={field.maximum}
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case 'text':
      return (
        <div className="ask-field">
          <label htmlFor={id}>{title}</label>
          {hint}
          <textarea id={id} rows={1} maxLength={field.maxLength} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
  }
}

/** A field's value before the user touches it: its default; a yes/no is no unless it says otherwise. */
function initial(field: QuestionField): AnswerValue | undefined {
  if (field.type === 'number') return field.default === undefined ? '' : String(field.default);
  if (field.type === 'boolean') return field.default ?? false;
  return field.default;
}

/** The answer the draft makes, blank fields left out; undefined while a number isn't one. */
function answerOf(fields: QuestionField[], draft: Draft): Answer | undefined {
  const answer: Answer = {};
  for (const field of fields) {
    const value = draft[field.key];
    if (field.type === 'number') {
      if (typeof value !== 'string' || value.trim() === '') continue;
      const number = Number(value);
      if (!Number.isFinite(number)) return undefined;
      answer[field.key] = number;
    } else if (typeof value === 'string' ? value.trim() !== '' : Array.isArray(value) ? value.length > 0 : value !== undefined) {
      answer[field.key] = value!;
    }
  }
  return answer;
}

/** What the user answered, field by field, with options by their labels. */
function AnswerSummary({ fields, answer }: { fields: QuestionField[]; answer: Answer }) {
  const shown = fields.filter((f) => answer[f.key] !== undefined);
  return (
    <dl className="ask-answer">
      {shown.map((field) => (
        <div key={field.key}>
          <dt>{field.title ?? field.key}</dt>
          <dd>{display(field, answer[field.key]!)}</dd>
        </div>
      ))}
    </dl>
  );
}

function display(field: QuestionField, value: AnswerValue): string {
  const label = (v: string) => (field.type === 'select' || field.type === 'multiselect' ? (field.options.find((o) => o.value === v)?.label ?? v) : v);
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return typeof value === 'string' ? label(value) : String(value);
}

/** The agent asking whether to trust the Project's local files: answered once, for the whole Project. */
export function TrustCard({ item, project, onTrust }: { item: Trust; project?: string; onTrust: (trusted: boolean) => Promise<void> }) {
  const asked = item.state === 'asked';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const answer = async (trusted: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await onTrust(trusted);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AskCard label="Trust request" icon={<ShieldQuestionMark className="sm" />} name="trust" asked={asked} state={TRUST_STATES[item.state]}>
      {item.message && <p className="ask-message">{item.message}</p>}
      {asked && (
        <>
          <p className="muted ask-hint">{`Loom remembers your answer for ${project ?? 'this Project'}: its other Sessions won't ask again.`}</p>
          {error && (
            <div className="err" role="alert">
              {error}
            </div>
          )}
          <div className="opts">
            <button className="primary" type="button" disabled={busy} onClick={() => void answer(true)}>
              Trust
            </button>
            <button type="button" disabled={busy} onClick={() => void answer(false)}>
              Don't trust
            </button>
          </div>
        </>
      )}
    </AskCard>
  );
}
