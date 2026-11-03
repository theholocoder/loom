// Puts the theme and fonts from Loom's settings on the document, where the
// stylesheet's [data-theme] blocks and --font / --mono pick them up.
import { useLayoutEffect } from 'react';
import { MONO_FONTS, UI_FONTS, type Appearance } from '../shared/appearance';
import { useTopic } from './api';

export function applyAppearance({ theme, uiFont, monoFont }: Appearance, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  root.style.setProperty('--font', UI_FONTS[uiFont]);
  root.style.setProperty('--mono', MONO_FONTS[monoFont]);
}

/** Keeps the document's look in step with the settings as they change. */
export function useAppearance(): void {
  const settings = useTopic('settings');
  const { theme, uiFont, monoFont } = settings ?? {};
  useLayoutEffect(() => {
    if (theme && uiFont && monoFont) applyAppearance({ theme, uiFont, monoFont });
  }, [theme, uiFont, monoFont]);
}
