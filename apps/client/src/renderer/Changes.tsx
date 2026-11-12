// The Changes Panel: what the open Session changed, all of it, its commits or
// what isn't committed yet, as a file tree (above the diffs in a narrow
// Panel, beside them in a wide one) and unified per-file diffs loaded as they
// are expanded or scrolled to, each line or range of which can be commented
// on: a comment shows as a note on its lines until it is sent. It follows the
// working copy as it changes, whoever changes it.
import { ArrowRightToLine, ChevronDown, ChevronRight, CircleHelp, Columns2, Folder, GitBranch, ListTree, MessageSquareCode, RefreshCw, Rows2, SquarePen, WrapText, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { DEFAULT_DIFF_VIEW, DEFAULT_SETTINGS, DIFF_SCOPES, diffCommentRange, type DiffBaseSource, type DiffComment, type DiffCounts, type DiffFile, type DiffScope, type DiffSummary, type DiffViewSettings, type FileDiff, type Session } from '../shared/api';
import type { Theme } from '../shared/appearance';
import { useApi, useTopic } from './api';
import { quoteRange, type LineRange, type Quote } from './diff-comments';
import { FileDiffView, type Commenting } from './FileDiffView';
import { SearchPicker, type Loaded as LoadedList, type PickerOption } from './SearchPicker';
import { copyable } from './ContextMenu';

/** Files with more changed lines than this start collapsed. */
export const LARGE_FILE_LINES = 1000;
/** From this width on, the Panel shows the file tree beside the diffs rather than above them. */
export const WIDE_CHANGES_PX = 700;
/** How often a shown Changes Panel checks whether the working copy changed, in ms. */
export const WATCH_INTERVAL_MS = 2_000;

const STATUS_LABEL: Record<DiffFile['status'], string> = { committed: 'committed', modified: 'modified', untracked: 'untracked' };
const SCOPE_LABEL: Record<DiffScope, string> = { all: 'All', committed: 'Committed', uncommitted: 'Uncommitted' };
/** What a scope with no files says, given what it is against. */
const NOTHING_IN: Record<DiffScope, (base: string) => string> = {
  all: (base) => `No changes against ${base}.`,
  committed: (base) => `No commits on this branch since ${base}.`,
  uncommitted: () => 'Nothing changed since the last commit.',
};

/** The comments on the diff waiting to go with the next message, and what adds and removes them. */
export interface DiffComments {
  /** Each with its place among all the comments going with the message, and the range it was picked as. */
  pending: Array<{ index: number; comment: DiffComment; range: LineRange }>;
  add(comment: DiffComment, range: LineRange): void;
  remove(index: number): void;
}

/**
 * The Session's changes, worked out when the Panel is shown: on first show,
 * on each show after, at each turn end while shown, whenever the working copy
 * changes while shown, and on Refresh.
 */
export function ChangesView({ session, comments }: { session: Session; comments?: DiffComments }) {
  return <SessionDiff key={session.id} session={session} comments={comments} />;
}

type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; summary: DiffSummary };

