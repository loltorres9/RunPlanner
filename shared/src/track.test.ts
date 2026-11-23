import { describe, expect, it } from 'vitest';
import { distanceKm, elevationProfile, thinTrack, trackStats, type TrackPoint } from './track.js';

describe('Streckenverlauf', () => {
  it('misst Distanz und Höhenmeter mit Rauschfilter', () => {
    // Ein Breitengrad sind gut 111 km.
    expect(distanceKm([47, 11, null], [48, 11, null])).toBeCloseTo(111.2, 0);
    const points: TrackPoint[] = [
      [47, 11, 1000],
      [47.001, 11, 1002], // Rauschen
      [47.002, 11, 1000],
      [47.003, 11, 1100],
      [47.004, 11, 1050],
    ];
    const stats = trackStats(points);
    expect(stats.gainM).toBe(100);
    expect(stats.lossM).toBe(50);
    expect(stats.minEle).toBe(1000);
    expect(stats.maxEle).toBe(1100);
    expect(stats.distanceKm).toBeCloseTo(0.445, 2);
    expect(trackStats([[47, 11, null], [47.1, 11, null]]).gainM).toBe(null);
  });

  it('dünnt aus und behält Start und Ziel', () => {
    const many: TrackPoint[] = Array.from({ length: 10_001 }, (_, i) => [47 + i / 1e5, 11, i]);
    const thin = thinTrack(many, 100);
    expect(thin).toHaveLength(100);
    expect(thin[0]).toEqual(many[0]);
    expect(thin[99]).toEqual(many[10_000]);
    expect(elevationProfile(thin.slice(0, 2))[1]!.km).toBeGreaterThan(0);
  });
});
