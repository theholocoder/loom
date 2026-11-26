// How the agent worked, in a Session's transcript: its thinking and its tool
// calls, each folded away behind a header the user can open (a run of calls
// in a row behind one), and its plan.
import { Brain, ChevronRight, Circle, CircleCheck, CircleCheckBig, CircleDot, CircleSlash, FilePen, FileText, Globe, ListTodo, LoaderCircle, OctagonX, Search, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react';
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
            <StatusIcon status={item.status} />
          </>
        }
      >
        <ToolDetail item={item} />
      </Fold>
    </div>
  );
}

/** Inside a tool call: a shell call's command, an edit's diffs, or its input; then its output. */
function ToolDetail({ item }: { item: Tool }) {
  return (
    <>
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
    </>
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

/** A tool call's status, as an icon named for it. */
function StatusIcon({ status }: { status: Tool['status'] }) {
  return (
    <span className={`tool-status ${status}${status === 'running' ? ' spin' : ''}`} role="img" aria-label={STATUS[status].label} title={STATUS[status].label}>
      {STATUS[status].icon}
    </span>
  );
}

/** Tool calls in a row, with the thinking between two of them: shown as one line. */
export interface ToolRun {
  run: Array<Tool | Thinking>;
}

/**
 * Gathers the runs out of a conversation's parts: two or more tool calls in
 * a row (`callOf` says which parts are calls that may join one), with the
 * thinking between two of them (`thoughtsOf` says which parts are only
 * thinking). Thinking before the first call, and every other part, ends a
 * run; a call alone stays as it is.
 */
export function withRuns<P>(parts: P[], callOf: (part: P) => Tool | undefined, thoughtsOf: (part: P) => Thinking[] | undefined): Array<P | ToolRun> {
  const out: Array<P | ToolRun> = [];
  let at = 0;
  while (at < parts.length) {
    if (!callOf(parts[at]!)) {
      out.push(parts[at++]!);
      continue;
    }
    const run: ToolRun['run'] = [];
    let end = at;
    for (; end < parts.length; end++) {
      const part = parts[end]!;
      const call = callOf(part);
      const thoughts = call ? undefined : thoughtsOf(part);
      if (call) run.push(call);
      else if (thoughts && end + 1 < parts.length && callOf(parts[end + 1]!)) run.push(...thoughts);
      else break;
    }
    if (run.length > 1) out.push({ run });
    else out.push(parts[at]!);
    at = end;
  }
  return out;
}

type Category = 'read' | 'search' | 'run' | 'edit' | 'fetch' | 'other';

/** What a run's calls did, by category: its icon, and how the summary says it. Reads and edits count files. */
const CATEGORY: Record<Category, { icon: LucideIcon; label: string; says: (n: number) => string }> = {
  read: { icon: FileText, label: 'Read', says: (n) => `read ${n} ${n === 1 ? 'file' : 'files'}` },
  search: { icon: Search, label: 'Searched', says: (n) => (n === 1 ? 'searched once' : `searched ${n} times`) },
  run: { icon: SquareTerminal, label: 'Ran commands', says: (n) => `ran ${n} ${n === 1 ? 'command' : 'commands'}` },
  edit: { icon: FilePen, label: 'Edited', says: (n) => `edited ${n} ${n === 1 ? 'file' : 'files'}` },
  fetch: { icon: Globe, label: 'Fetched', says: (n) => `fetched ${n} ${n === 1 ? 'page' : 'pages'}` },
  other: { icon: Wrench, label: 'Other tools', says: (n) => `${n} other ${n === 1 ? 'call' : 'calls'}` },
};

/** Which category a call is in, from its kind, or else its tool's name. */
function categoryOf(call: Tool): Category {
  const kind = call.toolKind ?? '';
  const name = (call.name ?? '').toLowerCase();
  if (call.command !== undefined || kind === 'execute' || name === 'bash' || name === 'shell') return 'run';
  if (kind === 'edit' || kind === 'delete' || kind === 'move' || call.diffs?.length || /edit|write|patch/.test(name)) return 'edit';
  if (kind === 'read' || name === 'read' || name === 'list') return 'read';
  if (kind === 'search' || /grep|glob|find|search/.test(name)) return 'search';
  if (kind === 'fetch' || /fetch/.test(name)) return 'fetch';
  return 'other';
}

/** The files a read or an edit worked on, or else the call itself, so each counts once. */
function filesOf(call: Tool): string[] {
  if (call.diffs?.length) return call.diffs.map((d) => d.path);
  if (call.subject) return call.subject.split(', ');
  return [`#${call.toolCallId}`];
}

/** What a run did, category by category in the order first done: "Read 2 files, searched once". */
function summaryOf(calls: Tool[]): { categories: Category[]; text: string } {
  const counted = new Map<Category, Set<string>>();
  for (const call of calls) {
    const category = categoryOf(call);
    const seen = counted.get(category) ?? new Set<string>();
    for (const key of category === 'read' || category === 'edit' ? filesOf(call) : [call.toolCallId]) seen.add(key);
    counted.set(category, seen);
  }
  const text = [...counted].map(([category, seen]) => CATEGORY[category].says(seen.size)).join(', ');
  return { categories: [...counted.keys()], text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/**
 * A run of tool calls on one line until the user opens it: an icon for each
 * kind of thing it did, what it did, how many of its calls failed and how
 * many there are, and where it ended. While the agent works in it (`live`),
 * the call going on now ends the line. Inside, a row per call and per thought.
 */
export function ToolRunCard({ run, live }: { run: ToolRun['run']; live: boolean }) {
  const [open, setOpen] = useState(false);
  const calls = run.filter((m): m is Tool => m.kind === 'tool');
  const last = calls.at(-1)!;
  const failed = calls.filter((c) => c.status === 'failed').length;
  const now = live ? (calls.findLast((c) => c.status === 'running') ?? last) : undefined;
  const { categories, text } = summaryOf(calls);
  return (
    <div className="tools">
      <Fold
        className={`tool-run${live ? ' live' : ''}${failed ? ' failed-calls' : ''}`}
        open={open}
        onToggle={() => setOpen(!open)}
        head={
          <>
            <span className="tool-run-icons">
              {categories.map((category) => {
                const Icon = CATEGORY[category].icon;
                return <Icon key={category} className="sm" aria-hidden />;
              })}
            </span>
            <span className="grow tool-title">
              {text}
              {now && (
                <span className="tool-run-now">
                  {' · '}
                  <span className="tool-name">{toolLine(now).tool}</span> {toolLine(now).what}
                </span>
              )}
            </span>
            {failed > 0 && (
              <span className="tool-run-failed">{`${failed} failed`}</span>
            )}
            <span className="muted tool-run-count">{`${calls.length} calls`}</span>
            <StatusIcon status={live ? 'running' : last.status} />
          </>
        }
      >
        {run.map((member) => (member.kind === 'tool' ? <ToolRow key={member.id} item={member} /> : <ThoughtRow key={member.id} item={member} />))}
      </Fold>
    </div>
  );
}

/** One call of a run, on a line without a card, opening to its detail in place. */
function ToolRow({ item }: { item: Tool }) {
  const [open, setOpen] = useState(false);
  const { tool, what } = toolLine(item);
  return (
    <Fold
      className={`tool-row ${item.status}`}
      open={open}
      onToggle={() => setOpen(!open)}
      head={
        <>
          <span className="tool-name">{tool}</span>
          <span className="grow tool-title">{what}</span>
          {item.truncated && <span className="chip">truncated</span>}
          <StatusIcon status={item.status} />
        </>
      }
    >
      <ToolDetail item={item} />
    </Fold>
  );
}

/** A thought of a run: its first line, opening to all of it. */
function ThoughtRow({ item }: { item: Thinking }) {
  const [open, setOpen] = useState(false);
  return (
    <Fold
      className="tool-row thought"
      open={open}
      onToggle={() => setOpen(!open)}
      head={
        <>
          <Brain className="sm" aria-hidden />
          <span className="grow tool-title">{item.text.split('\n')[0]}</span>
        </>
      }
    >
      <div className="thinking-text">{item.text}</div>
    </Fold>
  );
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
