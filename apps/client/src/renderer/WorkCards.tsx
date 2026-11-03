// How the agent worked, in a Session's transcript: its thinking and its tool
// calls, each folded away behind a header the user can open.
import { Brain, ChevronRight, CircleCheckBig, LoaderCircle, OctagonX } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { TranscriptItem } from '../shared/api';

type Thinking = Extract<TranscriptItem, { kind: 'thinking' }>;
type Tool = Extract<TranscriptItem, { kind: 'tool' }>;

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

/** The agent's thinking: open while it streams, folded once done, unless the user chose. */
export function ThinkingBlock({ item }: { item: Thinking }) {
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? item.streaming;
  return (
    <div className="tools">
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
    </div>
  );
}

const STATUS = {
  running: { label: 'Running', icon: <LoaderCircle className="sm" /> },
  completed: { label: 'Completed', icon: <CircleCheckBig className="sm" /> },
  failed: { label: 'Failed', icon: <OctagonX className="sm" /> },
} as const;

/** One tool call, whoever's tool it is, folded until the user opens it. */
export function ToolCard({ item }: { item: Tool }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[item.status];
  return (
    <div className="tools">
      <Fold
        className={`tool-call ${item.status}`}
        open={open}
        onToggle={() => setOpen(!open)}
        head={
          <>
            <span className={`tool-status ${item.status}${item.status === 'running' ? ' spin' : ''}`} role="img" aria-label={status.label} title={status.label}>
              {status.icon}
            </span>
            <span className="grow tool-title">{item.title}</span>
            {item.truncated && <span className="chip">truncated</span>}
            {item.toolKind && <span className="chip">{item.toolKind}</span>}
          </>
        }
      >
        {item.input !== undefined && (
          <>
            <div className="tool-label">Input</div>
            <pre className="tool-output">{item.input}</pre>
          </>
        )}
        <div className="tool-label">Output</div>
        {item.output ? <pre className="tool-output">{item.output}</pre> : <div className="muted">{item.status === 'running' ? 'No output yet.' : 'No output.'}</div>}
      </Fold>
    </div>
  );
}
