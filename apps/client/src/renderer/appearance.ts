// Puts the look from Loom's settings on the document: the theme as
// data-theme, which the stylesheet's [data-theme] blocks pick up, the fonts as
// --font and --mono, the density as data-density and a chosen accent as
// --accent and --accent-text. The font size is main's: it zooms the window.
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { accentColours, appearanceOf, DEFAULT_APPEARANCE, MONO_FONTS, resolveTheme, THEMES, UI_FONTS, type Appearance, type Theme } from '../shared/appearance';
import { useTopic } from './api';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Whether the system is in dark mode; light where it can't say. */
export function systemDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

function subscribeToSystem(changed: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}

/** Whether the system is in dark mode, kept current as it changes. */
export function useSystemDark(): boolean {
  return useSyncExternalStore(subscribeToSystem, systemDark);
}

export function applyAppearance(appearance: Appearance, dark: boolean = systemDark()): void {
  const theme = resolveTheme(appearance, dark);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.density = appearance.density;
  // Light or dark scrollbars, inputs and other controls the OS draws.
  root.style.colorScheme = THEMES[theme].scheme;
  root.style.setProperty('--font', UI_FONTS[appearance.uiFont]);
  root.style.setProperty('--mono', MONO_FONTS[appearance.monoFont]);
  const accent = accentColours(appearance.accent, theme);
  if (accent) {
    root.style.setProperty('--accent', accent.accent);
    root.style.setProperty('--accent-text', accent.accentText);
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-text');
  }
}

/** The theme the window shows: the one set, or the system's light or dark one when matching it. */
export function useTheme(): Theme {
  return resolveTheme(useTopic('settings') ?? DEFAULT_APPEARANCE, useSystemDark());
}

/** Keeps the document's look in step with the settings, and the system's mode, as they change. */
export function useAppearance(): void {
  const settings = useTopic('settings');
  const dark = useSystemDark();
  // Compared by value: other settings changing leave the look as it is.
  const look = settings && JSON.stringify(appearanceOf(settings));
  useLayoutEffect(() => {
    if (look) applyAppearance(JSON.parse(look) as Appearance, dark);
  }, [look, dark]);
}