function SessionDiff({ session, comments }: { session: Session; comments?: DiffComments }) {
  const api = useApi();
  const settings = useTopic('settings');
  const [view, changeView] = useDiffView(settings?.diffView);
  const live = session.status !== 'archived';
  const [scope, setScope] = useState<DiffScope>('all');
  const [refreshes, setRefreshes] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const root = useRef<HTMLDivElement>(null);
  const wide = useWide(root, WIDE_CHANGES_PX);
  // A turn ending refreshes it; so do the working copy changing, showing it again and the refresh button.
  const turnEnded = useTurnsEnded(session.status);
  const changed = useWorkingCopyChanges(session.id, live);
  useEffect(() => {
    let current = true;
    setLoaded((l) => (l.state === 'done' ? l : { state: 'loading' }));
    api.invoke('sessions.diff', { id: session.id, scope }).then(
      (summary) => current && setLoaded({ state: 'done', summary }),
      (error: unknown) => current && setLoaded({ state: 'error', message: (error as Error).message }),
    );
    return () => {
      current = false;
    };
  }, [api, session.id, scope, refreshes, turnEnded, changed]);

  const summary = loaded.state === 'done' ? loaded.summary : undefined;
  const readOnly = !summary?.available || summary.readOnly;
  const available = summary?.available ? summary : undefined;
  const refresh = () => setRefreshes((r) => r + 1);
  return (
    <div className="changes" ref={root}>
      <div className="changes-bar" role="toolbar" aria-label="Changes">
        {live ? <ScopeControl scope={scope} counts={available?.counts} onChange={setScope} /> : null}
        {live && scope === 'uncommitted' ? <Compared base="HEAD" scope={scope} /> : null}
        {live && available && !available.readOnly && scope !== 'uncommitted' && available.baseSource ? (
          <>
            <DiffBase session={session} base={available.base} onChanged={refresh} />
            <Compared base={available.base} source={available.baseSource} scope={scope} />
          </>
        ) : null}
        <span className="grow" />
        <DiffViewToggles view={view} onChange={changeView} />
        <button className="icon-btn sm" type="button" title="Refresh" aria-label="Refresh changes" onClick={refresh}>
          <RefreshCw />
        </button>
      </div>
      {loaded.state === 'loading' ? (
        <div className="scroll">
          <div className="diff-loading" role="status">
            Working out the changes…
          </div>
        </div>
      ) : loaded.state === 'error' ? (
        <div className="scroll">
          <div className="empty" role="alert">
            {loaded.message}
          </div>
        </div>
      ) : !loaded.summary.available ? (
        <div className="scroll">
          <div className="empty">{loaded.summary.reason}</div>
        </div>
      ) : loaded.summary.files.length === 0 ? (
        <div className="scroll">
          <div className="empty">{NOTHING_IN[scope](loaded.summary.base)}</div>
        </div>
      ) : (
        <DiffFiles
          files={loaded.summary.files}
          read={(file) => api.invoke('sessions.diffFile', { id: session.id, path: file.path, scope })}
          onOpenInEditor={readOnly ? undefined : (file) => void api.invoke('sessions.openInEditor', { id: session.id, file: file.path }).catch((error: unknown) => console.error(error))}
          comments={readOnly ? undefined : comments}
          wide={wide}
          patterns={settings?.diffCollapsedPatterns ?? []}
          theme={settings?.theme ?? DEFAULT_SETTINGS.theme}
          view={view}
          onViewChange={changeView}
          version={`${scope}:${refreshes}:${turnEnded}:${changed}`}
        />
      )}
    </div>
  );
}

/** All, Committed or Uncommitted, each with how many files it holds when that's known. */
function ScopeControl({ scope, counts, onChange }: { scope: DiffScope; counts: DiffCounts | undefined; onChange: (scope: DiffScope) => void }) {
  return (
    <span className="seg" role="radiogroup" aria-label="Which changes">
      {DIFF_SCOPES.map((s) => (
        <button key={s} type="button" role="radio" className={s === scope ? 'on' : undefined} aria-checked={s === scope} onClick={() => onChange(s)}>
          {SCOPE_LABEL[s]}
          {counts?.[s] === undefined ? null : <span className="n">{counts[s]}</span>}
        </button>
      ))}
    </span>
  );
}

/**
 * A picker to set another `origin` branch as a live Session's base, kept
 * with the branch.
 */
