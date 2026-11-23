/**
 * Streckenverläufe aus GPX-Dateien: Kennzahlen, Höhenprofil und Ausdünnen für die
 * Übertragung. Das Einlesen der Datei selbst passiert im Browser.
 */

import { z } from 'zod';

/** Breite, Länge, Höhe in Metern (oder `null`, wenn die Datei keine hat). */
export type TrackPoint = [number, number, number | null];

export interface TrackStats {
  distanceKm: number;
  /** Aufstieg und Abstieg in Metern, `null` ohne Höhendaten. */
  gainM: number | null;
  lossM: number | null;
  minEle: number | null;
  maxEle: number | null;
}

export interface RaceTrack extends TrackStats {
  name: string | null;
  points: TrackPoint[];
}

export const MAX_TRACK_POINTS = 3000;

const point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-500).max(9000).nullable()]);

export const trackInputSchema = z.object({
  name: z.string().trim().max(200).nullish().transform((v) => v || null),
  points: z.array(point).min(2).max(MAX_TRACK_POINTS),
  distanceKm: z.number().min(0).max(1000),
  gainM: z.number().min(0).max(30000).nullable(),
  lossM: z.number().min(0).max(30000).nullable(),
  minEle: z.number().min(-500).max(9000).nullable(),
  maxEle: z.number().min(-500).max(9000).nullable(),
});
export type TrackInput = z.input<typeof trackInputSchema>;

const EARTH_RADIUS_KM = 6371.0088;

/** Entfernung zweier Punkte in Kilometern (Haversine). */
export function distanceKm(a: TrackPoint, b: TrackPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Höhenmeter mit Schwelle: Erst wenn die Höhe um mehr als `threshold` Meter vom letzten
 * Ankerpunkt abweicht, zählt der Unterschied. Das filtert GPS-Rauschen, das sonst bei
 * langen Strecken hunderte Meter zu viel ergibt.
 */
export function trackStats(points: TrackPoint[], threshold = 4): TrackStats {
  let distance = 0;
  for (let i = 1; i < points.length; i++) distance += distanceKm(points[i - 1]!, points[i]!);
  const elevations = points.map((p) => p[2]).filter((e): e is number => e !== null);
  if (elevations.length < 2) return { distanceKm: distance, gainM: null, lossM: null, minEle: null, maxEle: null };
  let gain = 0;
  let loss = 0;
  let anchor = elevations[0]!;
  for (const ele of elevations) {
    const diff = ele - anchor;
    if (diff > threshold) {
      gain += diff;
      anchor = ele;
    } else if (diff < -threshold) {
      loss -= diff;
      anchor = ele;
    }
  }
  return {
    distanceKm: distance,
    gainM: Math.round(gain),
    lossM: Math.round(loss),
    minEle: Math.round(Math.min(...elevations)),
    maxEle: Math.round(Math.max(...elevations)),
  };
}

/** Gleichmäßig ausdünnen; Start und Ziel bleiben immer erhalten. */
export function thinTrack(points: TrackPoint[], max = MAX_TRACK_POINTS): TrackPoint[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

/** Höhenprofil: zurückgelegte Kilometer und Höhe je Punkt (ohne Punkte ohne Höhe). */
export function elevationProfile(points: TrackPoint[]): { km: number; ele: number }[] {
  const profile: { km: number; ele: number }[] = [];
  let km = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) km += distanceKm(points[i - 1]!, points[i]!);
    const ele = points[i]![2];
    if (ele !== null) profile.push({ km, ele });
  }
  return profile;
}
