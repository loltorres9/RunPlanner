/**
 * Verläufe öffentlicher Touren bei Routen-Diensten laden, ohne Anmeldung.
 *
 * Das ist ein Versuch: Die Dienste bieten dafür keine offizielle Schnittstelle an.
 * Klappt es nicht (privat, Anmeldung nötig, Format geändert), bleibt es beim Link.
 */

import { finishTrack, parseTrackText, validPoint, type TrackInput, type TrackPoint } from '@runplanner/shared';
import { fetchPublic, ImportError } from './importer.js';

const MAX_BYTES = 15 * 1024 * 1024;

/** Komoot: Tour- oder Smarttour-Nummer und ggf. Freigabe-Schlüssel. */
export function komootTour(url: URL): { api: string } | null {
  if (!/(^|\.)komoot\.(com|de)$/i.test(url.hostname)) return null;
  const match = /\/(tour|smarttour)\/(\d+)/.exec(url.pathname);
  if (!match) return null;
  const kind = match[1] === 'smarttour' ? 'smart_tours' : 'tours';
  const api = new URL(`https://www.komoot.com/api/v007/${kind}/${match[2]}`);
  api.searchParams.set('_embedded', 'coordinates');
  const token = url.searchParams.get('share_token');
  if (token && /^[\w-]+$/.test(token)) api.searchParams.set('share_token', token);
  return { api: api.toString() };
}

/** Outdooractive: Tour-Nummer aus der Adresse, z. B. …/route/wanderung/…/12345678/. */
export function outdooractiveTour(url: URL): { gpx: string } | null {
  if (!/(^|\.)outdooractive\.com$/i.test(url.hostname)) return null;
  const id = /\/(\d{5,})\/?$/.exec(url.pathname)?.[1] ?? url.searchParams.get('i');
  if (!id || !/^\d+$/.test(id)) return null;
  return { gpx: `https://www.outdooractive.com/download.tour.gpx?i=${id}` };
}

export function isServiceTrack(url: string): boolean {
  try {
    const parsed = new URL(url);
    return komootTour(parsed) !== null || outdooractiveTour(parsed) !== null;
  } catch {
    return false;
  }
}

interface KomootResponse {
  name?: unknown;
  _embedded?: {
    coordinates?: { items?: { lat?: unknown; lng?: unknown; alt?: unknown }[] };
  };
}

/** Wertet die Antwort von Komoot aus. */
export function komootToTrack(json: KomootResponse): TrackInput {
  const items = json._embedded?.coordinates?.items ?? [];
  const points: TrackPoint[] = [];
  for (const item of items) {
    const point = validPoint(Number(item.lat), Number(item.lng), typeof item.alt === 'number' ? item.alt : null);
    if (point) points.push(point);
  }
  return finishTrack(points, typeof json.name === 'string' ? json.name : null);
}

/** Lädt den Verlauf einer öffentlichen Tour; wirft, wenn es nicht geht. */
export async function loadServiceTrack(url: string): Promise<TrackInput> {
  const parsed = new URL(url);
  const komoot = komootTour(parsed);
  if (komoot) {
    const response = await fetchPublic(komoot.api, {
      accept: 'application/hal+json,application/json',
      types: /json/i,
      maxBytes: MAX_BYTES,
    });
    let json: KomootResponse;
    try {
      json = JSON.parse(response.body) as KomootResponse;
    } catch {
      throw new ImportError('fetch_failed', 'Komoot liefert keinen Verlauf');
    }
    return komootToTrack(json);
  }
  const outdooractive = outdooractiveTour(parsed);
  if (outdooractive) {
    const response = await fetchPublic(outdooractive.gpx, {
      accept: 'application/gpx+xml,application/xml,*/*;q=0.5',
      types: /xml|gpx|octet-stream|text\/plain|force-download/i,
      maxBytes: MAX_BYTES,
    });
    return parseTrackText(response.body);
  }
  throw new ImportError('fetch_failed', 'Dienst wird nicht unterstützt');
}
