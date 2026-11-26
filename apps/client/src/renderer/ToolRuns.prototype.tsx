// PROTOTYPE (#256), throwaway: not for main.
//
// Question: how should a run of consecutive tool calls show in a Session's
// conversation, so it stops cluttering it, yet the user still sees what the
// agent is doing now and can easily find what it did?
//
// Plan: four structurally different variants plus today's rendering, on the
// real Session conversation, switched with a floating bar (← →) and kept in
// the `?variant=` search param. Only shown in a dev build (`pnpm dev`) or a
// build made with VITE_PROTOTYPE=1.
//
// A *run* is two or more tool calls in a row (Subagent calls excepted), with
// any thinking the agent did between two of them folded in. Thinking before
// the first call stays under the agent's name line, as today.
import { Brain, ChevronLeft, ChevronRight, Eye, FilePen, FileText, Globe, LoaderCircle, OctagonX, Search, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toolLine, type TranscriptItem } from '../shared/api';
import { STATUS, ThinkingBlock, ToolCard, ToolDetail } from './WorkCards';
import './tool-runs.prototype.css';

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
type Thinking = Extract<TranscriptItem, { kind: 'thinking' }>;
type Said = Extract<TranscriptItem, { kind: 'agent' | 'thinking' }>;
export type RunMember = Tool | Thinking;
export interface Run {
  run: RunMember[];
}

export const PROTOTYPE_ON = import.meta.env.DEV || !!import.meta.env.VITE_PROTOTYPE;

// ── Variant switching ────────────────────────────────────────────────────────

export const VARIANTS = [
  { key: '0', name: 'Today' },
  { key: 'A', name: 'Summary line' },
  { key: 'B', name: 'Dense log' },
  { key: 'C', name: 'Chips' },
  { key: 'D', name: 'Fold the looking, keep the doing' },
] as const;
export type VariantKey = (typeof VARIANTS)[number]['key'];

const listeners = new Set<() => void>();
function readVariant(): VariantKey {
  const v = new URLSearchParams(location.search).get('variant');
  return (VARIANTS.find((x) => x.key === v)?.key ?? 'A') as VariantKey;
}
function setVariant(key: VariantKey) {
  const url = new URL(location.href);
  url.searchParams.set('variant', key);
  history.replaceState(history.state, '', url);
  listeners.forEach((l) => l());
}
export function useVariant(): VariantKey {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readVariant,
  );
}

/** The floating bar: ← variant →, arrow keys too (not while typing or on a tab list). */
export function PrototypeSwitcher() {
  const variant = useVariant();
  const at = VARIANTS.findIndex((v) => v.key === variant);
  const step = (by: number) => setVariant(VARIANTS[(at + by + VARIANTS.length) % VARIANTS.length]!.key);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="tab"], [role="tablist"], [role="slider"]')) return;
      step(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!PROTOTYPE_ON) return null;
  return (
    <div className="proto-switcher" role="toolbar" aria-label="Prototype variants">
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">
        <ChevronLeft className="sm" />
      </button>
      <span>
        <b>{variant}</b> {VARIANTS[at]!.name}
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">
        <ChevronRight className="sm" />
      </button>
    </div>
  );
}

// ── Grouping ─────────────────────────────────────────────────────────────────

/**
 * Gathers runs of plain tool calls out of the conversation's parts (as
 * Sessions' `turnParts` gives them). `plain` tells a call that isn't a
 * Subagent's.
 */
export function withRuns<P extends TranscriptItem | { said: Said[] }>(parts: P[], plain: (t: Tool) => boolean): Array<P | Run> {
  const isTool = (p: P | undefined): p is P & Tool => !!p && !('said' in p) && p.kind === 'tool' && plain(p);
  const onlyThinking = (p: P | undefined): p is P & { said: Thinking[] } => !!p && 'said' in p && p.said.every((s) => s.kind === 'thinking');
  const out: Array<P | Run> = [];
  let i = 0;
  while (i < parts.length) {
    if (!isTool(parts[i])) {
      out.push(parts[i]!);
      i++;
      continue;
    }
    const members: RunMember[] = [];
    let j = i;
    for (; j < parts.length; j++) {
      const p = parts[j];
      if (isTool(p)) members.push(p);
      else if (onlyThinking(p) && isTool(parts[j + 1])) members.push(...p.said);
      else break;
    }
    if (members.filter((m) => m.kind === 'tool').length >= 2) out.push({ run: members });
    else out.push(...parts.slice(i, j));
    i = j;
  }
  return out;
}

