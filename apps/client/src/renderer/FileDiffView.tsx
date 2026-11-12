// One file's diff, drawn by @pierre/diffs. The only module that imports the
// library: everything else hands it a patch (or a file's texts before and
// after), the Loom theme and, to comment on it, what to do with a range the
// "+" was pressed for. Colours other than the code's own come from the Loom
// theme, through the library's CSS variables on `.file-diff` in styles.css.
// Notes go under their lines, whether the diff can be commented on or not.
import { MultiFileDiff, PatchDiff } from '@pierre/diffs/react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { DiffViewSettings } from '../shared/api';
import { THEMES, type Theme } from '../shared/appearance';
import type { LinePoint, LineRange, Side } from './diff-comments';

/** The Shiki theme that colours code in each Loom theme. */
const SHIKI_THEMES: Record<Theme, string> = {
  midnight: 'github-dark',
  paper: 'rose-pine-dawn',
  nord: 'nord',
  mocha: 'catppuccin-mocha',
  daylight: 'github-light',
};

/** Commenting on the diff: the "+" by each line, and what it was last pressed for. */
export interface Commenting {
  /** Starts a comment on the line, or the range dragged over or selected, the "+" was pressed for. */
  onStartComment: (range: LineRange) => void;
  /** The comment being written, if any: its range, kept selected, and its form, under its last line. */
  draft?: { range: LineRange; at: Required<LinePoint>; form: ReactNode };
}

/** A note under a line of the diff: a comment added and not sent yet, or a review thread. `key` tells them apart. */
export interface LineNote {
  key: string;
  at: Required<LinePoint>;
  note: ReactNode;
}

/** A note or form under a line of the diff; its `metadata` says which: a note's key, or DRAFT. */
type Annotation = { side: Side; lineNumber: number; metadata: string };
/** The `metadata` of the comment being written's form. */
const DRAFT = 'draft';

/** Draws a patch for one file. It must have a hunk: the library throws on text that holds no file diff. */
export function FileDiffView({
  patch,
  theme,
  view: { wrap, sideBySide },
  commenting,
  notes = [],
}: {
  patch: string;
  theme: Theme;
  view: Pick<DiffViewSettings, 'wrap' | 'sideBySide'>;
  /** Absent when the diff can't be commented on. */
  commenting?: Commenting;
  notes?: LineNote[];
}) {
  const commentable = commenting !== undefined;
  // The latest `onStartComment`, so that a new one doesn't make new options, which would draw the diff again.
  const onStartComment = useRef(commenting?.onStartComment);
  onStartComment.current = commenting?.onStartComment;
  /** The lines the user selected, kept here: the selection is controlled, so a comment's range can be shown selected. */
  const [selection, setSelection] = useState<LineRange | null>(null);
  const options = useMemo(
    () =>
      ({
        diffStyle: sideBySide ? 'split' : 'unified',
        overflow: wrap ? 'wrap' : 'scroll',
        lineDiffType: 'word',
        lineHoverHighlight: 'both',
        disableFileHeader: true,
        disableLineNumbers: false,
        theme: SHIKI_THEMES[theme],
        themeType: THEMES[theme].scheme,
        ...(commentable
          ? {
              enableGutterUtility: true,
              enableLineSelection: true,
              onLineSelected: setSelection,
              onGutterUtilityClick: (range: LineRange) => onStartComment.current?.(range),
            }
          : {}),
      }) as const,
    [theme, wrap, sideBySide, commentable],
  );
  const draft = commenting?.draft;
  // A comment added or dropped leaves nothing selected.
  const drafting = draft !== undefined;
  useEffect(() => {
    if (!drafting) setSelection(null);
  }, [drafting]);
  const wanted: Annotation[] = [
    ...notes.map(({ key, at }) => ({ side: at.side, lineNumber: at.lineNumber, metadata: key })),
    ...(draft ? [{ side: draft.at.side, lineNumber: draft.at.lineNumber, metadata: DRAFT }] : []),
  ];
  // The same list while it says the same, so that the library isn't handed a new one each render.
  const signature = JSON.stringify(wanted);
  const annotations = useMemo(() => wanted, [signature]);
  const render = ({ metadata }: Annotation) => (metadata === DRAFT ? draft?.form : notes.find((n) => n.key === metadata)?.note);
  return (
    <PatchDiff<string>
      className="file-diff"
      patch={patch}
      options={options}
      lineAnnotations={annotations}
      renderAnnotation={render}
      {...(commentable ? { selectedLines: draft?.range ?? selection } : {})}
    />
  );
}

/**
 * A file's change from its text before (empty for a new file) to its text
 * after, as an agent's edit reports it: unified, wrapped, not commented on.
 */
export function TextDiffView({ path, oldText, newText, theme }: { path: string; oldText: string; newText: string; theme: Theme }) {
  const options = useMemo(
    () =>
      ({
        diffStyle: 'unified',
        overflow: 'wrap',
        lineDiffType: 'word',
        disableFileHeader: true,
        theme: SHIKI_THEMES[theme],
        themeType: THEMES[theme].scheme,
      }) as const,
    [theme],
  );
  return <MultiFileDiff className="file-diff" oldFile={{ name: path, contents: oldText }} newFile={{ name: path, contents: newText }} options={options} />;
}

/** How many frames a field waits to be shown before it gives up on taking the focus. */
const FOCUS_FRAMES = 10;

/**
 * Puts the focus in `field` as it mounts. The diff library shows what it is
 * given only once it has made a place for it in its shadow DOM, after React
 * mounts it: until then the field can't take the focus, so it is tried again
 * each frame until it does.
 */
export function useFocusOnceShown(field: RefObject<HTMLElement | null>) {
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