function DiffBase({ session, base, onChanged }: { session: Session; base: string; onChanged: () => void }) {
  const api = useApi();
  const [bases, setBases] = useState<LoadedList<PickerOption<string>[]>>();
  const [error, setError] = useState<string>();
  const load = () => {
    api.invoke('sessions.diffBases', { id: session.id }).then(
      (found) => setBases({ value: found.map((b) => ({ key: b, label: b, value: b })) }),
      (e: unknown) => setBases({ error: (e as Error).message }),
    );
  };
  const choose = async (chosen: string) => {
    setError(undefined);
    try {
      await api.invoke('sessions.setDiffBase', { id: session.id, base: chosen });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <span className="diff-base">
      <span className="muted">vs</span>
      <SearchPicker
        label="Compared with"
        placeholder={base}
        icon={<GitBranch className="sm" />}
        noun="branches"
        loading="Listing origin's branches…"
        options={bases}
        selected={{ key: base, label: base }}
        onOpen={load}
        onChange={(chosen) => void choose(chosen)}
      />
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** What the diff is against and why, in a tooltip; for uncommitted changes, it says the last commit. */
function Compared({ base, source, scope }: { base: string; source?: DiffBaseSource; scope: DiffScope }) {
  const tip = comparedText(base, source, scope);
  return (
    <span className="compared muted" role="note" tabIndex={0} title={tip} aria-label={tip}>
      {scope === 'uncommitted' ? (
        <>
          vs <b className="tech">last commit</b>
        </>
      ) : null}
      <CircleHelp className="sm" aria-hidden="true" />
    </span>
  );
}

/** The tooltip on what the diff is against: what the scope compares, then where its base came from. */
export function comparedText(base: string, source: DiffBaseSource | undefined, scope: DiffScope): string {
  if (scope === 'uncommitted') return 'Compared with HEAD, the last commit: the edits not committed yet, and the new files.';
  const what =
    scope === 'committed'
      ? `Compared with ${base}: the commits since this branch left it, without the edits not committed yet.`
      : `Compared with ${base}: the commits since this branch left it, plus the edits not committed yet. This is what its Merge request shows, and more.`;
  const why: Record<DiffBaseSource, string> = {
    recorded: 'This base is kept with the branch: Loom made the branch from it, or it was picked here.',
    'created-from': "The branch's git history says it was created from it.",
    default: "It's origin's default branch: where this branch started isn't known, so pick its base if it isn't this one.",
    local: `It's your local ${base}, which may be behind origin's: there's no origin branch to compare with here.`,
  };
  return source ? `${what} ${why[source]}` : what;
}

/** The Wrap long lines and Side by side toggles of a diff's toolbar. */
export function DiffViewToggles({ view, onChange }: { view: DiffViewSettings; onChange: (change: Partial<DiffViewSettings>) => void }) {
  return (
    <>
      <StateToggle label="Wrap long lines" pressed={view.wrap} onIcon={WrapText} offIcon={ArrowRightToLine} onToggle={() => onChange({ wrap: !view.wrap })} />
      <StateToggle label="Side by side" pressed={view.sideBySide} onIcon={Columns2} offIcon={Rows2} onToggle={() => onChange({ sideBySide: !view.sideBySide })} />
    </>
  );
}

/**
 * A diff's files: a file tree to filter and jump from (above the diffs, or
 * beside them when `wide`), and each file's diff, read with `read` as it is
 * expanded or scrolled to, and read again when `version` changes. Its lines
 * can be commented on while `comments` is given; each file opens in the
 * editor while `onOpenInEditor` is.
 */
export function DiffFiles(props: {
  files: DiffFile[];
  read: (file: DiffFile) => Promise<FileDiff>;
  version: string;
  comments: DiffComments | undefined;
  onOpenInEditor?: (file: DiffFile) => void;
  wide: boolean;
  patterns: string[];
  theme: Theme;
  view: DiffViewSettings;
  onViewChange: (change: Partial<DiffViewSettings>) => void;
}) {
  const { files, patterns, view, wide, onViewChange } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (file: DiffFile) => expanded[file.path] ?? !startsCollapsed(file, patterns);
  const toggle = (file: DiffFile, open = !isExpanded(file)) => setExpanded((e) => ({ ...e, [file.path]: open }));
  // Each diff on the page has its own ids: Changes and a Merge request's may show at once.
  const ids = useId();
  const show = (file: DiffFile) => {
    toggle(file, true);
    document.getElementById(fileId(ids, file.path))?.scrollIntoView?.({ block: 'start' });
  };
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matching = useMemo(() => files.filter((file) => file.path.toLowerCase().includes(needle)), [files, needle]);
  const shown = useMemo(() => new Set(matching), [matching]);
  // A wide Panel always has the tree beside the diffs; a narrow one stacks it above them, open or not.
  const treeOpen = wide || view.fileList;
  const listId = useId();
  return (
    <div className={wide ? 'ch-body wide' : 'ch-body'}>
      <div className="ch-tree">
        {wide ? null : (
          <button type="button" className="tree-head" aria-expanded={treeOpen} aria-controls={listId} onClick={() => onViewChange({ fileList: !view.fileList })}>
            {treeOpen ? <ChevronDown className="sm" /> : <ChevronRight className="sm" />}
            <ListTree className="sm" />
            <span>{needle ? `${matching.length} of ${files.length} files` : `${files.length} ${files.length === 1 ? 'file' : 'files'}`}</span>
            <span className="grow" />
            <Counts lines={totals(matching)} />
          </button>
        )}
        {treeOpen ? (
          <div className="tree-list" id={listId}>
            <input
              className="diff-search"
              type="search"
              aria-label="Filter changed files"
              placeholder="Filter files…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Esc clears the filter first; on an empty one it is left to close the drawer it's in.
                if (event.key !== 'Escape' || !query) return;
                event.preventDefault();
                setQuery('');
              }}
            />
            {/* With no match, the diffs beside it say so. */}
            {matching.length === 0 ? null : <FileTree files={matching} searching={needle !== ''} onPick={show} />}
          </div>
        ) : null}
      </div>
      <div className="diff-sections">
        {matching.length === 0 ? <div className="diff-note">No changed file matches “{query.trim()}”.</div> : null}
        {/* Filtered out rather than removed, so a diff needn't load again when it comes back. */}
        {files.map((file) => (
          <FileSection key={file.path} {...props} id={fileId(ids, file.path)} file={file} hidden={!shown.has(file)} expanded={isExpanded(file)} onToggle={() => toggle(file)} />
        ))}
      </div>
    </div>
  );
}

/** The files' changed lines, added up. */
function totals(files: DiffFile[]): ChangedLines {
  return { added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
}

/** An on/off icon button: it shows the current state's icon and, on hover, the icon of the state a click gives. */
function StateToggle({ label, pressed, onIcon: On, offIcon: Off, onToggle }: { label: string; pressed: boolean; onIcon: LucideIcon; offIcon: LucideIcon; onToggle: () => void }) {
  const [Current, Next] = pressed ? [On, Off] : [Off, On];
  return (
    <button className="icon-btn sm state-toggle" type="button" title={label} aria-label={label} aria-pressed={pressed} onClick={onToggle}>
      <Current className="at-rest" />
      <Next className="on-hover" />
    </button>
  );
}

type TreeNode = { name: string; path: string; file?: DiffFile; children: TreeNode[] };

function buildTree(files: DiffFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/');
      if (index === parts.length - 1) return void node.children.push({ name, path, file, children: [] });
      let folder = node.children.find((c) => !c.file && c.name === name);
      if (!folder) node.children.push((folder = { name, path, children: [] }));
      node = folder;
    });
  }
  return root.children;
}