// ── What a call is about ─────────────────────────────────────────────────────

type Category = 'read' | 'search' | 'run' | 'edit' | 'fetch' | 'other';
const CATEGORY: Record<Category, { icon: LucideIcon; one: string; many: (n: number) => string; looking: boolean }> = {
  read: { icon: FileText, one: 'read 1 file', many: (n) => `read ${n} files`, looking: true },
  search: { icon: Search, one: 'searched once', many: (n) => `searched ${n} times`, looking: true },
  fetch: { icon: Globe, one: 'fetched 1 page', many: (n) => `fetched ${n} pages`, looking: true },
  run: { icon: SquareTerminal, one: 'ran 1 command', many: (n) => `ran ${n} commands`, looking: false },
  edit: { icon: FilePen, one: 'edited 1 file', many: (n) => `edited ${n} files`, looking: false },
  other: { icon: Wrench, one: '1 other call', many: (n) => `${n} other calls`, looking: false },
};
function categoryOf(t: Tool): Category {
  const k = t.toolKind ?? '';
  const n = (t.name ?? '').toLowerCase();
  if (t.command !== undefined || k === 'execute' || n === 'bash' || n === 'shell') return 'run';
  if (k === 'edit' || k === 'delete' || k === 'move' || t.diffs?.length || /edit|write|patch/.test(n)) return 'edit';
  if (k === 'read' || n === 'read' || n === 'list' || n === 'ls') return 'read';
  if (k === 'search' || /grep|glob|find|search/.test(n)) return 'search';
  if (k === 'fetch' || /fetch|web/.test(n)) return 'fetch';
  return 'other';
}
const tools = (run: RunMember[]) => run.filter((m): m is Tool => m.kind === 'tool');

/** "read 3 files, searched twice, ran 1 command", in the order first done. */
function summary(calls: Tool[]): string {
  const counts = new Map<Category, number>();
  for (const c of calls) counts.set(categoryOf(c), (counts.get(categoryOf(c)) ?? 0) + 1);
  const parts = [...counts].map(([cat, n]) => (n === 1 ? CATEGORY[cat].one : CATEGORY[cat].many(n)));
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function StatusIcon({ t }: { t: Tool }) {
  const s = STATUS[t.status];
  return (
    <span className={`tool-status ${t.status}${t.status === 'running' ? ' spin' : ''}`} role="img" aria-label={s.label} title={s.label}>
      {s.icon}
    </span>
  );
}

function CallLine({ t }: { t: Tool }) {
  const { tool, what } = toolLine(t);
  return (
    <>
      <span className="tool-name">{tool}</span>
      <span className="grow tool-title">{what}</span>
    </>
  );
}

/** A call on one line that opens to its detail in place, without a card. */
function CallRow({ t, className = '' }: { t: Tool; className?: string }) {
  const [open, setOpen] = useState(false);
  const { tool, what } = toolLine(t);
  return (
    <div className={`proto-row ${t.status} ${className}`}>
      <button type="button" className="proto-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className={`sm chev${open ? ' open' : ''}`} />
        <span className="tool-name">{tool}</span>
        <span className="grow tool-title">{what}</span>
        <StatusIcon t={t} />
      </button>
      {open && (
        <div className="proto-row-body">
          <ToolDetail item={t} />
        </div>
      )}
    </div>
  );
}

function ThoughtRow({ th }: { th: Thinking }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="proto-row thought">
      <button type="button" className="proto-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className={`sm chev${open ? ' open' : ''}`} />
        <Brain className="sm" />
        <span className="grow tool-title">{open ? 'Thought' : th.text.split('\n')[0]}</span>
      </button>
      {open && <div className="proto-row-body thinking-text">{th.text}</div>}
    </div>
  );
}

// ── The variants ─────────────────────────────────────────────────────────────

