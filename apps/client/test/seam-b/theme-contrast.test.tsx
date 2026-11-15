import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCENTS, accentColours, THEMES, type Accent, type Theme } from '../../src/shared/appearance';
import { PROJECT_COLOR_NAMES } from '../../src/shared/projects';

// Every theme's text stays readable: WCAG AA asks for 4.5:1 between normal
// text and what it sits on. The tokens are read from styles.css itself.

const css = readFileSync(join(__dirname, '../../src/renderer/styles.css'), 'utf8');

/** A theme's colour tokens, by name, from its `[data-theme]` block. */
function tokens(theme: string): (name: string) => string {
  const block = new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (block === undefined) throw new Error(`styles.css has no [data-theme="${theme}"] block`);
  const colours = new Map([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,8})/gi)].map((m) => [m[1]!, m[2]!]));
  return (name) => {
    const colour = colours.get(name);
    if (colour === undefined) throw new Error(`the ${theme} theme has no --${name} colour`);
    return colour;
  };
}

function luminance(hex: string): number {
  const h = hex.slice(1);
  const full = h.length < 6 ? [...h.slice(0, 3)].map((c) => c + c).join('') : h.slice(0, 6);
  const channel = (i: number) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The colours text is drawn in. */
const TEXT = ['text', 'muted', 'accent', 'wait', 'work', 'ok', 'err'];
/** What that text sits on: the page, panels, controls, hovered and selected rows, the user's messages, code. */
const SURFACES = ['bg', 'panel', 'panel2', 'hover', 'sel', 'user', 'code'];

describe.each(Object.keys(THEMES))('the %s theme', (theme) => {
  const colour = tokens(theme);

  it.each(TEXT)('draws %s text at 4.5:1 or more on every surface', (fg) => {
    const ratio = (bg: string) => contrast(colour(fg), colour(bg));
    const low = SURFACES.filter((bg) => ratio(bg) < 4.5).map((bg) => `${fg} on ${bg}: ${ratio(bg).toFixed(2)}`);
    expect(low).toEqual([]);
  });

  it('draws primary button labels at 4.5:1 or more', () => {
    expect(contrast(colour('accent-text'), colour('accent'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each((Object.keys(ACCENTS) as Accent[]).filter((accent) => accent !== 'theme'))('the %s accent', (accent) => {
  it.each(Object.keys(THEMES) as Theme[])('in the %s theme, reads as text on every surface and under a primary button’s label', (theme) => {
    const colour = tokens(theme);
    const colours = accentColours(accent, theme)!;
    const low = SURFACES.filter((bg) => contrast(colours.accent, colour(bg)) < 4.5).map((bg) => `on ${bg}: ${contrast(colours.accent, colour(bg)).toFixed(2)}`);
    expect(low).toEqual([]);
    expect(contrast(colours.accentText, colours.accent)).toBeGreaterThanOrEqual(4.5);
  });
});

/** A theme's colour tokens from every rule naming it, alone or among others, as the cascade merges them. */
function allTokens(theme: string): Map<string, string> {
  const colours = new Map<string, string>();
  for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (!selectors!.split(',').some((s) => s.trim() === `[data-theme="${theme}"]`)) continue;
    for (const m of body!.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,8})/gi)) colours.set(m[1]!, m[2]!);
  }
  return colours;
}

describe.each(Object.keys(THEMES))("Projects' colours in the %s theme", (theme) => {
  const colours = allTokens(theme);

  it.each(PROJECT_COLOR_NAMES)('labels %s in whichever of white or near-black reads better on it', (color) => {
    const fill = colours.get(`proj-${color}`);
    const ink = colours.get(`proj-${color}-ink`);
    expect(fill).toBeDefined();
    expect(ink).toBeDefined();
    const other = ink === '#ffffff' ? '#0b0b0b' : '#ffffff';
    expect(contrast(ink!, fill!)).toBeGreaterThanOrEqual(contrast(other, fill!));
    expect(contrast(ink!, fill!)).toBeGreaterThanOrEqual(3.9);
  });
});
