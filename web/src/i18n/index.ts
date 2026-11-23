import { createContext, useContext } from 'react';
import type { Language } from '@runplanner/shared';
import { de, type Messages } from './de.js';
import { en } from './en.js';

export const messages: Record<Language, Messages> = { de, en };

export function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem('language');
    if (stored === 'de' || stored === 'en') return stored;
  } catch {
    // Kein Speicher verfügbar: Browsersprache nehmen.
  }
  return navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export interface I18n {
  lang: Language;
  t: Messages;
  /** Ersetzt {platzhalter} im Text. */
  f: (text: string, values: Record<string, string | number>) => string;
  date: (day: string, options?: Intl.DateTimeFormatOptions) => string;
  money: (amount: number, currency: string) => string;
  number: (value: number, digits?: number) => string;
}

export function makeI18n(lang: Language): I18n {
  const locale = lang === 'de' ? 'de-DE' : 'en-GB';
  return {
    lang,
    t: messages[lang],
    f: (text, values) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`)),
    date: (day, options = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) =>
      new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC', ...options }),
    money: (amount, currency) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount),
    number: (value, digits = 1) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value),
  };
}

export const I18nContext = createContext<I18n>(makeI18n('de'));

export function useI18n(): I18n {
  return useContext(I18nContext);
}
