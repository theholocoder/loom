// How Loom looks: the themes and fonts of docs/prototypes/ui-layout.html.
// Fonts are a fixed list, bundled with Loom or the system's own: the renderer
// loads nothing from the network.

export const THEMES = {
  midnight: { label: 'Midnight', background: '#0f1117' },
  paper: { label: 'Paper', background: '#f6f3ec' },
  nord: { label: 'Nord', background: '#2e3440' },
  mocha: { label: 'Mocha', background: '#1e1e2e' },
  daylight: { label: 'Daylight', background: '#ffffff' },
} as const;

export type Theme = keyof typeof THEMES;

/** UI fonts, by name, and the CSS font stack each sets. */
export const UI_FONTS = {
  Inter: '"Inter", system-ui, sans-serif',
  'IBM Plex Sans': '"IBM Plex Sans", system-ui, sans-serif',
  'Atkinson Hyperlegible': '"Atkinson Hyperlegible", system-ui, sans-serif',
  Figtree: '"Figtree", system-ui, sans-serif',
  'system-ui': 'system-ui, sans-serif',
} as const;

export type UiFont = keyof typeof UI_FONTS;

/** Monospace fonts, for every technical reference, by name. */
export const MONO_FONTS = {
  'IBM Plex Mono': '"IBM Plex Mono", ui-monospace, monospace',
  'JetBrains Mono': '"JetBrains Mono", ui-monospace, monospace',
  'Fira Code': '"Fira Code", ui-monospace, monospace',
  'Source Code Pro': '"Source Code Pro", ui-monospace, monospace',
  'ui-monospace': 'ui-monospace, monospace',
} as const;

export type MonoFont = keyof typeof MONO_FONTS;

export interface Appearance {
  theme: Theme;
  uiFont: UiFont;
  monoFont: MonoFont;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'midnight', uiFont: 'Inter', monoFont: 'IBM Plex Mono' };

const isIn =
  <T extends object>(table: T) =>
  (value: unknown): value is keyof T =>
    typeof value === 'string' && Object.hasOwn(table, value);

export const isTheme = isIn(THEMES);
export const isUiFont = isIn(UI_FONTS);
export const isMonoFont = isIn(MONO_FONTS);
