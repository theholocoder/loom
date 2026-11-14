// The Highlights Panel (ADR 0010): what Session highlights' model noted the
// user should know about the Session's work, open ones grouped by kind (For
// you first), newest first, resolved ones folded under them. Each says which
// turn it came from, and can be resolved by hand, reopened, copied, or put to
// the agent as a comment in the composer. Showing the Panel marks what it
// holds seen, which clears its tab's badge.
import { Bot, Check, ChevronDown, ChevronRight, Copy, Hourglass, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { HIGHLIGHT_KINDS, HIGHLIGHT_LABELS, type Highlight, type Session } from '../shared/api';
import { useApi, useTopic } from './api';
import { useSessionModels } from './checkout';
import { listedModels, modelName } from './ModelPicker';

/** A place in the code a Highlight names, `path:line`: a path with a file extension, and a line. */
const CODE_PLACE = /`?((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[A-Za-z0-9]+):(\d+)`?/g;

export function HighlightsPanel({
  session,
  onShowTurn,
  onShowFile,
  onAsk,
  onError,
}: {
  session: Session;
  /** Scrolls the conversation to the turn starting at transcript item `itemId`. */
  onShowTurn: (itemId: number) => void;
  /** Shows `path` in Changes. */
  onShowFile: (path: string) => void;
  /** Puts the Highlight to the agent, as a comment in the composer; absent while the composer takes none. */
  onAsk?: (highlight: Highlight) => void;
  onError: (message: string) => void;
}) {
  const api = useApi();
  const value = useTopic('highlights', { sessionId: session.id });
  const settings = useTopic('settings')?.highlights;
  // Its model by name: the same agent offers the same models as the Session's.
  const models = listedModels(useSessionModels(session, session.projectId).listed);
  const checkModel = settings?.model && modelName(models, settings.model);
  const [foldedOpen, setFoldedOpen] = useState(false);
  const last = value?.highlights.at(-1)?.id ?? 0;
  // Shown, what it holds is seen: as it comes, while it shows.
  useEffect(() => {
    if (value && last > value.seenThrough) api.invoke('sessions.seeHighlights', { id: session.id }).catch(() => {});
  }, [api, session.id, last, value?.seenThrough]);
  if (!value) return null;

  const run = (promise: Promise<unknown>) => void promise.catch((e: unknown) => onError((e as Error).message));
  const resolve = (highlight: Highlight, resolved: boolean) => run(api.invoke('sessions.resolveHighlight', { id: session.id, highlightId: highlight.id, resolved }));
  const copy = (highlight: Highlight) => run(navigator.clipboard.writeText(highlightLine(highlight)));
  const open = value.highlights.filter((h) => !h.resolved);
  const resolved = value.highlights.filter((h) => h.resolved).reverse();
  const item = (highlight: Highlight) => (
    <HighlightItem key={highlight.id} highlight={highlight} onShowTurn={onShowTurn} onShowFile={onShowFile} onAsk={onAsk} onResolve={(r) => resolve(highlight, r)} onCopy={() => copy(highlight)} />
  );

  return (
    <div className="highlights" aria-label="Highlights">
      <HighlightsStatus pending={value.pending} checking={value.checking} error={value.error} on={settings?.on ?? false} model={checkModel || undefined} />
      <div className="scroll">
        {open.length === 0 ? (
          <div className="empty">
            {value.highlights.length
              ? 'Nothing open: every Highlight here was resolved.'
              : settings?.on
                ? `No highlights yet. After each turn, ${checkModel || 'a model'} notes here what you should know about the work: what's left for you, what wasn't done, risks, assumptions and decisions.`
                : 'No highlights. Turn Session highlights on in Settings to have a model note what you should know after each turn.'}
          </div>
        ) : (
          HIGHLIGHT_KINDS.map((kind) => {
            const ofKind = open.filter((h) => h.kind === kind).reverse();
            if (!ofKind.length) return null;
            return (
              <section key={kind} className="hl-group" aria-label={HIGHLIGHT_LABELS[kind]}>
                <h4 className={`hl-kind ${kind}`}>
                  {HIGHLIGHT_LABELS[kind]} <span className="muted">{ofKind.length}</span>
                </h4>
                <ul>{ofKind.map(item)}</ul>
              </section>
            );
          })
        )}
        {resolved.length > 0 && (
          <section className="hl-group resolved" aria-label="Resolved">
            <button type="button" className="hl-fold" aria-expanded={foldedOpen} onClick={() => setFoldedOpen(!foldedOpen)}>
              {foldedOpen ? <ChevronDown className="sm" /> : <ChevronRight className="sm" />}
              Resolved ({resolved.length})
            </button>
            {foldedOpen && <ul>{resolved.map(item)}</ul>}
          </section>
        )}
      </div>
    </div>
  );
}

/** How checking goes: pending, running, or why the last check failed; and whether the setting is off. */
function HighlightsStatus({ pending, checking, error, on, model }: { pending: boolean; checking: boolean; error?: string; on: boolean; model?: string }) {
  if (pending) {
    return (
      <div className="hl-status" role="status">
        <Hourglass className="sm" />
        Waiting for other checks to end before checking the last turn…
      </div>
    );
  }
  if (checking) {
    return (
      <div className="hl-status" role="status">
        <LoaderCircle className="sm spin" />
        Checking the last turn{model ? ` with ${model}` : ''}…
      </div>
    );
  }
  if (!on) return <div className="hl-status muted">Session highlights is off: no new turns are checked.</div>;
  if (error) {
    return (
      <div className="hl-status err" role="alert">
        <TriangleAlert className="sm" />
        <span>Last check failed: {error} Its turns are checked again after the next one.</span>
      </div>
    );
  }
  return null;
}

function HighlightItem({
  highlight,
  onShowTurn,
  onShowFile,
  onAsk,
  onResolve,
  onCopy,
}: {
  highlight: Highlight;
  onShowTurn: (itemId: number) => void;
  onShowFile: (path: string) => void;
  onAsk?: (highlight: Highlight) => void;
  onResolve: (resolved: boolean) => void;
  onCopy: () => void;
}) {
  const { resolved } = highlight;
  return (
    <li className={resolved ? 'hl resolved' : 'hl'}>
      <p className="hl-text">
        {resolved && <span className="sr-only">{HIGHLIGHT_LABELS[highlight.kind]}: </span>}
        {withCodePlaces(highlight.text, onShowFile)}
      </p>
      {resolved && (
        <p className="hl-why muted">
          {resolved.by === 'user' ? 'Resolved by you' : `Resolved${resolved.reason ? `: ${resolved.reason}` : ''}`}
          {resolved.itemId !== undefined && (
            <>
              {' · '}
              <button type="button" className="link" onClick={() => onShowTurn(resolved.itemId!)}>
                that turn
              </button>
            </>
          )}
        </p>
      )}
      <div className="hl-actions">
        <button type="button" className="link" onClick={() => onShowTurn(highlight.itemId)}>
          From this turn
        </button>
        <span className="grow" />
        {!resolved && onAsk && (
          <button type="button" className="icon-btn sm" title="Ask the agent about it" aria-label="Ask the agent" onClick={() => onAsk(highlight)}>
            <Bot />
          </button>
        )}
        <button type="button" className="icon-btn sm" title="Copy" aria-label="Copy" onClick={onCopy}>
          <Copy />
        </button>
        {resolved ? (
          <button type="button" className="icon-btn sm" title="Reopen" aria-label="Reopen" onClick={() => onResolve(false)}>
            <RotateCcw />
          </button>
        ) : (
          <button type="button" className="icon-btn sm" title="Resolve" aria-label="Resolve" onClick={() => onResolve(true)}>
            <Check />
          </button>
        )}
      </div>
    </li>
  );
}

/** A Highlight on one line, its kind first: what Copy copies, and what Ask the agent quotes. */
export function highlightLine(highlight: Highlight): string {
  return `${HIGHLIGHT_LABELS[highlight.kind]}: ${highlight.text}`;
}

/** `text` with each `path:line` it names as a button that shows the file in Changes. */
export function withCodePlaces(text: string, onShowFile: (path: string) => void): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(CODE_PLACE)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    const [, path, line] = match;
    parts.push(
      <button key={match.index} type="button" className="link tech" title={`Show ${path} in Changes`} onClick={() => onShowFile(path!)}>
        {`${path}:${line}`}
      </button>,
    );
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
