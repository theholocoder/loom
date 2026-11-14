// The Panel registry (ADR 0009): every kind of Panel, once, with how its tab
// looks, where it is offered, whether it can take Review mode, and its
// content. What a Panel shares with the conversation, and asks of others, goes
// through the Session's Panel context (panel-context.tsx), so that adding a
// kind needs nothing of the Session view.
import { CircleDot, FileDiff, GitPullRequest, Sparkles, SquareTerminal, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Project, Session, TerminalInfo } from '../shared/api';
import { PANEL_SPECS, terminalOf, type PanelId, type PanelKind, type PanelKindSpec } from '../shared/panels';
import { ChangesView } from './Changes';
import { HighlightsPanel } from './HighlightsPanel';
import { IssuePanel } from './IssuePanel';
import { countText } from './MergeRequestLooks';
import { mergeRequestCanReview, MergeRequestPanel } from './MergeRequestPanel';
import { useSessionPanels, type PanelState } from './panel-context';
import type { PanelsControl } from './Panels';
import { TerminalView } from './TerminalView';

/** What a tab shows beside its label: a count, with what it counts for a screen reader and the tooltip. */
export interface PanelBadge {
  text: string;
  description: string;
}

/** What every Panel's content is drawn with: the Panel and its Session, and what changes the Session's Panels. */
export interface PanelProps {
  panel: PanelId;
  session: Session;
  project: Project | undefined;
  /** The Session's Terminals. */
  terminals: TerminalInfo[] | undefined;
  control: PanelsControl;
  /** Shows why an action failed. */
  onError: (message: string | undefined) => void;
}

/** A Panel kind as the renderer shows it: main's spec, with its label, icon and badge, and its content. */
export interface PanelKindView extends PanelKindSpec {
  label: string;
  icon: LucideIcon;
  badge?: (session: Session) => PanelBadge | undefined;
  /** Whether it can take the Session's main area, in Review mode: a large work surface. */
  reviewable?: boolean;
  /** Whether a reviewable Panel can take Review mode as it keeps itself now (see `usePanelState`); always, without. */
  canReview?: (state: PanelState) => boolean;
  /** Whether the + menu offers it for `session`; always, without. */
  offered?: (session: Session) => boolean;
  /** The Panel's content, in whichever area it sits. */
  render(props: PanelProps): ReactNode;
}

/** Whether `session` can have Terminals: it can still work, so it is not archived, and its worktree is there. */
export function canRunTerminals(session: Session): boolean {
  return session.status !== 'archived' && !session.worktreeMissing;
}

/** The Panel registry: every kind of Panel, once. */
export const PANELS: Record<PanelKind, PanelKindView> = {
  changes: {
    ...PANEL_SPECS.changes,
    label: 'Changes',
    icon: FileDiff,
    reviewable: true,
    badge: ({ diffStat }) => (diffStat?.files ? { text: String(diffStat.files), description: `${diffStat.files} ${diffStat.files === 1 ? 'file' : 'files'} changed` } : undefined),
    render: (props) => <Changes {...props} />,
  },
  'merge-request': {
    ...PANEL_SPECS['merge-request'],
    label: 'Merge request',
    icon: GitPullRequest,
    reviewable: true,
    canReview: mergeRequestCanReview,
    // It means nothing on a Session without one (ADR 0009); one open when it goes says so.
    offered: (session) => !!session.mergeRequest,
    badge: ({ babysit }) => {
      const reviews = babysit?.reviews?.reviews;
      if (!reviews) return undefined;
      return { text: String(reviews), description: `${countText(reviews, 'review')}${babysit.reviews!.changesRequested ? ', changes requested' : ''}` };
    },
    render: (props) => <MergeRequest {...props} />,
  },
  issue: {
    ...PANEL_SPECS.issue,
    label: 'Issue',
    icon: CircleDot,
    // Like the Merge request's, it means nothing on a Session without one.
    offered: (session) => !!session.issue,
    render: ({ session, project, control, onError }) => <IssuePanel session={session} project={project} onUnlinked={() => control.close('issue')} onError={onError} />,
  },
  highlights: {
    ...PANEL_SPECS.highlights,
    label: 'Highlights',
    icon: Sparkles,
    // Always: with Session highlights off, it says so and how to turn it on.
    badge: ({ highlights }) => (highlights?.unseen ? { text: String(highlights.unseen), description: `${highlights.unseen} new ${highlights.unseen === 1 ? 'highlight' : 'highlights'}` } : undefined),
    render: (props) => <Highlights {...props} />,
  },
  terminal: {
    ...PANEL_SPECS.terminal,
    label: 'Terminal',
    icon: SquareTerminal,
    offered: (session) => canRunTerminals(session),
    render: ({ panel, terminals, control }) => {
      const terminal = terminals?.find((t) => t.id === terminalOf(panel));
      return terminal && <TerminalView key={terminal.id} terminal={terminal} focusPending={control.focus === panel} onFocused={control.onFocused} />;
    },
  },
};

function Changes({ session }: PanelProps) {
  const { diffComments, reviewNotes } = useSessionPanels();
  return <ChangesView session={session} comments={diffComments} reviews={reviewNotes} />;
}

function MergeRequest({ session, project, control, onError }: PanelProps) {
  const { diffComments, reviewNotes } = useSessionPanels();
  return (
    <MergeRequestPanel
      session={session}
      project={project}
      // As on Changes: comments go with the next message, which an archived Session's diff doesn't take.
      comments={session.status === 'archived' || session.worktreeMissing ? undefined : diffComments}
      reviewNotes={reviewNotes}
      // Off its diff, it can't stay in Review mode.
      onLeftDiff={() => {
        if (control.review === 'merge-request') control.leaveReview();
      }}
      onError={onError}
    />
  );
}

function Highlights({ session, onError }: PanelProps) {
  const { showTurn, askAboutHighlight, show } = useSessionPanels();
  return (
    <HighlightsPanel
      session={session}
      onShowTurn={showTurn}
      onShowFile={(path) => show('changes', path)}
      onAsk={askAboutHighlight}
      onError={onError}
    />
  );
}
