// A Session's Subagents (CONTEXT.md): a card for each where its parent
// started it, a readonly view of one in place of the conversation with a
// footer in place of the composer, and the Glance strip chip listing them
// once there are any.
import { ArrowLeft, Bot, CircleCheckBig, CircleSlash, LoaderCircle, OctagonX, Square, Workflow } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { modelNameIn, type ModelChoice, type Session, type Subagent, type SubagentStatus, type TranscriptItem } from '../shared/api';
import { useTopic } from './api';
import { formatDuration } from './Dashboard';
import { Markdown } from './Markdown';
import { MessageTime, withDays } from './MessageTimes';
import { ModelName } from './ModelPicker';
import { Popover } from './Popover';
import { PlanCard, ThinkingBlock, ToolCard, ToolRunCard, withRuns } from './WorkCards';

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;

const STATUS: Record<SubagentStatus, { label: string; icon: ReactNode }> = {
  running: { label: 'Running', icon: <LoaderCircle className="sm" /> },
  completed: { label: 'Completed', icon: <CircleCheckBig className="sm" /> },
  failed: { label: 'Failed', icon: <OctagonX className="sm" /> },
  interrupted: { label: 'Stopped', icon: <CircleSlash className="sm" /> },
};

/** The time now, again every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** How long it has run: until now while it runs, else until it ended. */
function elapsed(subagent: Subagent, now: number): string {
  return formatDuration(Math.max(0, (subagent.endedAt ?? now) - subagent.startedAt));
}

/** The Subagent a subagent tool call started, if Loom knows it: by the id the agent gave, else by the call. */
export function subagentOfCall(item: Tool, subagents: readonly Subagent[]): Subagent | undefined {
  return subagents.find((s) => s.id === item.subagentId) ?? subagents.find((s) => s.toolCallId === item.toolCallId && s.depth >= 1);
}

/** Whether a tool call card is one starting a Subagent, shown as its Subagent's card. */
export function startsSubagent(item: Tool, subagents: readonly Subagent[]): boolean {
  return subagentOfCall(item, subagents) !== undefined;
}

function StatusLine({ subagent }: { subagent: Subagent }) {
  const look = STATUS[subagent.status];
  return (
    <span className={`subagent-status ${subagent.status}`}>
      <span className={subagent.status === 'running' ? 'spin' : undefined} aria-hidden="true">
        {look.icon}
      </span>
      <span>{look.label}</span>
    </span>
  );
}

/**
 * A Subagent's card where its parent started it: its agent, what it does,
 * how it goes and for how long, its model when not the Session's; Stop
 * while it runs, when its agent can. Clicking it opens the Subagent.
 */
export function SubagentCard({
  subagent,
  sessionModel,
  models,
  onOpen,
  onStop,
}: {
  subagent: Subagent;
  sessionModel: string | undefined;
  /** The models the agent offers, which name the model. */
  models: readonly ModelChoice[] | undefined;
  onOpen: () => void;
  onStop?: () => void;
}) {
  const now = useNow(subagent.status === 'running');
  const running = subagent.status === 'running';
  return (
    <div className="tools">
      <div className={`tool subagent-card ${subagent.status}`} role="group" aria-label={`Subagent: ${subagent.description}`}>
        <button type="button" className="tool-head subagent-open" aria-label={`Open Subagent ${subagent.description}`} onClick={onOpen}>
          <Workflow className="sm" />
          {subagent.agent && <span className="tool-name">{subagent.agent}</span>}
          <span className="grow tool-title">{subagent.description}</span>
          {subagent.model && subagent.model !== sessionModel && (
            <span className="muted">
              <ModelName id={subagent.model} name={modelNameIn(models, subagent.model)} />
            </span>
          )}
          <span className="muted">{elapsed(subagent, now)}</span>
          <StatusLine subagent={subagent} />
        </button>
        {running && onStop && <StopButton subagent={subagent} onStop={onStop} />}
      </div>
    </div>
  );
}

function StopButton({ subagent, onStop }: { subagent: Subagent; onStop: () => void }) {
  return (
    <button type="button" className="subagent-stop" aria-label={`Stop Subagent ${subagent.description}`} title="Stop this Subagent only" onClick={onStop}>
      <Square className="sm" />
      Stop
    </button>
  );
}

/**
 * One Subagent's conversation, readonly, in place of the Session's, live
 * while it runs; its nested Subagents as cards. A footer in place of the
 * composer goes back up one level and says what it is. What it asked the
 * user is answered in the Session.
 */
