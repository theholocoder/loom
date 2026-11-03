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
 * A question card in the transcript. While asked, it points at the panel on
 * the composer, where it is answered (see useQuestionPanel); once settled,
 * it shows what was answered.
 */
export function QuestionCard({ item }: { item: Question }) {
  const asked = item.state === 'asked';
  return (
    <AskCard label="Question" icon={<MessageCircleQuestionMark className="sm" />} name="question" asked={asked} state={QUESTION_STATES[item.state]}>
      {item.message && <p className="ask-message">{item.message}</p>}
      {asked ? <p className="muted ask-hint">Answer below.</p> : item.answer && <AnswerSummary fields={item.fields} answer={item.answer} />}
    </AskCard>
  );
}

/**
 * One question of a card, asked on its own: a field, with the text field
 * holding an answer of one's own if it has one (OpenCode's `<key>_custom`).
 * A text field alone is answered in the composer, as its own free answer.
 */
interface Step {
  main: QuestionField;
  free?: TextField;
}

/** The card's questions, in order. */
function stepsOf(fields: QuestionField[]): Step[] {
  const steps: Step[] = [];
  for (const field of fields) {
    const owner =
      field.type === 'text' ? steps.find((s) => (s.main.type === 'select' || s.main.type === 'multiselect') && !s.free && `${s.main.key}_custom` === field.key) : undefined;
    if (owner && field.type === 'text') owner.free = field;
    else steps.push(field.type === 'text' ? { main: field, free: field } : { main: field });
  }
  return steps;
}

/** A question with one answer only: choosing it, or typing one's own, goes on to the next. */
function singleAnswer(step: Step): boolean {
  return step.main.type === 'select' || step.main.type === 'boolean' || step.main.type === 'text';
}

/** What a field holds while the user answers: numbers as typed. */
type Draft = Record<string, AnswerValue | undefined>;

const isBlank = (value: AnswerValue | undefined) => value === undefined || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

/** Whether the user may go on from the question: it is answered, or needn't be. */
function canLeave(step: Step, draft: Draft): boolean {
  const answered = !isBlank(draft[step.main.key]) || (!!step.free && !isBlank(draft[step.free.key]));
  if (step.main.type === 'number' && !isBlank(draft[step.main.key]) && !Number.isFinite(Number(draft[step.main.key]))) return false;
  return answered || !(step.main.required || step.free?.required);
}

interface Flow {
  itemId?: number;
  /** The question shown. */
  at: number;
  /** The furthest question the user has reached; the ones up to it can be gone back to. */
  reached: number;
  draft: Draft;
}

const freshFlow = (item: Question | undefined): Flow => ({ itemId: item?.id, at: 0, reached: 0, draft: Object.fromEntries((item?.fields ?? []).map((f) => [f.key, f.type === 'number' && f.default !== undefined ? String(f.default) : f.default])) });

/** What the composer does while a question is asked: give the current question's answer of one's own. */
export interface FreeAnswer {
  placeholder: string;
  /** Takes the text as the answer of one's own; resolves to whether to clear the composer. */
  send(text: string): Promise<boolean>;
}

/**
 * The asked question's panel, which sits on the composer: its questions one
 * by one, in order. Choosing the answer of a one-answer question, or typing
 * one's own in the composer, goes on to the next; others go on with Next.
 * Back and the question numbers return to earlier ones, keeping every
 * answer. Going on from the last sends them all; Dismiss declines.
 */
