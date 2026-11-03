// What makes an answer to an agent's question fit its fields. Main refuses
// an answer that doesn't; the renderer checks each question with the same
// rules before the user goes on, so a problem shows where it is.
import type { Answer, AnswerValue, QuestionField } from './api';

/** Whether a field's value counts as not given: absent, blank text or no choice. */
export function isBlank(value: AnswerValue | null | undefined): value is undefined | null {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
}

/** Why a field's value doesn't fit it, or undefined if it does; a blank one only doesn't when required. */
export function fieldProblem(field: QuestionField, value: AnswerValue | null | undefined): string | undefined {
  const name = field.title ?? field.key;
  if (isBlank(value)) return field.required ? `"${name}" needs an answer.` : undefined;
  const wrong = `"${name}" can't be ${JSON.stringify(value)}.`;
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') return wrong;
      if (field.minLength !== undefined && value.length < field.minLength) return `"${name}" needs at least ${field.minLength} characters.`;
      if (field.maxLength !== undefined && value.length > field.maxLength) return `"${name}" takes at most ${field.maxLength} characters.`;
      if (field.pattern !== undefined && !matches(field.pattern, value)) return `"${name}" isn't in the expected form.`;
      return undefined;
    case 'select':
      return typeof value === 'string' && field.options.some((o) => o.value === value) ? undefined : wrong;
    case 'multiselect':
      if (!Array.isArray(value) || value.some((v) => !field.options.some((o) => o.value === v))) return wrong;
      if (field.minItems !== undefined && value.length < field.minItems) return `"${name}" needs at least ${field.minItems} choices.`;
      if (field.maxItems !== undefined && value.length > field.maxItems) return `"${name}" takes at most ${field.maxItems} choices.`;
      return undefined;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (field.integer && !Number.isInteger(value))) return wrong;
      if (field.minimum !== undefined && value < field.minimum) return `"${name}" must be at least ${field.minimum}.`;
      if (field.maximum !== undefined && value > field.maximum) return `"${name}" must be at most ${field.maximum}.`;
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : wrong;
  }
}

/**
 * The answer, with blank fields left out, if it fits the question's fields:
 * every required one given, each value of its field's type, among its
 * options and within its bounds. Keys of no field are dropped. Throws the
 * first problem otherwise.
 */
export function checkAnswer(fields: QuestionField[], answer: Answer): Answer {
  const checked: Answer = {};
  for (const field of fields) {
    const value = answer[field.key];
    const problem = fieldProblem(field, value);
    if (problem) throw new Error(problem);
    if (!isBlank(value)) checked[field.key] = value;
  }
  return checked;
}

/** Whether `value` matches a JSON Schema `pattern`; one that can't be read lets anything through, as the agent checks it too. */
function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return true;
  }
}
