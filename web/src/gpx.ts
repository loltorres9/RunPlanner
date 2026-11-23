/** GPX-Datei im Browser einlesen: Trackpunkte, sonst Routenpunkte. */

import { thinTrack, trackStats, type TrackInput, type TrackPoint } from '@runplanner/shared';

export class GpxError extends Error {}

export function parseGpx(text: string): TrackInput {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new GpxError('invalid');
  let nodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (nodes.length < 2) nodes = Array.from(doc.getElementsByTagName('rtept'));
  const points: TrackPoint[] = [];
  for (const node of nodes) {
    const lat = Number(node.getAttribute('lat'));
    const lon = Number(node.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const eleText = node.getElementsByTagName('ele')[0]?.textContent;
    const ele = eleText === undefined || eleText === null || eleText.trim() === '' ? null : Number(eleText);
    points.push([lat, lon, ele !== null && Number.isFinite(ele) && ele > -500 && ele < 9000 ? ele : null]);
  }
  if (points.length < 2) throw new GpxError('empty');
  const name =
    doc.getElementsByTagName('trk')[0]?.getElementsByTagName('name')[0]?.textContent?.trim() ||
    doc.getElementsByTagName('metadata')[0]?.getElementsByTagName('name')[0]?.textContent?.trim() ||
    null;
  // Kennzahlen aus allen Punkten, übertragen wird nur eine ausgedünnte Fassung.
  const stats = trackStats(points);
  const thin = thinTrack(points).map(([lat, lon, ele]): TrackPoint => [
    Math.round(lat * 1e6) / 1e6,
    Math.round(lon * 1e6) / 1e6,
    ele === null ? null : Math.round(ele),
  ]);
  return { name: name ? name.slice(0, 200) : null, points: thin, ...stats };
}
