// How Loom looks: the themes and fonts of docs/prototypes/ui-layout.html,
// and the font size, density and accent colour laid over them.
// Fonts are a fixed list, bundled with Loom or the system's own: the renderer
// loads nothing from the network.

export const THEMES = {
  midnight: { label: 'Midnight', background: '#0f1117', scheme: 'dark' },
  paper: { label: 'Paper', background: '#f6f3ec', scheme: 'light' },
  nord: { label: 'Nord', background: '#2e3440', scheme: 'dark' },
  mocha: { label: 'Mocha', background: '#1e1e2e', scheme: 'dark' },
  daylight: { label: 'Daylight', background: '#ffffff', scheme: 'light' },
} as const;

export type Theme = keyof typeof THEMES;
export type LightTheme = { [T in Theme]: (typeof THEMES)[T]['scheme'] extends 'light' ? T : never }[Theme];
export type DarkTheme = Exclude<Theme, LightTheme>;

/** The theme setting: one theme, or whichever of two the system's light or dark mode says. */
export type ThemeChoice = Theme | 'system';
export const MATCH_SYSTEM_LABEL = 'Match system';

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

/**
 * How large the whole window draws, text with its icons and spacing, as the
 * window's zoom: the stylesheet sizes in pixels, so this keeps it in proportion.
 */
export const FONT_SIZES = {
  small: { label: 'Small', zoom: 0.9 },
  default: { label: 'Default', zoom: 1 },
  large: { label: 'Large', zoom: 1.1 },
  larger: { label: 'Larger', zoom: 1.25 },
} as const;

export type FontSize = keyof typeof FONT_SIZES;

/** How much room rows, cards and messages leave around their content: put on <html> as data-density. */
export const DENSITIES = {
  comfortable: { label: 'Comfortable' },
  compact: { label: 'Compact' },
} as const;

export type Density = keyof typeof DENSITIES;

/**
 * Accent colours, each in a shade for light themes and one for dark themes,
 * every one readable as text on every surface of its themes and under the
 * label of a primary button (test/seam-b/theme-contrast.test.tsx). `theme`
 * keeps each theme's own.
 */
export const ACCENTS = {
  theme: { label: "Theme's own" },
  blue: { label: 'Blue', light: '#1d4fc4', dark: '#a3c1ff' },
  violet: { label: 'Violet', light: '#6d3fc8', dark: '#d2bdff' },
  pink: { label: 'Pink', light: '#b0246a', dark: '#ffadd2' },
  teal: { label: 'Teal', light: '#0b6a6a', dark: '#5fd6c8' },
  green: { label: 'Green', light: '#2b6b1e', dark: '#9ad97a' },
  orange: { label: 'Orange', light: '#a2410f', dark: '#ffb380' },
} as const;

export type Accent = keyof typeof ACCENTS;

/** A primary button's label on an accent of ACCENTS, by the scheme of the theme. */
export const ACCENT_TEXT = { light: '#ffffff', dark: '#111318' } as const;

export interface Appearance {
  theme: ThemeChoice;
  /** The theme while the system is in light mode, when `theme` matches the system. */
  lightTheme: LightTheme;
  /** The theme while the system is in dark mode, when `theme` matches the system. */
  darkTheme: DarkTheme;
  uiFont: UiFont;
  monoFont: MonoFont;
  fontSize: FontSize;
  density: Density;
  accent: Accent;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'midnight',
  lightTheme: 'daylight',
  darkTheme: 'midnight',
  uiFont: 'Inter',
  monoFont: 'IBM Plex Mono',
  fontSize: 'default',
  density: 'comfortable',
  accent: 'theme',
};

/** The parts of the look that say which theme shows. */
export type ThemeSetting = Pick<Appearance, 'theme' | 'lightTheme' | 'darkTheme'>;

/** The parts of the look, picked out of a value that holds them, such as the settings. */
export function appearanceOf({ theme, lightTheme, darkTheme, uiFont, monoFont, fontSize, density, accent }: Appearance): Appearance {
  return { theme, lightTheme, darkTheme, uiFont, monoFont, fontSize, density, accent };
}

/** The theme the window shows: the one set, or for Match system, the light or dark one as the system is. */
export function resolveTheme({ theme, lightTheme, darkTheme }: ThemeSetting, systemDark: boolean): Theme {
  if (theme !== 'system') return theme;
  return systemDark ? darkTheme : lightTheme;
}

/** An accent's colour and its primary buttons' label colour in `theme`; none for the theme's own. */
export function accentColours(accent: Accent, theme: Theme): { accent: string; accentText: string } | undefined {
  const colours = ACCENTS[accent];
  if (!('light' in colours)) return undefined;
  const scheme = THEMES[theme].scheme;
  return { accent: colours[scheme], accentText: ACCENT_TEXT[scheme] };
}

/** What main gives the window of the look: the theme's background, so it never shows another first, and its zoom. */
export interface WindowLook {
  background: string;
  zoom: number;
}

export function windowLook(appearance: ThemeSetting & Pick<Appearance, 'fontSize'>, systemDark: boolean): WindowLook {
  return { background: THEMES[resolveTheme(appearance, systemDark)].background, zoom: FONT_SIZES[appearance.fontSize].zoom };
}

const isIn =
  <T extends object>(table: T) =>
  (value: unknown): value is keyof T =>
    typeof value === 'string' && Object.hasOwn(table, value);

export const isTheme = isIn(THEMES);
export const isThemeChoice = (value: unknown): value is ThemeChoice => value === 'system' || isTheme(value);
export const isLightTheme = (value: unknown): value is LightTheme => isTheme(value) && THEMES[value].scheme === 'light';
export const isDarkTheme = (value: unknown): value is DarkTheme => isTheme(value) && THEMES[value].scheme === 'dark';
export const isFontSize = isIn(FONT_SIZES);
export const isDensity = isIn(DENSITIES);
export const isAccent = isIn(ACCENTS);
export const isUiFont = isIn(UI_FONTS);
export const isMonoFont = isIn(MONO_FONTS);
