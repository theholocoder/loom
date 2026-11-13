// Gives every view the one way Loom writes dates and times (shared/dates.ts),
// built from the system's regional format and the user's date settings.
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Dates, DEFAULT_DATE_SETTINGS, ownLocale } from '../shared/dates';
import { useApi, useTopic } from './api';

/** The renderer's own locale: what Intl takes the system's to be, until main says. */
const OWN_LOCALE = ownLocale();

/** The renderer's own regional format, for a view with no DatesProvider above it. */
const DatesContext = createContext<{ dates: Dates; systemLocale: string }>({ dates: new Dates(OWN_LOCALE), systemLocale: OWN_LOCALE });

/**
 * Gives the window the user's way of writing dates and times: one
 * subscription to the settings for every view that writes one. `systemLocale`
 * is the system's regional format when already known; without it, main is asked.
 */
export function DatesProvider({ systemLocale, children }: { systemLocale?: string; children: ReactNode }) {
  const api = useApi();
  const [asked, setAsked] = useState<string>();
  useEffect(() => {
    if (systemLocale !== undefined) return;
    let current = true;
    api
      .invoke('settings.systemLocale')
      .then((locale) => current && setAsked(locale))
      .catch((error: unknown) => console.error("reading the system's regional format failed:", error));
    return () => {
      current = false;
    };
  }, [api, systemLocale]);
  const settings = useTopic('settings');
  const locale = systemLocale ?? asked ?? OWN_LOCALE;
  const dateFormat = settings?.dateFormat ?? DEFAULT_DATE_SETTINGS.dateFormat;
  const hourCycle = settings?.hourCycle ?? DEFAULT_DATE_SETTINGS.hourCycle;
  const value = useMemo(() => ({ dates: new Dates(locale, { dateFormat, hourCycle }), systemLocale: locale }), [locale, dateFormat, hourCycle]);
  return createElement(DatesContext.Provider, { value }, children);
}

/** How the user has dates and times written. */
export function useDates(): Dates {
  return useContext(DatesContext).dates;
}

/** The system's regional format, which Match system follows. */
export function useSystemLocale(): string {
  return useContext(DatesContext).systemLocale;
}
