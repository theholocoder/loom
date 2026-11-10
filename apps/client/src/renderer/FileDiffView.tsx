// One file's diff, drawn by @pierre/diffs. The only module that imports the
// library: everything else hands it a patch, the Loom theme and, to comment
// on it, what to do with a range the "+" was pressed for. Colours other
// than the code's own come from the Loom theme, through the library's CSS
// variables on `.file-diff` in styles.css.
import { PatchDiff } from '@pierre/diffs/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DiffViewSettings } from '../shared/api';
import { THEMES, type Theme } from '../shared/appearance';
import type { LinePoint, LineRange } from './diff-comments';

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
  /** Called with the line, or the range dragged over or selected, the "+" was pressed for. */
  onPlus: (range: LineRange) => void;
  /** The comment being written, if any: its range, kept selected, and its form, under its last line. */
  draft?: { range: LineRange; at: Required<LinePoint>; form: ReactNode };
}

/** Draws a patch for one file. It must have a hunk: the library throws on text that holds no file diff. */
export function FileDiffView({
  patch,
  theme,
  view: { wrap, sideBySide },
  commenting,
}: {
  patch: string;
  theme: Theme;
  view: Pick<DiffViewSettings, 'wrap' | 'sideBySide'>;
  /** Absent when the diff can't be commented on. */
  commenting?: Commenting;
}) {
  const commentable = commenting !== undefined;
  // The latest `onPlus`, so that a new one doesn't make new options, which would draw the diff again.
  const onPlus = useRef(commenting?.onPlus);
  onPlus.current = commenting?.onPlus;
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
              onGutterUtilityClick: (range: LineRange) => onPlus.current?.(range),
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
  const annotations = useMemo(() => (draft ? [{ side: draft.at.side, lineNumber: draft.at.lineNumber }] : undefined), [draft?.at.side, draft?.at.lineNumber]);
  return (
    <PatchDiff
      className="file-diff"
      patch={patch}
      options={options}
      {...(commentable ? { selectedLines: draft?.range ?? selection, lineAnnotations: annotations, renderAnnotation: () => draft?.form } : {})}
    />
  );
}
