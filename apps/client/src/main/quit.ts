// Closing the window quits Loom (there is no tray). When Sessions are
// Working, the user is asked first, since quitting stops their agents.
import type { Session } from '../shared/api';

/** What to ask before quitting, or null when no Session is Working. */
export function quitQuestion(sessions: readonly Pick<Session, 'status'>[]): string | null {
  const working = sessions.filter((s) => s.status === 'working').length;
  if (working === 0) return null;
  return working === 1 ? '1 Session is working: quit and stop it?' : `${working} Sessions are working: quit and stop them?`;
}

export interface QuitGuardOptions {
  /** What to ask before quitting now, or null to quit without asking. */
  question(): string | null;
  /** Asks the user; resolves true to quit. */
  confirm(message: string): Promise<boolean>;
  /** Quits, closing the window again; the guard lets that close through. */
  quit(): void;
}

/**
 * A handler for the window's `close` event that holds the close while it asks
 * the question, and quits once the user confirms. A close while the question
 * is open is held without asking again; once confirmed, closes go through.
 */
export function guardQuit(options: QuitGuardOptions): (event: { preventDefault(): void }) => void {
  let asking = false;
  let confirmed = false;
  return (event) => {
    if (confirmed) return;
    if (asking) {
      event.preventDefault();
      return;
    }
    const message = options.question();
    if (message === null) return;
    event.preventDefault();
    asking = true;
    void options.confirm(message).then(
      (quit) => {
        asking = false;
        if (!quit) return;
        confirmed = true;
        options.quit();
      },
      () => (asking = false),
    );
  };
}