function FileTree({ files, searching, onPick }: { files: DiffFile[]; searching: boolean; onPick: (file: DiffFile) => void }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // A search shows every match, so no folder is closed during one.
  const isClosed = (path: string) => !searching && closed.has(path);
  const render = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) =>
      node.file ? (
        <li key={node.path}>
          <button type="button" className="diff-tree-row" style={{ paddingLeft: 10 + depth * 14 }} title={`${node.file.path} · ${statusLabel(node.file)}`} onClick={() => onPick(node.file!)} {...copyable('path', node.file.path)}>
            <StatusBadge file={node.file} />
            <span className="name">{node.name}</span>
            <Counts lines={node.file} />
          </button>
        </li>
      ) : (
        <li key={node.path}>
          <button
            type="button"
            className="diff-tree-row folder"
            style={{ paddingLeft: 10 + depth * 14 }}
            aria-expanded={!isClosed(node.path)}
            disabled={searching}
            onClick={() =>
              setClosed((c) => {
                const next = new Set(c);
                if (!next.delete(node.path)) next.add(node.path);
                return next;
              })
            }
          >
            {isClosed(node.path) ? <ChevronRight /> : <ChevronDown />}
            <Folder />
            <span className="name">{node.name}</span>
          </button>
          {isClosed(node.path) ? null : <ul>{render(node.children, depth + 1)}</ul>}
        </li>
      ),
    );
  return (
    <nav className="diff-tree" aria-label="Changed files">
      <ul>{render(tree, 0)}</ul>
    </nav>
  );
}

