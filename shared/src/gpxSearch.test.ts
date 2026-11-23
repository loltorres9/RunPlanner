import { describe, expect, it } from 'vitest';
import { GpxParseError, matchByDistance, parseGpxText } from './gpxSearch.js';

const gpx = (body: string) => `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

describe('parseGpxText', () => {
  it('liest Trackpunkte mit Höhe und Namen', () => {
    const track = parseGpxText(
      gpx(`<metadata><name>Meta</name></metadata><trk><name><![CDATA[Ultra 58]]></name><trkseg>
        <trkpt lat="47.0" lon="11.0"><ele>1000</ele></trkpt>
        <trkpt lon="11.01" lat="47.0"><ele>1100.4</ele><time>x</time></trkpt>
        <trkpt lat='47.01' lon='11.01'/>
      </trkseg></trk>`),
    );
    expect(track.name).toBe('Ultra 58');
    expect(track.points).toEqual([
      [47, 11, 1000],
      [47, 11.01, 1100],
      [47.01, 11.01, null],
    ]);
    expect(track.distanceKm).toBeGreaterThan(1.8);
  });

  it('nimmt Routenpunkte, wenn es keinen Track gibt', () => {
    const track = parseGpxText(gpx('<rte><rtept lat="47" lon="11"/><rtept lat="47.1" lon="11"/></rte>'));
    expect(track.points).toHaveLength(2);
    expect(track.name).toBeNull();
  });

  it('lehnt Dateien ohne Punkte oder ohne GPX ab', () => {
    expect(() => parseGpxText(gpx('<trk></trk>'))).toThrow(GpxParseError);
    expect(() => parseGpxText('<html>404</html>')).toThrow(GpxParseError);
  });
});

describe('matchByDistance', () => {
  it('ordnet nach ähnlicher Distanz zu, jede Datei nur einmal', () => {
    const races = [
      { id: 'ultra', name: 'Ultra', distanceKm: 70 },
      { id: 'kurz', name: 'Kurz', distanceKm: 21 },
      { id: 'kids', name: 'Kids', distanceKm: 2 },
      { id: 'ohne', name: 'Ohne', distanceKm: null },
    ];
    const result = matchByDistance(races, [{ distanceKm: 22.3 }, { distanceKm: 68.1 }, { distanceKm: 40 }]);
    expect(Object.fromEntries(result)).toEqual({ ultra: 1, kurz: 0, kids: null, ohne: null });
  });

  it('eine Strecke ohne Distanz und eine Datei passen zusammen', () => {
    expect(matchByDistance([{ id: 'a', name: 'A', distanceKm: null }], [{ distanceKm: 12 }]).get('a')).toBe(0);
  });
});
