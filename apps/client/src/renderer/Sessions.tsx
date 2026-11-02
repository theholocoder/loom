// The main pane for Sessions: starting one, and its chat, following
// docs/prototypes/ui-layout.html.
import { Archive, ArrowUp, Bot, CircleAlert, CircleCheckBig, FolderTree, LoaderCircle, OctagonX, Pause, SquareTerminal, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { OPENCODE_NAME, type Session, type WaitingReason } from '../shared/api';
import { useApi, useTopic } from './api';

const WAITING: Record<WaitingReason, { label: string; icon: LucideIcon }> = {
  finished: { label: 'Finished', icon: CircleCheckBig },
  stopped: { label: 'Stopped', icon: Pause },
  question: { label: 'Asked a question', icon: CircleAlert },
  approval: { label: 'Needs approval', icon: CircleAlert },
  stuck: { label: 'Stuck', icon: CircleAlert },
  error: { label: 'Error', icon: OctagonX },
  interrupted: { label: 'Interrupted', icon: CircleAlert },
  feedback: { label: 'Feedback', icon: CircleAlert },
};

/** What the Session's status says, in words and as an icon. */
export function statusOf(session: Session): { label: string; icon: LucideIcon; className: string } {
  if (session.status === 'working') return { label: 'Working', icon: LoaderCircle, className: 'st-working' };
  if (session.status === 'archived') return { label: 'Archived', icon: Archive, className: 'st-archived' };
  const reason = session.waitingReason ?? 'finished';
  return { ...WAITING[reason], className: `st-waiting-${reason}` };
}

export function StatusIcon({ session }: { session: Session }) {
  const { label, icon: Icon, className } = statusOf(session);
  const icon = <Icon className="sm" />;
  return (
    <span className={className} title={label}>
      {session.status === 'working' ? <span className="spin">{icon}</span> : icon}
    </span>
  );
}

/** Starting a Session: which Project, which working copy, and the first prompt. */
export function NewSession({ onStarted }: { onStarted: (session: Session) => void }) {
  const api = useApi();
  const projects = useTopic('projects') ?? [];
  const [projectId, setProjectId] = useState<number>();
  const chosen = projects.find((p) => p.id === projectId) ?? projects[0];
  const [error, setError] = useState<string>();

  const start = async (prompt: string) => {
    if (!chosen) return false;
    setError(undefined);
    try {
      onStarted(await api.invoke('sessions.create', { projectId: chosen.id, workingCopy: 'checkout', prompt }));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <main className="main" aria-label="New Session">
      <div className="main-head">
        <h1>New Session</h1>
      </div>
      <div className="chat">
        {projects.length === 0 && <div className="empty">Add a Project before starting a Session.</div>}
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
      </div>
      {chosen && (
        <Composer
          agent={OPENCODE_NAME}
          placeholder={`Tell ${OPENCODE_NAME} what to do…`}
          onSend={start}
          tools={
            <>
              <label className="pick" title="Project">
                <FolderTree className="sm" />
                <b>{chosen.name}</b>
                <select aria-label="Project" value={chosen.id} onChange={(event) => setProjectId(Number(event.target.value))}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pick" title="Working copy">
                <b>Stay on current branch</b>
                {/* New worktrees, Loom's default, are not built yet. */}
                <select aria-label="Working copy" value="checkout" onChange={() => {}}>
                  <option value="checkout">Stay on current branch</option>
                  <option value="worktree" disabled>
                    New worktree
                  </option>
                </select>
              </label>
            </>
          }
        />
      )}
    </main>
  );
}

/** One Session: its header, its conversation and the composer. */
export function SessionView({ session }: { session: Session }) {
  const api = useApi();
  const items = useTopic('transcript', { sessionId: session.id }) ?? [];
  const project = useTopic('projects')?.find((p) => p.id === session.projectId);
  const [error, setError] = useState<string>();
  const status = statusOf(session);
  const working = session.status === 'working';
  // The conversation lives only while the Client runs; the error is stored.
  const unshownError = session.waitingReason === 'error' && session.error && !items.some((i) => i.kind === 'error') ? session.error : undefined;

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView?.({ block: 'end' }), [items]);

  const send = async (prompt: string) => {
    setError(undefined);
    try {
      await api.invoke('sessions.send', { id: session.id, prompt });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <main className="main" aria-label="Session">
      <div className="main-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="crumb">
            {project && <span>{project.name}</span>}
            <span className="chip" title={session.workingCopy.path}>
              <FolderTree className="sm" />
              {session.workingCopy.kind}
            </span>
          </div>
          <div className="row">
            <h1 className="ellipsis">{session.title}</h1>
            <StatusIcon session={session} />
            <span className={`${status.className} chip`} role="status" aria-label="Session status">
              {status.label}
            </span>
          </div>
        </div>
      </div>
      <div className="chat" role="log" aria-label="Conversation">
        {items.map((item) =>
          item.kind === 'user' ? (
            <div key={item.id} className="msg user">
              <div className="body" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div className="bubble">{item.text}</div>
              </div>
            </div>
          ) : item.kind === 'agent' ? (
            <div key={item.id} className="msg agent">
              <div className="who">
                <Bot />
              </div>
              <div className="body">
                <div className="name">{session.agent}</div>
                <div className="bubble">{item.text}</div>
              </div>
            </div>
          ) : (
            <ErrorCard key={item.id} message={item.message} />
          ),
        )}
        {unshownError && <ErrorCard message={unshownError} />}
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
        <div ref={end} />
      </div>
      <Composer
        agent={session.agent}
        placeholder={working ? `${session.agent} is working…` : `Reply to ${session.agent}…`}
        disabled={working}
        onSend={send}
      />
    </main>
  );
}

/** A run that failed, with the agent's message. */
function ErrorCard({ message }: { message: string }) {
  return (
    <div className="tools">
      <div className="tool failed" role="alert">
        <div className="tool-head">
          <OctagonX className="sm" />
          <span className="name">error</span>
          <span className="grow">{message}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The prompt box, with the agent's label and `tools` in its toolbar. Enter
 * sends, Shift+Enter adds a line. `onSend` resolves to whether to clear it.
 */
function Composer({
  agent,
  placeholder,
  disabled = false,
  tools,
  onSend,
}: {
  /** The agent Sessions run on; a label, not a picker, in v1. */
  agent: string;
  placeholder: string;
  disabled?: boolean;
  tools?: ReactNode;
  onSend: (prompt: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const canSend = !disabled && !sending && draft.trim() !== '';

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      if (await onSend(draft)) setDraft('');
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) void send(event);
  };

  return (
    <form className="composer-wrap" onSubmit={send}>
      <div className="composer">
        <textarea aria-label="Prompt" rows={2} placeholder={placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        <div className="ctoolbar">
          <span className="pick" title="Agent" style={{ cursor: 'default' }}>
            <SquareTerminal className="sm" />
            <b>{agent}</b>
          </span>
          {tools}
          <span className="grow" />
          <button className="primary send" type="submit" disabled={!canSend}>
            <ArrowUp />
            Send
          </button>
        </div>
      </div>
      <div className="hint">
        <span>
          <kbd>Enter</kbd> send
        </span>
        <span>
          <kbd>Shift Enter</kbd> newline
        </span>
      </div>
    </form>
  );
}
