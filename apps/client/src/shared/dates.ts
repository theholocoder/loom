// Every date and time Loom writes, in one place: the words ("Tomorrow",
// "3 h ago", month and weekday names) in the UI's language, English, and the
// order, separators and clock in the user's regional format, the system's
// unless Settings picks another. So a French system reads "Tomorrow 09:00"
// and "Mon 9 Nov", never "Tomorrow" beside "lun. 09:00".

import { isIn, MATCH_SYSTEM_LABEL } from './appearance';

/** The language Loom's UI is written in, whose words every date and time uses. */
export const UI_LANGUAGE = 'en';

/** The regional formats Settings offers, by locale, besides the system's own. */
export const DATE_FORMATS = {
  system: { label: MATCH_SYSTEM_LABEL },
  'en-US': { label: 'United States' },
  'en-GB': { label: 'United Kingdom' },
  'en-CA': { label: 'Canada' },
  'en-AU': { label: 'Australia' },
  'en-IN': { label: 'India' },
  'fr-FR': { label: 'France' },
  'de-DE': { label: 'Germany' },
  'es-ES': { label: 'Spain' },
  'it-IT': { label: 'Italy' },
  'nl-NL': { label: 'Netherlands' },
  'pt-BR': { label: 'Brazil' },
  'sv-SE': { label: 'Sweden' },
  'pl-PL': { label: 'Poland' },
  'ja-JP': { label: 'Japan' },
  'zh-CN': { label: 'China' },
  'ko-KR': { label: 'South Korea' },
} as const;

export type DateFormat = keyof typeof DATE_FORMATS;

/** The clock times are written on: the regional format's own, or one of the two. */
export const HOUR_CYCLES = {
  system: { label: 'Match the format' },
  '12h': { label: '12-hour' },
  '24h': { label: '24-hour' },
} as const;

export type HourCycle = keyof typeof HOUR_CYCLES;

export interface DateSettings {
  /** The regional format dates and times follow: the system's until Settings picks another. */
  dateFormat: DateFormat;
  /** The clock times are written on: the regional format's until Settings picks one. */
  hourCycle: HourCycle;
}

/** The locale this runtime's Intl takes for its own: a stand-in for the system's regional format, until it is known. */
export function ownLocale(): string {
  return new Intl.DateTimeFormat().resolvedOptions().locale;
}

export const DEFAULT_DATE_SETTINGS: DateSettings = { dateFormat: 'system', hourCycle: 'system' };

/** The parts of the settings that say how dates and times are written. */
export function dateSettingsOf({ dateFormat, hourCycle }: DateSettings): DateSettings {
  return { dateFormat, hourCycle };
}

export const isDateFormat = isIn(DATE_FORMATS);
export const isHourCycle = isIn(HOUR_CYCLES);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How a regional format is written in the UI's language: the English of its
 * region where there is one ("en-FR" writes 9 Nov, 14:05), else English with
 * the day first or the month first as the region has it, and the region's
 * clock unless `hourCycle` picks one.
 */
export function formattingLocale(regional: string, hourCycle: HourCycle = 'system'): { locale: string; hourCycle: 'h12' | 'h23' } {
  const tag = canonical(regional);
  const region = new Intl.Locale(tag).maximize().region;
  const own = region && `${UI_LANGUAGE}-${region}`;
  const locale = own && supported(own) ? own : dayFirst(tag) ? `${UI_LANGUAGE}-150` : UI_LANGUAGE;
  const twelve = hourCycle === 'system' ? isTwelveHour(tag) : hourCycle === '12h';
  return { locale, hourCycle: twelve ? 'h12' : 'h23' };
}

/** `locale`, canonical; the UI's language for one Intl can't read. */
function canonical(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? UI_LANGUAGE;
  } catch {
    return UI_LANGUAGE;
  }
}

/** Whether Intl has the very locale, not one it falls back to. */
function supported(locale: string): boolean {
  return new Intl.DateTimeFormat(locale).resolvedOptions().locale === locale;
}

