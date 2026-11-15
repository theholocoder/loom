// Desktop notifications of a Session gone Waiting: one per piece of news, of
// the kinds the user turned on in Settings, none while the window has the
// focus on that Session. Showing one is the Electron entry point's; deciding
// whether to, and what it says, is here.
import { notificationKindOf, type NotificationSettings, type Session, type WaitingReason } from '../shared/api';
import { splitDetails } from '../shared/errors';

/** A desktop notification to show, and what a click on it does. */
export interface DesktopNotification {
  title: string;
  body: string;
  onClick: () => void;
}

export interface NotificationsOptions {
  settings: () => NotificationSettings;
  session: (id: number) => Session | undefined;
  projectName: (id: number) => string;
  /** Whether the user sees the Session already: the window has the focus and shows it. */
  inView: (id: number) => boolean;
  show: (notification: DesktopNotification) => void;
  /** Asks the window to open the Session, as a click on its notification does. */
  open: (id: number) => void;
}

/** How long an error's message may run in a notification before it is cut. */
const MAX_ERROR_LENGTH = 120;

export class Notifications {
  constructor(private readonly options: NotificationsOptions) {}

  /** The Session went Waiting for `reason`, or has news while it stays so: notifies, if the user wants and isn't looking. */
  news(id: number, reason: WaitingReason): void {
    const kind = notificationKindOf(reason);
    if (!kind || !this.options.settings()[kind]) return;
    const session = this.options.session(id);
    if (!session || this.options.inView(id)) return;
    this.options.show({ title: session.title, body: `${this.options.projectName(session.projectId)}: ${newsOf(session, reason)}`, onClick: () => this.options.open(id) });
  }
}

/** What the news is, in words. */
function newsOf(session: Session, reason: WaitingReason): string {
  switch (reason) {
    case 'finished':
      return 'Finished';
    case 'error':
      return session.error ? `Stopped on an error: ${cut(splitDetails(session.error).message)}` : 'Stopped on an error';
    case 'question':
      return 'Asks you a question';
    case 'approval':
      return 'Needs your approval';
    case 'feedback':
      return 'New feedback on its Merge request';
    case 'unsaved-work':
      return `Its Merge request was ${session.mergeRequestState === 'closed' ? 'closed' : 'merged'}, with unsaved work in its worktree`;
    case 'stuck':
      return 'Stuck: its agent has gone quiet';
    case 'stopped':
      return 'Stopped';
    case 'interrupted':
      return 'Interrupted';
  }
}

function cut(text: string): string {
  const line = text.trim().split('\n')[0]!;
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
}
