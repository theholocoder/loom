// The sidebar's Changes view: what the open Session's branch changed, as a
// file tree and unified per-file diffs loaded as they are expanded or
// scrolled to, each line or range of which can be commented on.
import { ArrowRightToLine, ChevronDown, ChevronRight, Columns2, Folder, GitBranch, PanelLeft, RefreshCw, Rows2, SquarePen, WrapText, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DEFAULT_DIFF_VIEW, DEFAULT_SETTINGS, diffCommentRange, type DiffComment, type DiffFile, type DiffSummary, type DiffViewSettings, type FileDiff, type Session } from '../shared/api';
import type { Theme } from '../shared/appearance';
import { useApi, useTopic } from './api';
import { quoteRange, type LineRange, type Quote } from './diff-comments';
import { FileDiffView, type Commenting } from './FileDiffView';
import { SearchPicker, type Loaded as LoadedList, type PickerOption } from './SearchPicker';
import { copyable } from './ContextMenu';

/** Files with more changed lines than this start collapsed. */
export const LARGE_FILE_LINES = 1000;

const STATUS_LABEL: Record<DiffFile['status'], string> = { committed: 'committed', modified: 'modified', untracked: 'untracked' };

/**
 * The Session's changes, worked out when the view is shown: on first show,
 * on each show after, at each turn end while shown, and on Refresh.
 */
export function ChangesView({ session, onComment }: { session: Session; onComment?: (comment: DiffComment) => void }) {
  return <SessionDiff key={session.id} session={session} onComment={onComment} />;
}

type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; summary: DiffSummary };

function SessionDiff({ session, onComment }: { session: Session; onComment?: (comment: DiffComment) => void }) {
  const api = useApi();
  const settings = useTopic('settings');
  const [view, changeView] = useDiffView(settings?.diffView);
  const [uncommittedOnly, setUncommittedOnly] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  // A turn ending refreshes it; so do showing it again and the refresh button.
  const turnEnded = useTurnsEnded(session.status);
  useEffect(() => {
    let current = true;
    setLoaded((l) => (l.state === 'done' ? l : { state: 'loading' }));
    api.invoke('sessions.diff', { id: session.id, uncommittedOnly }).then(
      (summary) => current && setLoaded({ state: 'done', summary }),
      (error: unknown) => current && setLoaded({ state: 'error', message: (error as Error).message }),
    );
    return () => {
      current = false;
    };
  }, [api, session.id, uncommittedOnly, refreshes, turnEnded]);

  const summary = loaded.state === 'done' ? loaded.summary : undefined;
  const readOnly = !summary?.available || summary.readOnly;
  return (
    <>
      <div className="changes-bar">
        <span className="grow" />
        {summary?.available && !summary.readOnly ? (
          <button className="diff-toggle" type="button" aria-pressed={uncommittedOnly} onClick={() => setUncommittedOnly((u) => !u)}>
            <span className="knob" aria-hidden />
            Uncommitted only
          </button>
        ) : null}
        <button className="icon-btn sm" type="button" title="Refresh" aria-label="Refresh changes" onClick={() => setRefreshes((r) => r + 1)}>
          <RefreshCw />
        </button>
      </div>
      <div className={summary?.available && summary.files.length > 0 ? 'scroll diff-panes' : 'scroll'}>
        {summary?.available && !summary.readOnly && !uncommittedOnly && summary.baseSource && <DiffBase session={session} summary={summary} onChanged={() => setRefreshes((r) => r + 1)} />}
        {loaded.state === 'loading' ? (
          <div className="diff-loading" role="status">
            Working out the changes…
          </div>
        ) : loaded.state === 'error' ? (
          <div className="empty" role="alert">
            {loaded.message}
          </div>
        ) : !loaded.summary.available ? (
          <div className="empty">{loaded.summary.reason}</div>
        ) : loaded.summary.files.length === 0 ? (
          <div className="empty">No changes against {loaded.summary.base}.</div>
        ) : (
          <DiffFiles
            session={session}
            files={loaded.summary.files}
            readOnly={readOnly}
            onComment={readOnly ? undefined : onComment}
            uncommittedOnly={uncommittedOnly}
            patterns={settings?.diffCollapsedPatterns ?? []}
            theme={settings?.theme ?? DEFAULT_SETTINGS.theme}
            view={view}
            onViewChange={changeView}
            version={`${refreshes}:${turnEnded}`}
          />
        )}
      </div>
    </>
  );
}

/**
 * What a live Session's diff is against, and a picker to set another
 * `origin` branch as its base, kept with the branch. Says when the base is
 * only `origin`'s default, a guess.
 */