/** What a file's badge says: deleted or renamed when it is, else where its change is. */
function statusLabel(file: DiffFile): string {
  return file.change ?? STATUS_LABEL[file.status];
}

function StatusBadge({ file }: { file: DiffFile }) {
  return <span className={`diff-status ${file.change ?? file.status}`}>{statusLabel(file)}</span>;
}

/** Lines added and removed, by one file or several; a binary or uncounted file has none to give. */
type ChangedLines = Pick<DiffFile, 'added' | 'removed'> & Partial<Pick<DiffFile, 'binary' | 'uncounted'>>;

function Counts({ lines }: { lines: ChangedLines }) {
  if (lines.binary) return <span className="diff-counts">binary</span>;
  if (lines.uncounted) return <span className="diff-counts">not counted</span>;
  return (
    <span className="diff-counts">
      <span className="add">+{lines.added}</span> <span className="del">−{lines.removed}</span>
    </span>
  );
}

type FileText = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | ({ state: 'done' } & FileDiff);

function FileSection({
  id,
  file,
  hidden,
  read,
  onOpenInEditor,
  comments,
  expanded,
  onToggle,
  view,
  theme,
  version,
}: {
  id: string;
  file: DiffFile;
  hidden: boolean;
  read: (file: DiffFile) => Promise<FileDiff>;
  onOpenInEditor?: (file: DiffFile) => void;
  /** Absent when the diff can't be commented on. */
  comments: DiffComments | undefined;
  expanded: boolean;
  onToggle: () => void;
  view: DiffViewSettings;
  theme: Theme;
  version: string;
}) {
  // The latest `read`, so that a new one doesn't read the diff again: `version` says when to.
  const reading = useRef(read);
  reading.current = read;
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [text, setText] = useState<FileText>({ state: 'idle' });
  useEffect(() => {
    if (visible || !ref.current) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '400px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!expanded || !visible || file.binary || file.uncounted) return;
    let current = true;
    // A diff shown stays until the new one comes: a comment being written on it isn't lost meanwhile.
    setText((t) => (t.state === 'done' ? t : { state: 'loading' }));
    reading.current(file).then(
      (diff) => current && setText({ state: 'done', ...diff }),
      (error: unknown) => current && setText({ state: 'error', message: (error as Error).message }),
    );
    return () => {
      current = false;
    };
    // `file` is compared by what identifies its diff.
  }, [file.path, file.oldPath, file.status, file.added, file.removed, file.change, expanded, visible, version]);

  const commenting = useCommenting(file.path, text.state === 'done' ? text.text : undefined, comments);

  return (
    <section className="diff-file" id={id} ref={ref} aria-label={file.path} hidden={hidden}>
      <h4>
        <button type="button" className="diff-file-toggle" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? <ChevronDown /> : <ChevronRight />}
          <span className="name" {...copyable('path', file.path)}>
            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
        </button>
        <StatusBadge file={file} />
        <Counts lines={file} />
        {onOpenInEditor && (
          <button className="icon-btn sm" type="button" title="Open in editor" aria-label={`Open ${file.path} in the editor`} onClick={() => onOpenInEditor(file)}>
            <SquarePen />
          </button>
        )}
      </h4>
      {!expanded ? null : file.binary ? (
        <div className="diff-note">Binary file</div>
      ) : text.state === 'error' ? (
        <div className="diff-note" role="alert">
          {text.message}
        </div>
      ) : text.state === 'done' ? (
        <>
          {hasHunks(text.text) ? <FileDiffView patch={text.text} theme={theme} view={view} commenting={commenting} /> : null}
          {text.truncated ? <div className="diff-note">This diff is too large to show in full.</div> : null}
          {!text.truncated && !hasHunks(text.text) ? <div className="diff-note">No changes to its content.</div> : null}
        </>
      ) : (
        <div className="diff-note">Loading…</div>
      )}
    </section>
  );
}