/** Whether the locale writes the day before the month. */
function dayFirst(locale: string): boolean {
  const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' }).formatToParts(new Date(2026, 10, 9)).map((p) => p.type);
  return parts.indexOf('day') < parts.indexOf('month');
}

function isTwelveHour(locale: string): boolean {
  const { hourCycle } = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
  return hourCycle === 'h11' || hourCycle === 'h12';
}

/** The midnight starting `at`'s day, local time. */
function startOfDay(at: number): number {
  return new Date(at).setHours(0, 0, 0, 0);
}

/** How many calendar days `at` is after `now`'s day: 0 today, 1 tomorrow, -1 yesterday. */
function daysFrom(now: number, at: number): number {
  return Math.round((startOfDay(at) - startOfDay(now)) / DAY);
}

/**
 * Writes dates and times in a regional format, with the UI's words. Built
 * from the system's regional format and the user's date settings.
 */
export class Dates {
  readonly locale: string;
  private readonly formats = new Map<string, Intl.DateTimeFormat>();
  private readonly hourCycle: 'h12' | 'h23';

  constructor(systemLocale: string, settings: DateSettings = DEFAULT_DATE_SETTINGS) {
    const regional = settings.dateFormat === 'system' ? systemLocale : settings.dateFormat;
    const { locale, hourCycle } = formattingLocale(regional, settings.hourCycle);
    this.locale = locale;
    this.hourCycle = hourCycle;
  }

  private format(at: number, options: Intl.DateTimeFormatOptions): string {
    const key = JSON.stringify(options);
    let format = this.formats.get(key);
    if (!format) {
      // A 24-hour clock writes the hour in two digits, 09:05; a 12-hour one doesn't, 9:05 AM.
      const hour = this.hourCycle === 'h23' ? '2-digit' : 'numeric';
      format = new Intl.DateTimeFormat(this.locale, options.hour ? { ...options, hour, hourCycle: this.hourCycle } : options);
      this.formats.set(key, format);
    }
    return format.format(at);
  }

  /** The time of day: "09:05", or "9:05 AM". */
  time(at: number): string {
    return this.format(at, { hour: 'numeric', minute: '2-digit' });
  }

  /** The day: "9 Nov", or "Nov 9", with the year when it isn't `now`'s. */
  day(at: number, now: number): string {
    const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
    return this.format(at, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /** A day of the calendar, as `2026-11-05`: "5 Nov", or "Nov 5". */
  calendarDay(day: string): string {
    const [y, m, d] = day.split('-').map(Number);
    return this.format(new Date(y!, m! - 1, d!).getTime(), { month: 'short', day: 'numeric' });
  }

  /** The date and time in full, for a tooltip: "Mon, 9 Nov 2026, 14:05". */
  full(at: number): string {
    return this.format(at, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /** How long ago `at` was: "just now", "12 min ago", "3 h ago", "Yesterday", then the day. */
  ago(at: number, now: number): string {
    const since = now - at;
    if (since < MINUTE) return 'just now';
    if (since < HOUR) return `${Math.floor(since / MINUTE)} min ago`;
    if (since < DAY) return `${Math.floor(since / HOUR)} h ago`;
    if (since < 2 * DAY) return 'Yesterday';
    return this.day(at, now);
  }

  /** How long ago `at` was, as short as can be: "now" within the minute, then "4m", "3h", "2d", and the day after a week. */
  agoShort(at: number, now: number): string {
    const since = now - at;
    if (since < MINUTE) return 'now';
    if (since < HOUR) return `${Math.floor(since / MINUTE)}m`;
    if (since < DAY) return `${Math.floor(since / HOUR)}h`;
    if (since < 7 * DAY) return `${Math.floor(since / DAY)}d`;
    return this.day(at, now);
  }

  /** When a time still to come is: the time today, "Tomorrow" and the time, the weekday and time within the week, else the day and time. */
  upcoming(at: number, now: number): string {
    const time = this.time(at);
    const days = daysFrom(now, at);
    if (days <= 0) return time;
    if (days === 1) return `Tomorrow ${time}`;
    if (days < 7) return `${this.format(at, { weekday: 'short' })} ${time}`;
    return `${this.day(at, now)} ${time}`;
  }
}
