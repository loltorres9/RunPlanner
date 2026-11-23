/**
 * GPX-Dateien auf der Website einer Veranstaltung finden und den Strecken zuordnen.
 *
 * Der Server liest die Dateien ohne DOM, deshalb hier ein schlichter Leser für das
 * GPX-Format: Trackpunkte, sonst Routenpunkte, jeweils mit Höhe.
 */

import { z } from 'zod';
import { thinTrack, trackStats, type TrackInput, type TrackPoint } from './track.js';

/** Eine gefundene GPX-Datei mit Kennzahlen und vorgeschlagener Strecke. */
export interface GpxCandidate {
  url: string;
  fileName: string;
  /** Linktext oder Name im GPX, hilft beim Zuordnen. */
  label: string;
  distanceKm: number;
  gainM: number | null;
  /** Vorschlag, zu welcher Strecke die Datei gehört. */
  raceId: string | null;
}

/** Verlauf bei einem Dienst wie Komoot oder Strava, nicht automatisch ladbar. */
export interface ExternalRoute {
  url: string;
  service: string;
  label: string;
}

export interface GpxSearchResult {
  candidates: GpxCandidate[];
  external: ExternalRoute[];
  pagesChecked: number;
  /** Wie die Zuordnung zustande kam: per KI oder nur über die Distanz. */
  matchedBy: 'ai' | 'distance' | null;
}

export const gpxApplySchema = z.object({
  items: z
    .array(z.object({ raceId: z.string().min(1), url: z.string().url().max(2000) }))
    .min(1)
    .max(30),
});
export type GpxApplyInput = z.input<typeof gpxApplySchema>;

export class GpxParseError extends Error {}

function attr(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? null;
}

function textOf(xml: string, tag: string): string | null {
  const match = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(xml)?.[1];
  if (match === undefined) return null;
  const clean = match.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
  return clean === '' ? null : clean;
}

function readPoints(xml: string, tag: 'trkpt' | 'rtept'): TrackPoint[] {
  const points: TrackPoint[] = [];
  const pattern = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, 'gi');
  for (const match of xml.matchAll(pattern)) {
    const lat = Number(attr(match[1] ?? '', 'lat'));
    const lon = Number(attr(match[1] ?? '', 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (attr(match[1] ?? '', 'lat') === null || attr(match[1] ?? '', 'lon') === null) continue;
    const eleText = match[2] ? textOf(match[2], 'ele') : null;
    const ele = eleText === null ? null : Number(eleText);
    points.push([lat, lon, ele !== null && Number.isFinite(ele) && ele > -500 && ele < 9000 ? ele : null]);
  }
  return points;
}

/** Liest eine GPX-Datei als Text; wirft GpxParseError, wenn keine Punkte drin sind. */
export function parseGpxText(xml: string): TrackInput {
  if (!/<gpx\b/i.test(xml)) throw new GpxParseError('Keine GPX-Datei');
  let points = readPoints(xml, 'trkpt');
  if (points.length < 2) points = readPoints(xml, 'rtept');
  if (points.length < 2) throw new GpxParseError('Keine Streckenpunkte');
  const trk = /<(?:\w+:)?trk\b[\s\S]*?<\/(?:\w+:)?trk>/i.exec(xml)?.[0];
  const metadata = /<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/i.exec(xml)?.[0];
  const name = (trk ? textOf(trk, 'name') : null) ?? (metadata ? textOf(metadata, 'name') : null);
  const stats = trackStats(points);
  const thin = thinTrack(points).map(([lat, lon, ele]): TrackPoint => [
    Math.round(lat * 1e6) / 1e6,
    Math.round(lon * 1e6) / 1e6,
    ele === null ? null : Math.round(ele),
  ]);
  return { name: name ? name.slice(0, 200) : null, points: thin, ...stats };
}

export interface MatchRace {
  id: string;
  name: string;
  distanceKm: number | null;
}

export interface MatchFile {
  distanceKm: number;
}

/**
 * Zuordnung ohne KI: jede Strecke bekommt die Datei mit der ähnlichsten Distanz,
 * höchstens 20 % daneben. Gibt es nur eine Strecke und eine Datei, passen sie zusammen.
 * Ergebnis: Index der Datei je Strecke (oder null).
 */
export function matchByDistance(races: MatchRace[], files: MatchFile[]): Map<string, number | null> {
  const result = new Map<string, number | null>(races.map((r) => [r.id, null]));
  if (races.length === 1 && files.length === 1 && races[0]!.distanceKm === null) {
    result.set(races[0]!.id, 0);
    return result;
  }
  const pairs: { raceId: string; file: number; diff: number }[] = [];
  for (const race of races) {
    if (race.distanceKm === null || race.distanceKm <= 0) continue;
    files.forEach((file, index) => {
      const diff = Math.abs(file.distanceKm - race.distanceKm!) / race.distanceKm!;
      if (diff <= 0.2) pairs.push({ raceId: race.id, file: index, diff });
    });
  }
  pairs.sort((a, b) => a.diff - b.diff);
  const usedFiles = new Set<number>();
  for (const pair of pairs) {
    if (result.get(pair.raceId) !== null || usedFiles.has(pair.file)) continue;
    result.set(pair.raceId, pair.file);
    usedFiles.add(pair.file);
  }
  return result;
}
