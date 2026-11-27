/**
 * Macht aus Freitext-Notizen zur Unterkunft einzelne Vorschläge, z. B. aus
 *
 *   Hotel Adler, ca. 90 € – https://adler.de
 *   Jugendherberge
 *   https://jugendherberge.de/esslingen
 *
 * zwei Vorschläge mit Name, Link und Preis. Das Ergebnis ist ein Entwurf, den man
 * vor dem Speichern noch anpassen kann.
 */

import type { AccommodationInput } from './model.js';

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;
const PRICE_PATTERN = /(?:\bca\.?\s*|\bab\s*|~\s*)?(?:\d+(?:[.,]\d{1,2})?\s*(?:€|eur\b|euro\b|chf\b|fr\.)|(?:€|chf)\s*\d+(?:[.,]\d{1,2})?)(?:\s*(?:(?:pro|\/|je|per)\s*)?(?:nacht|night|person|pers\.|p\.?\s?p\.?|zimmer|room))?/i;
const BULLET = /^\s*(?:[-*•·–]|\d+[.)])\s*/;

function tidy(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:|–—.-]+|[\s,;:|–—.(-]+$/g, '')
    .replace(/\(\s*\)/g, '')
    .trim();
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function notesToAccommodations(notes: string): AccommodationInput[] {
  const result: AccommodationInput[] = [];
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.replace(BULLET, '').trim();
    if (line === '') continue;
    const url = URL_PATTERN.exec(line)?.[0]?.replace(/[.,;:]+$/, '') ?? null;
    let rest = url ? line.replace(url, ' ') : line;
    const price = PRICE_PATTERN.exec(rest)?.[0]?.trim() ?? null;
    if (price) rest = rest.replace(price, ' ');
    const name = tidy(rest);
    const previous = result[result.length - 1];
    // Eine Zeile nur mit Link oder Preis gehört zum Vorschlag darüber.
    if (name === '' && previous && ((url && !previous.url) || (!url && price && !previous.price))) {
      if (url) previous.url = url;
      if (price) previous.price = price;
      continue;
    }
    result.push({
      name: (name || (url ? hostName(url) : price) || line).slice(0, 200),
      url,
      price: price?.slice(0, 120) ?? null,
      notes: null,
      nights: [],
    });
  }
  return result.slice(0, 30);
}