export function useQuestionPanel(item: Question | undefined, onAnswer: (answer: Answer | null) => Promise<void>): { panel?: ReactNode; freeAnswer?: FreeAnswer } {
  const [state, setState] = useState<Flow>(() => freshFlow(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const flow = state.itemId === item?.id ? state : freshFlow(item);
  if (!item) return {};
  const steps = stepsOf(item.fields);
  const step = steps[flow.at];

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
  const go = (at: number, draft = flow.draft) => setState({ itemId: item.id, at, reached: Math.max(flow.reached, at), draft });
  /** Moves on from the question with `draft`: to the next one, or sends the answer from the last. */
  const onward = (draft: Draft) => {
    if (flow.at + 1 < steps.length) return go(flow.at + 1, draft);
    setState({ ...flow, itemId: item.id, draft });
    void send(answerOf(item.fields, draft) ?? {});
  };
  const change = (values: Draft, goOn: boolean) => {
    const draft = { ...flow.draft, ...values };
    if (goOn) onward(draft);
    else setState({ ...flow, itemId: item.id, draft });
  };

  const last = flow.at + 1 >= steps.length;
  const panel = (
    <div className="ask-panel question" role="group" aria-label="Question">
      <div className="ask-panel-head">
        <MessageCircleQuestionMark className="sm" />
        <span className="grow ask-message">{item.message}</span>
        {steps.length > 0 && <span className="muted">{`Question ${flow.at + 1} of ${steps.length}`}</span>}
      </div>
      {steps.length > 1 && (
        <div className="ask-steps">
          {steps.map((s, i) => (
            <button
              key={s.main.key}
              type="button"
              className="ask-step-number"
              aria-label={`Question ${i + 1}: ${s.main.title ?? s.main.key}`}
              aria-current={i === flow.at ? 'step' : undefined}
              disabled={busy || i > flow.reached}
              onClick={() => go(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
      {step && <StepBody step={step} draft={flow.draft} disabled={busy} onChange={change} />}
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      <div className="opts">
        {flow.at > 0 && (
          <button type="button" disabled={busy} onClick={() => go(flow.at - 1)}>
            Back
          </button>
        )}
        <button className="primary" type="button" disabled={busy || (step && !canLeave(step, flow.draft))} onClick={() => onward(flow.draft)}>
          {last ? 'Answer' : 'Next'}
        </button>
        <span className="grow" />
        <button type="button" disabled={busy} onClick={() => void send(null)}>
          Dismiss
        </button>
      </div>
    </div>
  );
  const free = step?.free;
  const freeAnswer: FreeAnswer | undefined =
    free && !busy
      ? {
          placeholder: `${free.description ?? (step.main === free ? 'Type your answer' : 'Type your own answer')}…`,
          send: async (text) => {
            // One's own answer replaces a choice where there is only one answer.
            const values: Draft = singleAnswer(step) && step.main !== free ? { [free.key]: text, [step.main.key]: undefined } : { [free.key]: text };
            change(values, singleAnswer(step));
            return true;
          },
        }
      : undefined;
  return { panel, freeAnswer };
}

/** The question shown: its title and what answers it. */
function StepBody({ step, draft, disabled, onChange }: { step: Step; draft: Draft; disabled: boolean; onChange: (values: Draft, goOn: boolean) => void }) {
  const id = useId();
  const { main, free } = step;
  const value = draft[main.key];
  const own = free && free !== main ? draft[free.key] : undefined;
  const title = main.title ?? main.key;
  let body: ReactNode;
  switch (main.type) {
    case 'select':
      body = (
        <div className="opts">
          {main.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="ask-option"
              aria-pressed={value === option.value}
              disabled={disabled}
              // A choice replaces an answer of one's own.
              onClick={() => onChange({ [main.key]: option.value, ...(free ? { [free.key]: undefined } : {}) }, true)}
            >
              {option.label}
              {option.description && <span className="muted"> {option.description}</span>}
            </button>
          ))}
        </div>
      );
      break;
    case 'boolean':
      body = (
        <div className="opts">
          {([true, false] as const).map((yes) => (
            <button key={String(yes)} type="button" className="ask-option" aria-pressed={value === yes} disabled={disabled} onClick={() => onChange({ [main.key]: yes }, true)}>
              {yes ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      );
      break;
    case 'multiselect': {
      const chosen = Array.isArray(value) ? value : [];
      body = (
        <div className="opts">
          {main.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="ask-option"
              aria-pressed={chosen.includes(option.value)}
              disabled={disabled}
              onClick={() => onChange({ [main.key]: chosen.includes(option.value) ? chosen.filter((v) => v !== option.value) : [...chosen, option.value] }, false)}
            >
              {option.label}
              {option.description && <span className="muted"> {option.description}</span>}
            </button>
          ))}
        </div>
      );
      break;
    }
    case 'number':
      body = (
        <input
          id={id}
          aria-label={title}
          type="number"
          step={main.integer ? 1 : 'any'}
          min={main.minimum}
          max={main.maximum}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange({ [main.key]: e.target.value }, false)}
          // It sits in the composer's form: Enter mustn't send the prompt.
          onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
        />
      );
      break;
    case 'text':
      body = typeof value === 'string' && value.trim() ? <YourAnswer text={value} /> : <p className="muted ask-hint">Type your answer below.</p>;
      break;
  }
  return (
    <div className="ask-step">
      <h3 className="ask-step-title">{title}</h3>
      {main.description && <p className="ask-message">{main.description}</p>}
      {body}
      {typeof own === 'string' && own.trim() ? <YourAnswer text={own} /> : free && free !== main && <p className="muted ask-hint">Or type your own answer below.</p>}
    </div>
  );
}

function YourAnswer({ text }: { text: string }) {
  return (
    <p className="ask-hint">
      <span className="muted">Your answer: </span>
      <b>{text}</b>
    </p>
  );
}

/** The answer the draft makes, blank fields left out; undefined while a number isn't one. */
function answerOf(fields: QuestionField[], draft: Draft): Answer | undefined {
  const answer: Answer = {};
  for (const field of fields) {
    const value = draft[field.key];
    if (isBlank(value)) continue;
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return undefined;
      answer[field.key] = number;
    } else {
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
