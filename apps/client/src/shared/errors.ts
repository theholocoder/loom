// An error message that keeps the raw output behind it: a plain sentence the
// user reads, then what the command printed, which the window shows under
// "Details" on demand. Both travel in the one message string, as errors do
// over IPC, the details last, so a message can still be prefixed
// (`Couldn't create the worktree: ${failure}`).

/** Where a message's sentence ends and its details begin. Read as text, it still says what follows. */
const DETAILS = '\n\nDetails:\n';

/** `message`, with `details` to show on demand; just `message` if there are none. */
export function withDetails(message: string, details: string | undefined): string {
  const raw = details?.trim();
  return raw ? `${message}${DETAILS}${raw}` : message;
}

/** A message's sentence and the details it carries, if any. */
export function splitDetails(text: string): { message: string; details?: string } {
  const at = text.indexOf(DETAILS);
  return at < 0 ? { message: text } : { message: text.slice(0, at), details: text.slice(at + DETAILS.length) };
}
