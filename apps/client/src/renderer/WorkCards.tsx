// How the agent worked, in a Session's transcript: its thinking and its tool
// calls, each folded away behind a header the user can open, and its plan.
import { Brain, ChevronRight, Circle, CircleCheck, CircleCheckBig, CircleDot, CircleSlash, ListTodo, LoaderCircle, OctagonX } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toolLine, type PlanStatus, type ToolDiff, type TranscriptItem } from '../shared/api';
import { useTheme } from './appearance';
import { TextDiffView } from './FileDiffView';

type Thinking = Extract<TranscriptItem, { kind: 'thinking' }>;
type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
type Plan = Extract<TranscriptItem, { kind: 'plan' }>;

/** A header button that shows or hides its body. */
function Fold({ className, head, open, onToggle, children }: { className: string; head: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  const body = useId();
  return (
    <div className={`tool fold ${className}`}>
      <button type="button" className="tool-head" aria-expanded={open} aria-controls={body} onClick={onToggle}>
        <ChevronRight className={`sm chev${open ? ' open' : ''}`} />
        {head}
      </button>
      {open && (
        <div className="tool-body" id={body}>
          {children}
        </div>
      )}
    </div>
  );
}

/** The agent's thinking, under its name line: open while it streams, folded once done, unless the user chose. */
export function ThinkingBlock({ item }: { item: Thinking }) {
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? item.streaming;
  return (
    <Fold
        className="thinking"
        open={open}
        onToggle={() => setChosen(!open)}
        head={
          <>
            {item.streaming ? (
              <span className="spin">
                <LoaderCircle className="sm" />
              </span>
            ) : (
              <Brain className="sm" />
            )}
            <span className="grow">{item.streaming ? 'Thinking…' : 'Thought'}</span>
          </>
        }
      >
        <div className="thinking-text">{item.text}</div>
      </Fold>
  );
}

const STATUS = {
  running: { label: 'Running', icon: <LoaderCircle className="sm" /> },
  completed: { label: 'Completed', icon: <CircleCheckBig className="sm" /> },
  failed: { label: 'Failed', icon: <OctagonX className="sm" /> },
} as const;

/**
 * One tool call, whoever's tool it is, on one line until the user opens it:
 * its tool (its name, or else its kind), what it worked on, its status.
 * Inside, a shell call's command, an edit's diffs, or its input; then its output.
 */
export function ToolCard({ item }: { item: Tool }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[item.status];
  const { tool, what } = toolLine(item);
  return (
    <div className="tools">
      <Fold
        className={`tool-call ${item.status}`}
        open={open}
        onToggle={() => setOpen(!open)}
        head={
          <>
            <span className="tool-name">{tool}</span>
            <span className="grow tool-title">{what}</span>
            {item.truncated && <span className="chip">truncated</span>}
            <span className={`tool-status ${item.status}${item.status === 'running' ? ' spin' : ''}`} role="img" aria-label={status.label} title={status.label}>
              {status.icon}
            </span>
          </>
        }
      >
        {item.command !== undefined ? (
          <pre className="tool-output tool-command">{`$ ${item.command}`}</pre>
        ) : item.diffs?.length ? (
          <ToolDiffs diffs={item.diffs} />
        ) : (
          item.input !== undefined && (
            <>
              <div className="tool-label">Input</div>
              <pre className="tool-output">{item.input}</pre>
            </>
          )
        )}
        <div className="tool-label">Output</div>
        {item.output ? <pre className="tool-output">{item.output}</pre> : <div className="muted">{item.status === 'running' ? 'No output yet.' : 'No output.'}</div>}
      </Fold>
    </div>
  );
}

/** Each file an edit changed: its path, then its diff, or why it isn't shown. */
function ToolDiffs({ diffs }: { diffs: ToolDiff[] }) {
  const theme = useTheme();
  return diffs.map((diff, at) => (
    <div className="tool-diff" key={at}>
      <div className="tool-diff-path">
        <span className="tech">{diff.path}</span>
        {'tooLarge' in diff && <span>: too large to show</span>}
      </div>
      {!('tooLarge' in diff) && <TextDiffView path={diff.path} oldText={diff.oldText ?? ''} newText={diff.newText} theme={theme} />}
    </div>
  ));
}

const STEP: Record<PlanStatus, { label: string; icon: ReactNode }> = {
  pending: { label: 'Pending', icon: <Circle className="sm" /> },
  in_progress: { label: 'In progress', icon: <CircleDot className="sm" /> },
  completed: { label: 'Done', icon: <CircleCheck className="sm" /> },
  cancelled: { label: 'Cancelled', icon: <CircleSlash className="sm" /> },
};

/** The agent's plan for its run, as it last gave it: open, each step with where it is. Nothing once emptied. */
export function PlanCard({ item }: { item: Plan }) {
  if (item.entries.length === 0) return null;
  const done = item.entries.filter((e) => e.status === 'completed').length;
  return (
    <div className="tools">
      <div className="tool plan" role="group" aria-label="Plan">
        <div className="tool-head">
          <ListTodo className="sm" />
          <span className="tool-name">plan</span>
          <span className="grow muted">{`${done} of ${item.entries.length} done`}</span>
        </div>
        <ul className="tool-body plan-steps">
          {item.entries.map((entry, at) => (
            <li key={at} className={`plan-step ${entry.status}`}>
              <span className="plan-status" role="img" aria-label={STEP[entry.status].label} title={STEP[entry.status].label}>
                {STEP[entry.status].icon}
              </span>
              <span>{entry.content}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
