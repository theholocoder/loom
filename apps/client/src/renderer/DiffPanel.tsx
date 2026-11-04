// The diff panel: what the open Session's branch changed, as a file tree and
// unified per-file diffs loaded as they are expanded or scrolled to.
import { ChevronDown, ChevronRight, FileDiff as FileDiffIcon, Folder, GitBranch, PanelRightClose, RefreshCw, SquarePen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, DiffSummary, FileDiff, Session } from '../shared/api';
import { useApi, useTopic } from './api';
import { SearchPicker, type Loaded as LoadedList, type PickerOption } from './SearchPicker';

/** Files with more changed lines than this start collapsed. */
export const LARGE_FILE_LINES = 1000;

const STATUS_LABEL: Record<DiffFile['status'], string> = { committed: 'committed', modified: 'modified', untracked: 'untracked' };

/**
 * The open diff panel; nothing at all when closed (the Session header's
 * DiffToggle, the palette or `d` opens it). `onToggle` closes it.
 */
export function DiffPanel({ session, open, onToggle }: { session?: Session; open: boolean; onToggle: () => void }) {
  if (!open) return null;
  return (
    <section className="diff" id="diff-panel" aria-label="Changes">
      {session ? (
        <SessionDiff key={session.id} session={session} onClose={onToggle} />
      ) : (
        <>
          <DiffHeader onClose={onToggle} />
          <div className="scroll">
            <div className="empty">No Session selected.</div>
          </div>
        </>
      )}
    </section>
  );
}

function DiffHeader({ onClose, children }: { onClose: () => void; children?: React.ReactNode }) {
  return (
    <header>
      <FileDiffIcon />
      <b>Changes</b>
      <span className="grow" />
      {children}
      <button className="icon-btn sm" type="button" title="Close" aria-label="Hide changes" aria-controls="diff-panel" aria-expanded onClick={onClose}>
        <PanelRightClose />
      </button>
    </header>
  );
}

type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; summary: DiffSummary };

function SessionDiff({ session, onClose }: { session: Session; onClose: () => void }) {
  const api = useApi();
  const patterns = useTopic('settings')?.diffCollapsedPatterns;
  const [uncommittedOnly, setUncommittedOnly] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  // A turn ending refreshes it; so do opening it again and the refresh button.
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
      <DiffHeader onClose={onClose}>
        {summary?.available && !summary.readOnly ? (
          <button className="diff-toggle" type="button" aria-pressed={uncommittedOnly} onClick={() => setUncommittedOnly((u) => !u)}>
            <span className="knob" aria-hidden />
            Uncommitted only
          </button>
        ) : null}
        <button className="icon-btn sm" type="button" title="Refresh" aria-label="Refresh changes" onClick={() => setRefreshes((r) => r + 1)}>
          <RefreshCw />
        </button>
      </DiffHeader>
      <div className="scroll">
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
            key={`${uncommittedOnly}`}
            session={session}
            files={loaded.summary.files}
            readOnly={readOnly}
            uncommittedOnly={uncommittedOnly}
            patterns={patterns ?? []}
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

function DiffFiles(props: { session: Session; files: DiffFile[]; readOnly: boolean; uncommittedOnly: boolean; patterns: string[]; version: string }) {
  const { files, patterns } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (file: DiffFile) => expanded[file.path] ?? !startsCollapsed(file, patterns);
  const toggle = (file: DiffFile, open = !isExpanded(file)) => setExpanded((e) => ({ ...e, [file.path]: open }));
  const show = (file: DiffFile) => {
    toggle(file, true);
    document.getElementById(fileId(file.path))?.scrollIntoView?.({ block: 'start' });
  };
  return (
    <>
      <FileTree files={files} onPick={show} />
      {files.map((file) => (
        <FileSection key={file.path} {...props} file={file} expanded={isExpanded(file)} onToggle={() => toggle(file)} />
      ))}
    </>
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

function FileTree({ files, onPick }: { files: DiffFile[]; onPick: (file: DiffFile) => void }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const render = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) =>
      node.file ? (
        <li key={node.path}>
          <button type="button" className="diff-tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onPick(node.file!)}>
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
            aria-expanded={!closed.has(node.path)}
            onClick={() =>
              setClosed((c) => {
                const next = new Set(c);
                if (!next.delete(node.path)) next.add(node.path);
                return next;
              })
            }
          >
            {closed.has(node.path) ? <ChevronRight /> : <ChevronDown />}
            <Folder />
            <span className="name">{node.name}</span>
          </button>
          {closed.has(node.path) ? null : <ul>{render(node.children, depth + 1)}</ul>}
        </li>
      ),
    );
  return (
    <nav className="diff-tree" aria-label="Changed files">
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
  readOnly,
  uncommittedOnly,
  expanded,
  onToggle,
  version,
}: {
  session: Session;
  file: DiffFile;
  readOnly: boolean;
  uncommittedOnly: boolean;
  expanded: boolean;
  onToggle: () => void;
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
    setText({ state: 'loading' });
    api.invoke('sessions.diffFile', { id: session.id, path: file.path, uncommittedOnly }).then(
      (diff) => current && setText({ state: 'done', ...diff }),
      (error: unknown) => current && setText({ state: 'error', message: (error as Error).message }),
    );
    return () => {
      current = false;
    };
    // `file` is compared by what identifies its diff.
  }, [api, session.id, file.path, file.oldPath, file.status, file.added, file.removed, uncommittedOnly, expanded, visible, version]);

  const openInEditor = () => void api.invoke('sessions.openInEditor', { id: session.id, file: file.path }).catch((error: unknown) => console.error(error));
  return (
    <section className="diff-file" id={fileId(file.path)} ref={ref} aria-label={file.path}>
      <h4>
        <button type="button" className="diff-file-toggle" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? <ChevronDown /> : <ChevronRight />}
          <span className="name">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
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
          {parseUnified(text.text).map((line, index) => (
            <div key={index} className={`diff-line ${line.kind}`}>
              {line.text || ' '}
            </div>
          ))}
          {text.truncated ? <div className="diff-note">This diff is too large to show in full.</div> : null}
          {!text.truncated && !text.text.includes('\n@@') && !text.text.startsWith('@@') ? <div className="diff-note">No changes to its content.</div> : null}
        </>
      ) : (
        <div className="diff-note">Loading…</div>
      )}
    </section>
  );
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

/** The lines of a unified diff from its first hunk on, as added, removed, context or hunk header. */
export function parseUnified(text: string): { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string }[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const start = lines.findIndex((line) => line.startsWith('@@'));
  if (start < 0) return [];
  return lines.slice(start).map((line) => {
    if (line.startsWith('@@')) return { kind: 'hunk', text: line };
    if (line.startsWith('+')) return { kind: 'add', text: line };
    if (line.startsWith('-')) return { kind: 'del', text: line };
    return { kind: 'ctx', text: line };
  });
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