export function SubagentView({
  session,
  subagent,
  subagents,
  asking,
  onOpen,
  onBack,
  onStop,
}: {
  session: Session;
  subagent: Subagent;
  subagents: readonly Subagent[];
  /** What it asks and waits on an answer to, in the Session's conversation, if anything. */
  asking: Extract<TranscriptItem, { kind: 'question' | 'approval' }> | undefined;
  onOpen: (subagentId: string) => void;
  /** Back to its parent: `undefined` for the Session. */
  onBack: (to: string | undefined) => void;
  onStop?: (subagentId: string) => void;
}) {
  const items = useTopic('subagentTranscript', { sessionId: session.id, subagentId: subagent.id }) ?? [];
  const parent = subagents.find((s) => s.id === subagent.parentId);
  const sessionModel = session.model ?? session.agentConfig?.model;
  const models = session.agentConfig?.models;
  const model = subagent.model ?? sessionModel;
  const now = useNow(subagent.status === 'running');
  const end = useRef<HTMLDivElement>(null);
  const conversationParts = withRuns(
    items,
    (item) => (item.kind === 'tool' && !startsSubagent(item, subagents) ? item : undefined),
    (item) => (item.kind === 'thinking' ? [item] : undefined),
  );
  // A block body: Chromium's scrollIntoView returns a promise, which React would take for a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [items.length]);
  return (
    <>
      <div className="chat subagent-chat" role="log" aria-label={`Subagent ${subagent.description}`} tabIndex={-1}>
        {withDays(conversationParts, (item) => ('run' in item ? undefined : item.kind === 'agent' || item.kind === 'thinking' ? item.at : undefined), (item, at, parts) =>
          'run' in item ? (
            <ToolRunCard key={item.run[0]!.id} run={item.run} live={subagent.status === 'running' && at === parts.length - 1} />
          ) : item.kind === 'agent' ? (
            <div key={item.id} className="msg agent">
              <div className="who">
                <Bot />
              </div>
              <div className="body">
                <div className="bubble">
                  <Markdown text={item.text} />
                </div>
                <MessageTime at={item.at} />
              </div>
            </div>
          ) : item.kind === 'thinking' ? (
            <div key={item.id} className="msg agent">
              <div className="who" />
              <div className="body">
                <ThinkingBlock item={item} />
              </div>
            </div>
          ) : item.kind === 'plan' ? (
            <PlanCard key={item.id} item={item} />
          ) : item.kind === 'tool' ? (
            startsSubagent(item, subagents) ? (
              <SubagentCard
                key={item.id}
                subagent={subagentOfCall(item, subagents)!}
                sessionModel={sessionModel}
                models={models}
                onOpen={() => onOpen(subagentOfCall(item, subagents)!.id)}
                onStop={onStop && (() => onStop(subagentOfCall(item, subagents)!.id))}
              />
            ) : (
              <ToolCard key={item.id} item={item} />
            )
          ) : null,
        )}
        {items.length === 0 && <p className="muted subagent-empty">{subagent.status === 'running' ? 'Nothing yet.' : 'It said nothing.'}</p>}
        {asking && (
          <div className="interruption" role="note">
            <span>{asking.kind === 'approval' ? `It asks to ${asking.tool}: ${asking.title}.` : `It asks: ${asking.message || 'a question'}.`}</span>
            <button type="button" className="link" onClick={() => onBack(undefined)}>
              Answer it in the Session
            </button>
          </div>
        )}
        <div ref={end} />
      </div>
      <footer className="subagent-footer" aria-label="Subagent">
        <button type="button" className="subagent-back" aria-label={`Back to ${parent?.description ?? session.title}`} title={`Back to ${parent?.description ?? session.title}`} onClick={() => onBack(parent?.id)}>
          <ArrowLeft className="sm" />
          <span className="subagent-back-name">{parent?.description ?? session.title}</span>
        </button>
        <span className="subagent-facts">
          {subagent.agent && <span className="tool-name">{subagent.agent}</span>}
          {model && (
            <span className="muted">
              <ModelName id={model} name={modelNameIn(models, model)} />
            </span>
          )}
          <StatusLine subagent={subagent} />
          {subagent.status === 'running' && <span className="muted">{elapsed(subagent, now)}</span>}
        </span>
        <span className="grow subagent-description">{subagent.description}</span>
        {subagent.status === 'running' && onStop && <StopButton subagent={subagent} onStop={() => onStop(subagent.id)} />}
      </footer>
    </>
  );
}

/**
 * The Glance strip chip once the Session has started a Subagent, kept after
 * they end so what they did stays at hand: it lists them all, a click
 * opening one. It does not move; the Session's Working says something runs.
 */
export function SubagentsChip({ session, open, onToggle, onOpen }: { session: Session; open: boolean; onToggle: () => void; onOpen: (subagentId: string) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const subagents = useTopic('subagents', { sessionId: session.id }) ?? [];
  const running = session.runningSubagents ?? 0;
  const count = Math.max(subagents.length, running);
  if (count === 0) return null;
  const name = count === 1 ? '1 Subagent' : `${count} Subagents`;
  const label = running === 0 ? name : running === count ? `${name} running` : `${name}, ${running} running`;
  return (
    <span className="g-chip">
      <button ref={trigger} type="button" title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={onToggle}>
        <Workflow className="sm" />
        {name}
      </button>
      {open && (
        <Popover anchor={trigger} role="dialog" label="Subagents" className="subagents-popover" onClose={onToggle}>
          <ul className="subagent-list">
            {inTreeOrder(subagents).map((subagent) => (
              <li key={subagent.id} style={{ paddingLeft: `${(subagent.depth - 1) * 16}px` }}>
                <button type="button" onClick={() => onOpen(subagent.id)}>
                  {subagent.agent && <span className="tool-name">{subagent.agent}</span>}
                  <span className="grow">{subagent.description}</span>
                  <StatusLine subagent={subagent} />
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      )}
    </span>
  );
}

/** The Subagents, each followed by the ones it started, in the order they started. */
function inTreeOrder(subagents: readonly Subagent[]): Subagent[] {
  const known = new Set(subagents.map((s) => s.id));
  const childrenOf = (parent: string | undefined) => subagents.filter((s) => (s.parentId && known.has(s.parentId) ? s.parentId : undefined) === parent);
  const walk = (parent: string | undefined): Subagent[] => childrenOf(parent).flatMap((s) => [s, ...walk(s.id)]);
  return walk(undefined);
}
