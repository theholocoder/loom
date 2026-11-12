// What the agent asks the user: its questions and dialogs from the user's
// plugins and MCP servers (question cards, answered in a panel on the
// composer), and whether to trust the Project's local files (a card in the
// transcript). Kept, read-only, in the transcript once answered.
import { MessageCircleQuestionMark, ShieldQuestionMark, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { fieldProblem, isBlank } from '../shared/answers';
import type { Answer, AnswerValue, QuestionField, QuestionState, TranscriptItem, TrustState } from '../shared/api';

type Question = Extract<TranscriptItem, { kind: 'question' }>;
type Trust = Extract<TranscriptItem, { kind: 'trust' }>;

const QUESTION_STATES: Record<QuestionState, string | undefined> = { asked: undefined, answered: 'Answered', dismissed: 'Dismissed', expired: 'No longer asked' };
const TRUST_STATES: Record<TrustState, string | undefined> = { asked: undefined, trusted: 'Trusted', untrusted: 'Not trusted', expired: 'No longer asked' };

/** The frame both cards share: highlighted while the agent waits on the user. */
export function AskCard({ label, icon, name, asked, hint = 'The agent is asking you', state, children }: { label: string; icon: ReactNode; name: string; asked: boolean; hint?: string; state?: string; children: ReactNode }) {
  return (
    <div className="tools">
      {/* While asked, the focus can be kept on it (see SessionView): the composer is disabled. */}
      <div className={`tool ask${asked ? ' question' : ''}`} role="group" aria-label={label} tabIndex={asked ? -1 : undefined} data-asked={asked || undefined}>
        <div className="tool-head">
          {icon}
          <span className="name">{name}</span>
          <span className="grow muted">{asked ? hint : ''}</span>
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

/** The step's fields: its own, and its answer of one's own if that is apart. */
const fieldsOf = ({ main, free }: Step): QuestionField[] => (free && free !== main ? [main, free] : [main]);

/** A question with one answer only: choosing it, or typing one's own, goes on to the next. */
function singleAnswer(step: Step): boolean {
  return step.main.type === 'select' || step.main.type === 'boolean' || step.main.type === 'text';
}

/** What a field holds while the user answers: numbers as typed. */
type Draft = Record<string, AnswerValue | undefined>;

/** A field's value in the answer: a number as a number, NaN if what was typed isn't one. */
function valueOf(field: QuestionField, value: AnswerValue | undefined): AnswerValue | undefined {
  return field.type === 'number' && typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
}

/** Why the question's answer doesn't fit it, if it doesn't; a blank one is the Next button's business. */
function stepProblem(step: Step, draft: Draft): string | undefined {
  for (const field of fieldsOf(step)) {
    const value = valueOf(field, draft[field.key]);
    if (isBlank(value)) continue;
    if (typeof value === 'number' && Number.isNaN(value)) return `"${field.title ?? field.key}" isn't a number.`;
    // A choice or one's own answer will do for a required question: blanks are checked below.
    const problem = fieldProblem({ ...field, required: false }, value);
    if (problem) return problem;
  }
  return undefined;
}

/** Whether the user may go on from the question: its answer fits, and it is given if needed. */
function canLeave(step: Step, draft: Draft): boolean {
  const answered = fieldsOf(step).some((f) => !isBlank(draft[f.key]));
  return !stepProblem(step, draft) && (answered || !fieldsOf(step).some((f) => f.required));
}

/** The answer the draft makes, blank fields left out. */
function answerOf(fields: QuestionField[], draft: Draft): Answer {
  const answer: Answer = {};
  for (const field of fields) {
    const value = valueOf(field, draft[field.key]);
    if (!isBlank(value)) answer[field.key] = value;
  }
  return answer;
}

/** Where the user is in a question card. */
interface Flow {
  itemId?: number;
  /** The question shown. */
  at: number;
  draft: Draft;
}

const freshFlow = (item: Question | undefined): Flow => ({
  itemId: item?.id,
  at: 0,
  draft: Object.fromEntries((item?.fields ?? []).map((f) => [f.key, f.type === 'number' && f.default !== undefined ? String(f.default) : f.default])),
});

/** What the composer does while a question is asked: give the current question's answer of one's own. */
interface FreeAnswer {
  placeholder: string;
  /** Takes the text as the answer of one's own; resolves to whether to clear the composer, which keeps an answer that doesn't fit. */
  send(text: string): Promise<boolean>;
}

/** Something the user set going that may fail: whether it is running, and why it failed. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** The reason an action failed, for the user. */
export function ErrorAlert({ error }: { error?: string }) {
  return error ? (
    <div className="err" role="alert">
      {error}
    </div>
  ) : null;
}

/**
 * The asked question's panel, which sits on the composer: its questions one
 * by one, in order. Choosing the answer of a one-answer question, or typing
 * one's own in the composer, goes on to the next; others go on with Next,
 * once their answer fits. Back returns to earlier ones, keeping every
 * answer. Going on from the last sends them all; Dismiss declines.
 * `stepKey` changes with the question shown, so the composer can let go of
 * text typed for another one.
 */
export function useQuestionPanel(
  item: Question | undefined,
  onAnswer: (itemId: number, answer: Answer | null) => Promise<void>,
  /** What is typed in the composer: given an answer of one's own, Next and Answer take it, as Enter does. */
  typed = '',
): { panel?: ReactNode; freeAnswer?: FreeAnswer; stepKey?: string } {
  const [flowState, setFlowState] = useState<Flow>(() => freshFlow(item));
  const { busy, error, setError, run } = useAction();
  // An error is about the card it came from.
  useEffect(() => setError(undefined), [item?.id]);
  const flow = flowState.itemId === item?.id ? flowState : freshFlow(item);
  if (!item) return {};
  const steps = stepsOf(item.fields);
  const step = steps[flow.at];
  const last = flow.at + 1 >= steps.length;

  const respond = (answer: Answer | null) => run(() => onAnswer(item.id, answer));
  /** Shows the question at `at`, with `draft`. */
  const showStep = (at: number, draft = flow.draft) => {
    setError(undefined);
    setFlowState({ itemId: item.id, at, draft });
  };
  /** Leaves the question with `draft`: for the next one, or sending every answer from the last. */
  const leaveStep = (draft: Draft) => {
    if (!last) return showStep(flow.at + 1, draft);
    setFlowState({ ...flow, itemId: item.id, draft });
    void respond(answerOf(item.fields, draft));
  };
  /** Changes the answers in `values`, and leaves the question if `moveOn`. */
  const edit = (values: Draft, moveOn: boolean) => {
    const draft = { ...flow.draft, ...values };
    if (moveOn) leaveStep(draft);
    else showStep(flow.at, draft);
  };

  const problem = step && stepProblem(step, flow.draft);
  // What is typed goes as the question's answer of one's own: Next submits the composer's form, which the panel sits in.
  const takesTyped = !!step?.free && !busy && typed.trim() !== '';
  const panel = (
    <div className="ask-panel" role="group" aria-label="Question" tabIndex={-1} data-asked>
      <div className="ask-panel-head">
        <MessageCircleQuestionMark className="sm" />
        <span className="grow ask-message">{item.message}</span>
        {steps.length > 0 && <span className="muted">{`Question ${flow.at + 1} of ${steps.length}`}</span>}
      </div>
      {step && <StepBody step={step} draft={flow.draft} disabled={busy} onEdit={edit} />}
      {problem && (
        <p className="ask-problem" role="status">
          {problem}
        </p>
      )}
      <ErrorAlert error={error} />
      <div className="opts">
        <button type="button" disabled={busy} onClick={() => void respond(null)}>
          Dismiss
        </button>
        <span className="grow" />
        {flow.at > 0 && (
          <button type="button" disabled={busy} onClick={() => showStep(flow.at - 1)}>
            Back
          </button>
        )}
        <button
          className="primary"
          type={takesTyped ? 'submit' : 'button'}
          disabled={busy || (!takesTyped && step && !canLeave(step, flow.draft))}
          onClick={takesTyped ? undefined : () => leaveStep(flow.draft)}
        >
          {last ? 'Answer' : 'Next'}
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
            const wrong = fieldProblem({ ...free, required: false }, text);
            if (wrong) {
              setError(wrong);
              return false;
            }
            // One's own answer replaces a choice where there is only one answer, and joins the choices otherwise.
            edit(singleAnswer(step) && step.main !== free ? { [free.key]: text, [step.main.key]: undefined } : { [free.key]: text }, true);
            return true;
          },
        }
      : undefined;
  return { panel, freeAnswer, stepKey: `${item.id}:${flow.at}` };
}

/** The question shown: its title and what answers it. */
function StepBody({ step, draft, disabled, onEdit }: { step: Step; draft: Draft; disabled: boolean; onEdit: (values: Draft, moveOn: boolean) => void }) {
  const id = useId();
  // Whether the last choice was made from the keyboard, which only selects; a pointer's goes on.
  const byKeyboard = useRef(false);
  const input = { onKeyDown: () => (byKeyboard.current = true), onPointerDown: () => (byKeyboard.current = false) };
  const { main, free } = step;
  const value = draft[main.key];
  const own = free && free !== main ? draft[free.key] : undefined;
  const title = main.title ?? main.key;
  let body: ReactNode;
  switch (main.type) {
    case 'select':
    case 'boolean': {
      const options = main.type === 'select' ? main.options : [{ value: true, label: 'Yes' }, { value: false, label: 'No' }];
      body = (
        <div className="ask-choices" role="radiogroup" aria-label={title} {...input}>
          {options.map((option) => (
            <Choice
              key={String(option.value)}
              type="radio"
              group={id}
              label={option.label}
              description={'description' in option ? option.description : undefined}
              checked={value === option.value}
              disabled={disabled}
              // A choice replaces an answer of one's own; picked with the pointer, it goes on.
              onPick={() => onEdit({ [main.key]: option.value, ...(free ? { [free.key]: undefined } : {}) }, !byKeyboard.current)}
            />
          ))}
        </div>
      );
      break;
    }
    case 'multiselect': {
      const chosen = Array.isArray(value) ? value : [];
      body = (
        <div className="ask-choices" role="group" aria-label={title}>
          {main.options.map((option) => (
            <Choice
              key={option.value}
              type="checkbox"
              group={id}
              label={option.label}
              description={option.description}
              checked={chosen.includes(option.value)}
              disabled={disabled}
              onPick={() => onEdit({ [main.key]: chosen.includes(option.value) ? chosen.filter((v) => v !== option.value) : [...chosen, option.value] }, false)}
            />
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
          onChange={(e) => onEdit({ [main.key]: e.target.value }, false)}
          // It sits in the composer's form: Enter mustn't send the prompt.
          onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
        />
      );
      break;
    case 'text':
      body =
        typeof value === 'string' && value.trim() ? (
          <YourAnswer text={value} disabled={disabled} onRemove={() => onEdit({ [main.key]: undefined }, false)} />
        ) : (
          <p className="muted ask-hint">Type your answer below.</p>
        );
      break;
  }
  return (
    <div className="ask-step">
      <h3 className="ask-step-title">{title}</h3>
      {main.description && <p className="ask-message">{main.description}</p>}
      {body}
      {free && free !== main && typeof own === 'string' && own.trim() ? (
        <YourAnswer text={own} disabled={disabled} onRemove={() => onEdit({ [free.key]: undefined }, false)} />
      ) : (
        free && free !== main && <p className="muted ask-hint">Or type your own answer below.</p>
      )}
    </div>
  );
}

/**
 * One choice of a question, as a radio button or a checkbox, with its
 * description under its label; the whole row picks it. `onPick` runs when
 * it is picked, a radio already checked included, so picking it with the
 * pointer goes on again.
 */
function Choice({ type, group, label, description, checked, disabled, onPick }: { type: 'radio' | 'checkbox'; group: string; label: string; description?: string; checked: boolean; disabled: boolean; onPick: () => void }) {
  const describedBy = useId();
  return (
    <label className={`ask-choice${checked ? ' checked' : ''}`}>
      <input
        type={type}
        name={group}
        aria-label={label}
        aria-describedby={description ? describedBy : undefined}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
        // Picking the radio already checked changes nothing, so it has no change to go by.
        onClick={() => checked && type === 'radio' && onPick()}
      />
      <span className="ask-choice-text">
        <span className="ask-choice-label">{label}</span>
        {description && (
          <span className="muted" id={describedBy}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

/** An answer the user typed in the composer, which they can take back. */
function YourAnswer({ text, disabled, onRemove }: { text: string; disabled: boolean; onRemove: () => void }) {
  return (
    <p className="ask-hint ask-own">
      <span className="muted">Your answer: </span>
      <b>{text}</b>
      <button type="button" className="icon-btn" aria-label="Remove your answer" title="Remove your answer" disabled={disabled} onClick={onRemove}>
        <X className="sm" />
      </button>
    </p>
  );
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

/** A value as the user reads it: options by their labels, yes or no. */
function display(field: QuestionField, value: AnswerValue): string {
  const label = (v: string) => (field.type === 'select' || field.type === 'multiselect' ? (field.options.find((o) => o.value === v)?.label ?? v) : v);
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return typeof value === 'string' ? label(value) : String(value);
}

/** The agent asking whether to trust the Project's local files: answered once, for the whole Project. */
export function TrustCard({ item, project, onTrust }: { item: Trust; project?: string; onTrust: (trusted: boolean) => Promise<void> }) {
  const asked = item.state === 'asked';
  const { busy, error, run } = useAction();
  const answer = (trusted: boolean) => run(() => onTrust(trusted));
  return (
    <AskCard label="Trust request" icon={<ShieldQuestionMark className="sm" />} name="trust" asked={asked} state={TRUST_STATES[item.state]}>
      {item.message && <p className="ask-message">{item.message}</p>}
      {asked && (
        <>
          <p className="muted ask-hint">{`Loom remembers your answer for ${project ?? 'this Project'}: its other Sessions won't ask again.`}</p>
          <ErrorAlert error={error} />
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