/**
 * Commenting on the file at `path`, whose diff is `patch`, while it can be:
 * the comment being written and its form, and the comments added, as notes
 * under their last line while the diff still holds the lines they quote. A
 * diff loaded again keeps the comment being written while it still holds the
 * same lines there.
 */
function useCommenting(path: string, patch: string | undefined, comments: DiffComments | undefined): Commenting | undefined {
  /** The comment being written: what its range quotes, and its range as picked. */
  const [draft, setDraft] = useState<{ quote: Quote; range: LineRange }>();
  useEffect(() => {
    setDraft((was) => {
      if (!was || patch === undefined) return undefined;
      const quote = quoteRange(path, patch, was.range);
      return quote && sameLines(quote, was.quote) ? { quote, range: was.range } : undefined;
    });
  }, [patch]);
  if (!comments || patch === undefined) return undefined;
  const notes = comments.pending.flatMap(({ index, comment, range }) => {
    if (comment.path !== path) return [];
    const quote = quoteRange(path, patch, range);
    return quote && sameLines(quote, comment) ? [{ key: String(index), at: quote.last, note: <CommentNote comment={comment} onRemove={() => comments.remove(index)} /> }] : [];
  });
  const onStartComment = (range: LineRange) => {
    const quote = quoteRange(path, patch, range);
    if (quote) setDraft({ quote, range });
  };
  if (!draft) return { onStartComment, notes };
  const add = (note: string) => {
    const { last: _, ...quoted } = draft.quote;
    comments.add({ ...quoted, note }, draft.range);
    setDraft(undefined);
  };
  return {
    onStartComment,
    notes,
    draft: {
      range: draft.range,
      at: draft.quote.last,
      form: <CommentForm key={diffCommentRange(draft.quote)} quote={draft.quote} onAdd={add} onCancel={() => setDraft(undefined)} />,
    },
  };
}

/** Whether two quotes of a diff hold the same lines. */
function sameLines(a: Pick<DiffComment, 'lines'>, b: Pick<DiffComment, 'lines'>): boolean {
  return a.lines.join('\n') === b.lines.join('\n');
}

/** A comment added, under its last line until it is sent: its note, and a way to remove it. */
function CommentNote({ comment, onRemove }: { comment: DiffComment; onRemove: () => void }) {
  const range = diffCommentRange(comment);
  return (
    <div className="diff-comment note" role="note" aria-label={`Your comment on ${range}`}>
      <div className="row">
        <MessageSquareCode className="sm" />
        <b>Your comment</b>
        <span className="muted ellipsis grow">goes with your next message</span>
        <button className="icon-btn xs" type="button" title="Remove" aria-label={`Remove comment on ${range}`} onClick={onRemove}>
          <X />
        </button>
      </div>
      <div className="note-text">{comment.note}</div>
    </div>
  );
}

/**
 * The note on a line or range of a diff, under its last line: added as a
 * chip in the composer. The focus goes into it as it opens: once the diff
 * has drawn it, which may be a frame or two after it is made.
 */
function CommentForm({ quote, onAdd, onCancel }: { quote: Quote; onAdd: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const range = diffCommentRange(quote);
  const field = useRef<HTMLTextAreaElement>(null);
  useFocusOnceShown(field);
  const add = () => note.trim() && onAdd(note.trim());
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      add();
    }
  };
  return (
    <div className="diff-comment" role="group" aria-label={`Comment on ${range}`}>
      <textarea ref={field} aria-label={`Comment on ${range}`} rows={3} placeholder="Note for the agent…" value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={onKeyDown} />
      <div className="row">
        <span className="tech muted ellipsis grow">{range}</span>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" type="button" disabled={!note.trim()} onClick={add}>
          Add comment
        </button>
      </div>
    </div>
  );
}

