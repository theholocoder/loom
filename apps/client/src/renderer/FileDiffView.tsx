// One file's diff, drawn by @pierre/diffs. The only module that imports the
// library: everything else hands it a patch and the Loom theme. Colours other
// than the code's own come from the Loom theme, through the library's CSS
// variables on `.file-diff` in styles.css.
import { PatchDiff } from '@pierre/diffs/react';
import { useMemo } from 'react';
import { THEMES, type Theme } from '../shared/appearance';

/** The Shiki theme that colours code in each Loom theme. */
const SHIKI_THEMES: Record<Theme, string> = {
  midnight: 'github-dark',
  paper: 'rose-pine-dawn',
  nord: 'nord',
  mocha: 'catppuccin-mocha',
  daylight: 'github-light',
};

/** How the user has chosen to lay out the diffs. */
export interface DiffLayout {
  wrap: boolean;
  sideBySide: boolean;
}

/** Draws a patch for one file. It must have a hunk: the library throws on text that holds no file diff. */
export function FileDiffView({ patch, theme, layout: { wrap, sideBySide } }: { patch: string; theme: Theme; layout: DiffLayout }) {
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
      }) as const,
    [theme, wrap, sideBySide],
  );
  return <PatchDiff className="file-diff" patch={patch} options={options} />;
}
