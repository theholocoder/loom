// An error message as the window shows it: its plain sentence, then, if it
// carries any, the raw output behind it under "Details", folded until asked
// for (see shared/errors).
import type { ReactNode } from 'react';
import { splitDetails } from '../shared/errors';

/** Shows `text`'s sentence, then `children` (a Retry, say), then its Details, folded. */
export function ErrorText({ text, children }: { text: string; children?: ReactNode }) {
  const { message, details } = splitDetails(text);
  return (
    <>
      {message}
      {children}
      {details && (
        <details className="error-details">
          <summary>Details</summary>
          <pre className="tech">{details}</pre>
        </details>
      )}
    </>
  );
}