/** Renders one run in the current variant. `live` when it's the run the agent is in now. */
export function ToolRun({ variant, run, live }: { variant: VariantKey; run: RunMember[]; live: boolean }) {
  switch (variant) {
    case 'A':
      return <SummaryLine run={run} live={live} />;
    case 'B':
      return <DenseLog run={run} live={live} />;
    case 'C':
      return <Chips run={run} live={live} />;
    case 'D':
      return <LookingFolded run={run} live={live} />;
    default:
      return <Today run={run} />;
  }
}

/** 0 · Today: one card per call, as it is in main. */
function Today({ run }: { run: RunMember[] }) {
  return run.map((m) =>
    m.kind === 'tool' ? (
      <ToolCard key={m.id} item={m} />
    ) : (
      <div key={m.id} className="tools">
        <ThinkingBlock item={m} />
      </div>
    ),
  );
}

/**
 * A · Summary line: the whole run is one folded line saying what it did
 * ("Read 4 files, searched 3 times, ran 1 command"), a failure count, and,
 * while it runs, the call going on now. Opened, a compact list of its calls,
 * each opening in place.
 */
function SummaryLine({ run, live }: { run: RunMember[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const calls = tools(run);
  const failed = calls.filter((c) => c.status === 'failed').length;
  const now = calls.findLast((c) => c.status === 'running') ?? (live ? calls.at(-1) : undefined);
  const cats = [...new Set(calls.map(categoryOf))];
  return (
    <div className="tools">
      <div className={`tool proto-a${live ? ' live' : ''}${failed ? ' has-failed' : ''}`}>
        <button type="button" className="tool-head proto-a-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight className={`sm chev${open ? ' open' : ''}`} />
          <span className="proto-a-icons">
            {cats.map((c) => {
              const I = CATEGORY[c].icon;
              return <I key={c} className="sm" />;
            })}
          </span>
          <span className="grow tool-title">
            {summary(calls)}
            {now && !open && (
              <span className="proto-a-now">
                {' · '}
                <CallLine t={now} />
              </span>
            )}
          </span>
          {failed > 0 && (
            <span className="proto-badge err">
              <OctagonX className="sm" /> {failed} failed
            </span>
          )}
          <span className="proto-count">{calls.length} calls</span>
          {live ? (
            <span className="tool-status running spin">
              <LoaderCircle className="sm" />
            </span>
          ) : (
            <StatusIcon t={{ ...calls.at(-1)!, status: failed && failed === calls.length ? 'failed' : 'completed' }} />
          )}
        </button>
        {open && (
          <div className="proto-a-list">
            {run.map((m) => (m.kind === 'tool' ? <CallRow key={m.id} t={m} /> : <ThoughtRow key={m.id} th={m} />))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * B · Dense log: no card per call; the run is one box of tight log lines,
 * a status dot on a rail. A long run shows its first 2 and last 3 lines,
 * the middle behind "N more". The line running now is lit.
 */
function DenseLog({ run, live }: { run: RunMember[]; live: boolean }) {
  const [all, setAll] = useState(false);
  const HEAD = 2;
  const TAIL = 3;
  const hidden = !all && run.length > HEAD + TAIL + 1 ? run.length - HEAD - TAIL : 0;
  const shown = hidden ? [...run.slice(0, HEAD), null, ...run.slice(-TAIL)] : run;
  const lastTool = tools(run).at(-1);
  return (
    <div className="tools">
      <div className="proto-b">
        {shown.map((m, i) =>
          m === null ? (
            <button key="more" type="button" className="proto-b-more" onClick={() => setAll(true)}>
              ⋯ {hidden} more
              {(() => {
                const f = tools(run.slice(HEAD, run.length - TAIL)).filter((t) => t.status === 'failed').length;
                return f ? <span className="proto-badge err">{` · ${f} failed`}</span> : null;
              })()}
            </button>
          ) : m.kind === 'tool' ? (
            <CallRow key={m.id} t={m} className={live && m === lastTool ? 'now' : ''} />
          ) : (
            <ThoughtRow key={m.id ?? i} th={m} />
          ),
        )}
        {all && run.length > HEAD + TAIL + 1 && (
          <button type="button" className="proto-b-more" onClick={() => setAll(false)}>
            Show less
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * C · Chips: the run is a flow of small chips (tool + what, cut short),
 * wrapping like words. Clicking one opens its detail under the flow, one at
 * a time. Failed chips are red, the running one pulses. Thinking is a brain chip.
 */
function Chips({ run, live }: { run: RunMember[]; live: boolean }) {
  const [openId, setOpenId] = useState<number>();
  const opened = run.find((m) => m.id === openId);
  const lastTool = tools(run).at(-1);
  return (
    <div className="tools">
      <div className="proto-c">
        {run.map((m) => {
          if (m.kind === 'thinking') {
            return (
              <button key={m.id} type="button" className={`proto-chip thought${openId === m.id ? ' open' : ''}`} title={m.text} onClick={() => setOpenId(openId === m.id ? undefined : m.id)}>
                <Brain className="sm" />
              </button>
            );
          }
          const { tool, what } = toolLine(m);
          const I = CATEGORY[categoryOf(m)].icon;
          return (
            <button
              key={m.id}
              type="button"
              className={`proto-chip ${m.status}${openId === m.id ? ' open' : ''}${live && m === lastTool ? ' now' : ''}`}
              title={`${tool} ${what ?? ''}`}
              onClick={() => setOpenId(openId === m.id ? undefined : m.id)}
            >
              <I className="sm" />
              <span className="tool-name">{tool}</span>
              {what && <span className="proto-chip-what">{what}</span>}
              {m.status === 'failed' && <OctagonX className="sm" />}
            </button>
          );
        })}
      </div>
      {opened && (
        <div className="tool proto-c-detail">
          <div className="tool-head">
            {opened.kind === 'tool' ? (
              <>
                <CallLine t={opened} />
                <StatusIcon t={opened} />
              </>
            ) : (
              <>
                <Brain className="sm" />
                <span className="grow">Thought</span>
              </>
            )}
          </div>
          <div className="tool-body">{opened.kind === 'tool' ? <ToolDetail item={opened} /> : <div className="thinking-text">{opened.text}</div>}</div>
        </div>
      )}
    </div>
  );
}

/**
 * D · Fold the looking, keep the doing: reads, searches and fetches in a row
 * fold into one quiet line ("Looked at 6 things: read 4 files, searched
 * twice"), opening to their list; what changes something (edits, commands)
 * or failed keeps its own card, in place. While a look runs, its line says
 * which.
 */
function LookingFolded({ run, live }: { run: RunMember[]; live: boolean }) {
  const groups: Array<{ looking: RunMember[] } | Tool> = [];
  for (const m of run) {
    const looks = m.kind === 'thinking' || (CATEGORY[categoryOf(m)].looking && m.status !== 'failed');
    const last = groups.at(-1);
    if (looks) {
      if (last && 'looking' in last) last.looking.push(m);
      else groups.push({ looking: [m] });
    } else groups.push(m);
  }
  return groups.map((g, i) =>
    'looking' in g ? (
      tools(g.looking).length === 0 ? (
        g.looking.map((th) => (
          <div key={th.id} className="tools">
            <ThinkingBlock item={th as Thinking} />
          </div>
        ))
      ) : (
        <LookLine key={g.looking[0]!.id} members={g.looking} live={live && i === groups.length - 1} />
      )
    ) : (
      <ToolCard key={g.id} item={g} />
    ),
  );
}

function LookLine({ members, live }: { members: RunMember[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const calls = tools(members);
  const now = calls.findLast((c) => c.status === 'running') ?? (live ? calls.at(-1) : undefined);
  return (
    <div className="tools">
      <div className="proto-d">
        <button type="button" className="proto-d-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight className={`sm chev${open ? ' open' : ''}`} />
          <Eye className="sm" />
          <span className="grow tool-title">
            {calls.length === 1 ? (
              <CallLine t={calls[0]!} />
            ) : (
              <>
                Looked at {calls.length} things <span className="muted">· {summary(calls).toLowerCase()}</span>
              </>
            )}
            {now && calls.length > 1 && !open && (
              <span className="proto-a-now">
                {' · '}
                <CallLine t={now} />
              </span>
            )}
          </span>
          {now && now.status === 'running' && (
            <span className="tool-status running spin">
              <LoaderCircle className="sm" />
            </span>
          )}
        </button>
        {open && <div className="proto-d-list">{members.map((m) => (m.kind === 'tool' ? <CallRow key={m.id} t={m} /> : <ThoughtRow key={m.id} th={m} />))}</div>}
      </div>
    </div>
  );
}

