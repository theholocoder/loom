// What the user picks about a Project's look and name: its colour, its avatar
// and its name, with what each accepts. Main checks them again on save.

/**
 * A Project's colour, the same wherever it shows (its avatar, the Glance
 * strip, the Inbox and the Dashboard's charts): the validated categorical
 * palette's slots, in its order. Each is a `--proj-<key>` token of every
 * theme in styles.css, its light or dark step.
 */
export const PROJECT_COLORS = {
  blue: { label: 'Blue' },
  orange: { label: 'Orange' },
  aqua: { label: 'Aqua' },
  yellow: { label: 'Yellow' },
  magenta: { label: 'Magenta' },
  green: { label: 'Green' },
  violet: { label: 'Violet' },
  red: { label: 'Red' },
} as const;

export type ProjectColor = keyof typeof PROJECT_COLORS;

export const PROJECT_COLOR_NAMES = Object.keys(PROJECT_COLORS) as ProjectColor[];

export function isProjectColor(value: unknown): value is ProjectColor {
  return typeof value === 'string' && Object.hasOwn(PROJECT_COLORS, value);
}

/** A colour as stored: one Loom doesn't have (or none) stands for the first. */
export function projectColorOf(value: unknown): ProjectColor {
  return isProjectColor(value) ? value : 'blue';
}

/**
 * The colour a new Project gets: the first one no Project has, removed ones
 * included, so the history keeps them apart; else the first no Project in
 * use has; with every one in use, the next in turn after the newest Project's.
 */
export function nextProjectColor(inUse: readonly ProjectColor[], removed: readonly ProjectColor[] = []): ProjectColor {
  const free = PROJECT_COLOR_NAMES.find((color) => !inUse.includes(color) && !removed.includes(color)) ?? PROJECT_COLOR_NAMES.find((color) => !inUse.includes(color));
  if (free) return free;
  const last = inUse.at(-1);
  return PROJECT_COLOR_NAMES[(last ? PROJECT_COLOR_NAMES.indexOf(last) + 1 : 0) % PROJECT_COLOR_NAMES.length]!;
}

/** The longest name a Project takes, in characters. */
export const PROJECT_NAME_MAX = 60;

/** Why `name` can't be a Project's name; none when it can. */
export function projectNameError(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'A Project needs a name.';
  if ([...trimmed].length > PROJECT_NAME_MAX) return `A Project's name takes at most ${PROJECT_NAME_MAX} characters.`;
  return undefined;
}

/** The most characters an avatar shows, each a letter, a digit or an emoji as the eye counts them. */
export const AVATAR_MAX = 2;

/** `text` cut into characters as the eye counts them: an emoji with its modifiers is one. */
function graphemes(text: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);
}

/** Why `avatar` can't be a Project's avatar; none when it can, or when it is empty (the initials then). */
export function avatarError(avatar: string): string | undefined {
  const text = avatar.trim();
  if (/\s/.test(text)) return 'An avatar has no spaces.';
  if (graphemes(text).length > AVATAR_MAX) return `An avatar takes at most ${AVATAR_MAX} characters, or one emoji.`;
  return undefined;
}

/** What a Project's avatar shows: the one the user set, or the first two letters of its name. */
export function avatarText(project: { name: string; avatar?: string }): string {
  return project.avatar ?? graphemes(project.name.trim()).slice(0, AVATAR_MAX).join('').toUpperCase();
}
