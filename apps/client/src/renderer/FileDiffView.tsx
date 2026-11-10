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

/** Draws a patch for one file. It must have a hunk: the library throws on text that holds no file diff. */
export function FileDiffView({ patch, theme }: { patch: string; theme: Theme }) {
  const options = useMemo(
    () => ({ diffStyle: 'unified', lineDiffType: 'word', disableFileHeader: true, disableLineNumbers: false, theme: SHIKI_THEMES[theme], themeType: THEMES[theme].scheme }) as const,
    [theme],
  );
  return <PatchDiff className="file-diff" patch={patch} options={options} />;
}