/** How many frames a field waits to be shown before it gives up on taking the focus. */
const FOCUS_FRAMES = 10;

/**
 * Puts the focus in `field` as it mounts. The diff library shows what it is
 * given only once it has made a place for it in its shadow DOM, after React
 * mounts it: until then the field can't take the focus, so it is tried again
 * each frame until it does.
 */
function useFocusOnceShown(field: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const el = field.current;
      if (!el) return;
      el.focus();
      if (document.activeElement !== el && ++tries < FOCUS_FRAMES) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [field]);
}

/** Whether a patch changes any lines: one that only renames a file or changes its mode doesn't. */
function hasHunks(patch: string): boolean {
  return patch.startsWith('@@') || patch.includes('\n@@');
}

function fileId(ids: string, path: string): string {
  return `diff-file-${ids.replace(/:/g, '')}-${encodeURIComponent(path)}`;
}

/** Whether a file starts collapsed: a binary, a large change, or one the patterns name. */
export function startsCollapsed(file: DiffFile, patterns: string[]): boolean {
  if (file.binary || file.added + file.removed > LARGE_FILE_LINES) return true;
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  return patterns.some((pattern) => globToRegExp(pattern).test(pattern.includes('/') ? file.path : name));
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .trim()
    .split(/(\*\*|\*|\?)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

/**
 * The Changes view's layout: the settings', or what the user changed it to
 * until settings hold the same. A change settings refuse is undone, unless a
 * later one has replaced it.
 */
export function useDiffView(stored: DiffViewSettings | undefined): [DiffViewSettings, (change: Partial<DiffViewSettings>) => void] {
  const api = useApi();
  const [local, setLocal] = useState<DiffViewSettings>();
  useEffect(() => {
    if (stored) setLocal((pending) => (pending && sameDiffView(pending, stored) ? undefined : pending));
  }, [stored]);
  const current = local ?? stored ?? DEFAULT_DIFF_VIEW;
  const change = (part: Partial<DiffViewSettings>) => {
    const next = { ...current, ...part };
    setLocal(next);
    api.invoke('settings.setDiffView', next).catch((error: unknown) => {
      console.error("could not keep the Changes view's layout:", error);
      setLocal((pending) => (pending && sameDiffView(pending, next) ? undefined : pending));
    });
  };
  return [current, change];
}

function sameDiffView(a: DiffViewSettings, b: DiffViewSettings): boolean {
  return a.fileList === b.fileList && a.wrap === b.wrap && a.sideBySide === b.sideBySide;
}

/**
 * Whether the element is at least `px` wide, as it is resized; false until
 * measured.
 */
export function useWide(ref: RefObject<HTMLElement | null>, px: number): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWide(el.clientWidth >= px);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, px]);
  return wide;
}

/**
 * A counter that moves each time the Session's working copy changes, by the
 * agent or anyone else: its fingerprint, asked every WATCH_INTERVAL_MS while
 * the window is visible, differs from the one before.
 */
function useWorkingCopyChanges(id: number, live: boolean): number {
  const api = useApi();
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (!live) return;
    let last: string | undefined;
    let asking = false;
    let stopped = false;
    const check = () => {
      if (asking || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      asking = true;
      api.invoke('sessions.diffFingerprint', { id }).then(
        (fingerprint) => {
          asking = false;
          if (stopped) return;
          if (last !== undefined && fingerprint !== last) setChanges((n) => n + 1);
          last = fingerprint;
        },
        () => {
          asking = false;
        },
      );
    };
    check();
    const timer = setInterval(check, WATCH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, id, live]);
  return changes;
}

/** How many times the Session has left `working`: a counter that moves once per turn end. */
function useTurnsEnded(status: Session['status']): number {
  const [ended, setEnded] = useState(0);
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current === 'working' && status !== 'working') setEnded((n) => n + 1);
    previous.current = status;
  }, [status]);
  return ended;
}