function DiffBase({ session, summary, onChanged }: { session: Session; summary: Extract<DiffSummary, { available: true }>; onChanged: () => void }) {
  const api = useApi();
  const [bases, setBases] = useState<LoadedList<PickerOption<string>[]>>();
  const [error, setError] = useState<string>();
  const load = () => {
    api.invoke('sessions.diffBases', { id: session.id }).then(
      (found) => setBases({ value: found.map((base) => ({ key: base, label: base, value: base })) }),
      (e: unknown) => setBases({ error: (e as Error).message }),
    );
  };
  const choose = async (base: string) => {
    setError(undefined);
    try {
      await api.invoke('sessions.setDiffBase', { id: session.id, base });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="diff-base">
      <span className="muted">Compared with</span>
      <SearchPicker
        label="Compared with"
        placeholder={summary.base}
        icon={<GitBranch className="sm" />}
        noun="branches"
        loading="Listing origin's branches…"
        options={bases}
        selected={{ key: summary.base, label: summary.base }}
        onOpen={load}
        onChange={(base) => void choose(base)}
      />
      {summary.baseSource === 'default' && <span className="muted">origin's default branch: where this branch started isn't known, so pick its base if it isn't this one.</span>}
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function DiffFiles(props: {
  session: Session;
  files: DiffFile[];
  readOnly: boolean;
  onComment: ((comment: DiffComment) => void) | undefined;
  uncommittedOnly: boolean;
  patterns: string[];
  theme: Theme;
  view: DiffViewSettings;
  onViewChange: (change: Partial<DiffViewSettings>) => void;
  version: string;
}) {
  const { files, patterns, view, onViewChange } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (file: DiffFile) => expanded[file.path] ?? !startsCollapsed(file, patterns);
  const toggle = (file: DiffFile, open = !isExpanded(file)) => setExpanded((e) => ({ ...e, [file.path]: open }));
  const show = (file: DiffFile) => {
    toggle(file, true);
    document.getElementById(fileId(file.path))?.scrollIntoView?.({ block: 'start' });
  };
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matching = useMemo(() => files.filter((file) => file.path.toLowerCase().includes(needle)), [files, needle]);
  const shown = useMemo(() => new Set(matching), [matching]);
  return (
    <div className="diff-files">
      <div className="diff-files-bar">
        <input
          className="diff-search"
          type="search"
          aria-label="Filter changed files"
          placeholder="Filter files…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
        />
        <button className="icon-btn sm" type="button" title="File list" aria-label="File list" aria-pressed={view.fileList} onClick={() => onViewChange({ fileList: !view.fileList })}>
          <PanelLeft />
        </button>
        <StateToggle label="Wrap long lines" pressed={view.wrap} onIcon={WrapText} offIcon={ArrowRightToLine} onToggle={() => onViewChange({ wrap: !view.wrap })} />
        <StateToggle label="Side by side" pressed={view.sideBySide} onIcon={Columns2} offIcon={Rows2} onToggle={() => onViewChange({ sideBySide: !view.sideBySide })} />
      </div>
      <div className="diff-files-body">
        <FileTree files={matching} searching={needle !== ''} hidden={!view.fileList || matching.length === 0} onPick={show} />
        <div className="diff-sections">
          {matching.length === 0 ? <div className="diff-note">No changed file matches “{query.trim()}”.</div> : null}
          {/* Filtered out rather than removed, so a diff needn't load again when it comes back. */}
          {files.map((file) => (
            <FileSection key={file.path} {...props} file={file} hidden={!shown.has(file)} expanded={isExpanded(file)} onToggle={() => toggle(file)} />
          ))}
        </div>
      </div>
    </div>
  );
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

function FileTree({ files, searching, hidden, onPick }: { files: DiffFile[]; searching: boolean; hidden: boolean; onPick: (file: DiffFile) => void }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // A search shows every match, so no folder is closed during one.
  const isClosed = (path: string) => !searching && closed.has(path);
  const render = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) =>
      node.file ? (
        <li key={node.path}>
          <button type="button" className="diff-tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onPick(node.file!)} {...copyable('path', node.file.path)}>
            <span className="name">{node.name}</span>
            <StatusBadge file={node.file} />
            <Counts file={node.file} />
          </button>
        </li>
      ) : (
        <li key={node.path}>
          <button
            type="button"
            className="diff-tree-row folder"
            style={{ paddingLeft: 8 + depth * 14 }}
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
    <nav className="diff-tree" aria-label="Changed files" hidden={hidden}>
      <ul>{render(tree, 0)}</ul>
    </nav>
  );
}

function StatusBadge({ file }: { file: DiffFile }) {
  return <span className={`diff-status ${file.status}`}>{STATUS_LABEL[file.status]}</span>;
}

function Counts({ file }: { file: DiffFile }) {
  if (file.binary) return <span className="diff-counts">binary</span>;
  if (file.uncounted) return <span className="diff-counts">not counted</span>;
  return (
    <span className="diff-counts">
      <span className="add">+{file.added}</span> <span className="del">−{file.removed}</span>
    </span>
  );
}

type FileText = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | ({ state: 'done' } & FileDiff);

function FileSection({
  session,
  file,
  hidden,
  readOnly,
  onComment,
  uncommittedOnly,
  expanded,
  onToggle,
  view,
  theme,
  version,
}: {
  session: Session;
  file: DiffFile;
  hidden: boolean;
  readOnly: boolean;
  /** Absent when the diff can't be commented on. */
  onComment: ((comment: DiffComment) => void) | undefined;
  uncommittedOnly: boolean;
  expanded: boolean;
  onToggle: () => void;
  view: DiffViewSettings;
  theme: Theme;
  version: string;
}) {
  const api = useApi();
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
    api.invoke('sessions.diffFile', { id: session.id, path: file.path, uncommittedOnly }).then(
      (diff) => current && setText({ state: 'done', ...diff }),
      (error: unknown) => current && setText({ state: 'error', message: (error as Error).message }),
    );
    return () => {
      current = false;
    };
    // `file` is compared by what identifies its diff.
  }, [api, session.id, file.path, file.oldPath, file.status, file.added, file.removed, uncommittedOnly, expanded, visible, version]);

  const commenting = useCommenting(file.path, text.state === 'done' ? text.text : undefined, onComment);

  const openInEditor = () => void api.invoke('sessions.openInEditor', { id: session.id, file: file.path }).catch((error: unknown) => console.error(error));
  return (
    <section className="diff-file" id={fileId(file.path)} ref={ref} aria-label={file.path} hidden={hidden}>
      <h4>
        <button type="button" className="diff-file-toggle" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? <ChevronDown /> : <ChevronRight />}
          <span className="name" {...copyable('path', file.path)}>
            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
        </button>
        <StatusBadge file={file} />
        <Counts file={file} />
        {readOnly ? null : (
          <button className="icon-btn sm" type="button" title="Open in editor" aria-label={`Open ${file.path} in the editor`} onClick={openInEditor}>
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
 * the comment being written, and its form. A diff loaded again keeps the
 * comment being written while it still holds the same lines there.
 */
function useCommenting(path: string, patch: string | undefined, onComment: ((comment: DiffComment) => void) | undefined): Commenting | undefined {
  /** The comment being written: what its range quotes, and its range as picked. */
  const [draft, setDraft] = useState<{ quote: Quote; range: LineRange }>();
  useEffect(() => {
    setDraft((was) => {
      if (!was || patch === undefined) return undefined;
      const quote = quoteRange(path, patch, was.range);
      return quote && quote.lines.join('\n') === was.quote.lines.join('\n') ? { quote, range: was.range } : undefined;
    });
  }, [patch]);
  if (!onComment || patch === undefined) return undefined;
  const onStartComment = (range: LineRange) => {
    const quote = quoteRange(path, patch, range);
    if (quote) setDraft({ quote, range });
  };
  if (!draft) return { onStartComment };
  const add = (note: string) => {
    const { last: _, ...quoted } = draft.quote;
    onComment({ ...quoted, note });
    setDraft(undefined);
  };
  return {
    onStartComment,
    draft: {
      range: draft.range,
      at: draft.quote.last,
      form: <CommentForm key={diffCommentRange(draft.quote)} quote={draft.quote} onAdd={add} onCancel={() => setDraft(undefined)} />,
    },
  };
}

/** The note on a line or range of a diff, under its last line: added as a chip in the composer. */
function CommentForm({ quote, onAdd, onCancel }: { quote: Quote; onAdd: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const range = diffCommentRange(quote);
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
      <textarea aria-label={`Comment on ${range}`} rows={3} placeholder="Note for the agent…" autoFocus value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={onKeyDown} />
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

/** Whether a patch changes any lines: one that only renames a file or changes its mode doesn't. */
function hasHunks(patch: string): boolean {
  return patch.startsWith('@@') || patch.includes('\n@@');
}

function fileId(path: string): string {
  return `diff-file-${encodeURIComponent(path)}`;
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
function useDiffView(stored: DiffViewSettings | undefined): [DiffViewSettings, (change: Partial<DiffViewSettings>) => void] {
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
