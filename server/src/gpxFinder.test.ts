import { describe, expect, it } from 'vitest';
import { directShareUrl, extractLinks, siteOf } from './gpxFinder.js';

describe('extractLinks', () => {
  it('findet GPX-Links, Routen-Dienste und passende Unterseiten', () => {
    const html = `
      <a href="/files/ultra_70k.gpx">Ultra &amp; Co</a>
      <a href="https://cdn.example.org/dl.php?id=3&amp;format=gpx"><span>Kurz</span> GPX</a>
      <a href="https://www.komoot.com/de-de/tour/12345">Strecke auf Komoot</a>
      <a href="https://www.komoot.com/">Komoot</a>
      <a href="/strecken">Strecken</a>
      <a href="/downloads">Downloads</a>
      <a href="/impressum">Impressum</a>
      <a href="https://other.org/strecken">fremd</a>
      <a href="/flyer.pdf">Download Flyer</a>
      <a href="mailto:x@y.de">Mail</a>
      <div data-track="/maps/marathon.gpx"></div>`;
    const links = extractLinks(html, 'https://lauf.example.org/');
    expect(links.files).toEqual([
      { url: 'https://lauf.example.org/files/ultra_70k.gpx', label: 'Ultra & Co', kind: 'track' },
      { url: 'https://cdn.example.org/dl.php?id=3&format=gpx', label: 'Kurz GPX', kind: 'track' },
      { url: 'https://lauf.example.org/maps/marathon.gpx', label: '', kind: 'track' },
    ]);
    expect(links.external).toEqual([
      { url: 'https://www.komoot.com/de-de/tour/12345', service: 'Komoot', label: 'Strecke auf Komoot' },
    ]);
    expect(links.subpages.map((s) => s.url)).toEqual(['https://lauf.example.org/downloads', 'https://lauf.example.org/strecken']);
  });
});

describe('createGpxFinder', () => {
  const gpx = (km: number) =>
    `<gpx><trk><name>Strecke ${km}</name><trkseg><trkpt lat="47" lon="11"><ele>500</ele></trkpt>` +
    `<trkpt lat="${47 + km / 111.2}" lon="11"><ele>900</ele></trkpt></trkseg></trk></gpx>`;
  // Öffentliche IP-Adresse, damit keine DNS-Abfrage nötig ist.
  const site = 'http://93.184.216.34';
  const pages: Record<string, { type: string; body: string }> = {
    '/': { type: 'text/html', body: '<a href="/strecken">Strecken</a><a href="https://komoot.com/tour/9">Komoot</a>' },
    '/strecken': {
      type: 'text/html; charset=utf-8',
      body: '<a href="/dl/ultra.gpx">Ultra</a><a href="/dl/kurz.gpx">Kurz</a><a href="/dl/kaputt.gpx">Kaputt</a>',
    },
    '/dl/ultra.gpx': { type: 'application/gpx+xml', body: gpx(70) },
    '/dl/kurz.gpx': { type: 'application/octet-stream', body: gpx(21) },
    '/dl/kaputt.gpx': { type: 'text/html', body: '<html>404</html>' },
  };

  it('durchsucht Unterseiten, lädt GPX-Dateien und überspringt kaputte', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const page = pages[new URL(String(input)).pathname];
      if (!page) return new Response('not found', { status: 404 });
      return new Response(page.body, { status: 200, headers: { 'content-type': page.type } });
    }) as typeof fetch;
    try {
      const { createGpxFinder } = await import('./gpxFinder.js');
      const result = await createGpxFinder().search(`${site}/`);
      expect(result.pagesChecked).toBe(2);
      expect(result.files.map((f) => [f.fileName, f.label, Math.round(f.track.distanceKm)])).toEqual([
        ['ultra.gpx', 'Ultra', 70],
        ['kurz.gpx', 'Kurz', 21],
      ]);
      expect(result.external.map((e) => e.service)).toEqual(['Komoot']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/** Baut ein kleines ZIP-Archiv (deflate) für die Tests. */
function makeZip(files: Record<string, string>): Buffer {
  const { deflateRawSync, crc32 } = require('node:zlib') as typeof import('node:zlib');
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const packed = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('GPX in ZIP-Archiven', () => {
  const gpx = (name: string, km: number) =>
    `<gpx><trk><name>${name}</name><trkseg><trkpt lat="48" lon="9"><ele>300</ele></trkpt>` +
    `<trkpt lat="${48 + km / 111.2}" lon="9"><ele>500</ele></trkpt></trkseg></trk></gpx>`;
  const site = 'http://93.184.216.34';
  const archive = makeZip({
    'Strecken/': '',
    'Strecken/Trail 12 km.gpx': gpx('Trail 12', 12),
    'Strecken/Trail 24 km.gpx': gpx('', 24),
    'Strecken/kaputt.gpx': '<html>nope</html>',
    '__MACOSX/Strecken/._Trail 12 km.gpx': 'x',
    'Strecken/info.pdf': 'pdf',
  });
  const responses: Record<string, () => Response> = {
    '/': () => new Response('<a href="/files/gpx-alle.zip">Alle GPX (ZIP)</a><a href="/dl/12.gpx">12 km</a>', {
      headers: { 'content-type': 'text/html' },
    }),
    '/dl/12.gpx': () => new Response(gpx('Trail 12', 12), { headers: { 'content-type': 'application/gpx+xml' } }),
    '/files/gpx-alle.zip': () => new Response(archive, { headers: { 'content-type': 'application/zip' } }),
  };

  it('findet ZIP-Links, entpackt die GPX-Dateien und lädt einzelne Einträge', async () => {
    const original = globalThis.fetch;
    let zipLoads = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('.zip')) zipLoads += 1;
      return responses[path]?.() ?? new Response('not found', { status: 404 });
    }) as typeof fetch;
    try {
      expect(extractLinks('<a href="/a.zip?x=1">ZIP</a>', `${site}/`).files).toEqual([
        { url: `${site}/a.zip?x=1`, label: 'ZIP', kind: 'archive' },
      ]);
      const { createGpxFinder } = await import('./gpxFinder.js');
      const finder = createGpxFinder();
      const result = await finder.search(`${site}/`);
      // Die 12 km gibt es direkt und im Archiv; sie erscheinen nur einmal.
      expect(result.files.map((f) => [f.fileName, f.label, Math.round(f.track.distanceKm)])).toEqual([
        ['12.gpx', '12 km', 12],
        ['Trail 24 km.gpx', 'Trail 24 km', 24],
      ]);
      const entry = result.files.find((f) => f.fileName === 'Trail 24 km.gpx')!;
      expect(entry.url).toBe(`${site}/files/gpx-alle.zip#${encodeURIComponent('Strecken/Trail 24 km.gpx')}`);
      const track = await finder.download(entry.url);
      expect(Math.round(track.distanceKm)).toBe(24);
      expect(zipLoads).toBe(1);
      await expect(finder.download(`${site}/files/gpx-alle.zip#fehlt.gpx`)).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('weitergehende Suche', () => {
  it('erkennt Subdomains, Freigabe-Links und Dateien in eingebetteten Karten', () => {
    expect(siteOf('www.xy-trail.de')).toBe('xy-trail.de');
    expect(siteOf('anmeldung.xy-trail.de')).toBe('xy-trail.de');
    expect(siteOf('race.example.co.uk')).toBe('example.co.uk');
    expect(directShareUrl(new URL('https://www.dropbox.com/scl/fi/abc/Ultra.gpx?rlkey=x&dl=0'))).toBe(
      'https://www.dropbox.com/scl/fi/abc/Ultra.gpx?rlkey=x&dl=1',
    );
    expect(directShareUrl(new URL('https://drive.google.com/file/d/1AbCdEfGhIjK_lm/view?usp=sharing'))).toBe(
      'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjK_lm',
    );
    expect(directShareUrl(new URL('https://drive.google.com/drive/folders/1AbC'))).toBeNull();

    const html = `
      <a href="https://anmeldung.xy-trail.de/strecken">Strecken</a>
      <a href="https://fremd.de/strecken">Strecken</a>
      <a href="https://www.dropbox.com/s/abc/strecken.zip?dl=0">Alle Strecken</a>
      <a href="/files/kurz.kml">KML</a>
      <iframe src="https://maps.example.net/viewer?gpx=https%3A%2F%2Fcdn.xy-trail.de%2Fultra.gpx"></iframe>
      <iframe data-src="/karte/embed"></iframe>
      <iframe src="https://widgets.example.net/map/42"></iframe>`;
    const links = extractLinks(html, 'https://www.xy-trail.de/');
    expect(links.files).toEqual([
      { url: 'https://www.dropbox.com/s/abc/strecken.zip?dl=1', label: 'Alle Strecken', kind: 'share' },
      { url: 'https://www.xy-trail.de/files/kurz.kml', label: 'KML', kind: 'track' },
      { url: 'https://cdn.xy-trail.de/ultra.gpx', label: '', kind: 'track' },
    ]);
    expect(links.subpages.map((s) => s.url).sort()).toEqual([
      'https://anmeldung.xy-trail.de/strecken',
      'https://www.xy-trail.de/karte/embed',
    ]);
    // Der Viewer mit der Datei im Parameter muss nicht mehr geladen werden.
    expect(links.embeds).toEqual(['https://widgets.example.net/map/42']);
  });

  it('sucht zwei Ebenen tief und liest KML, TCX und KMZ', async () => {
    const site = 'http://93.184.216.34';
    const kml = `<kml><Document><name>Doc</name><Placemark><name>Kurz KML</name><LineString><coordinates>
      9.0,48.0,300 9.0,48.09,420</coordinates></LineString></Placemark></Document></kml>`;
    const tcx = `<TrainingCenterDatabase><Courses><Course><Name>Lang TCX</Name><Track>
      <Trackpoint><Position><LatitudeDegrees>48</LatitudeDegrees><LongitudeDegrees>9</LongitudeDegrees></Position><AltitudeMeters>300</AltitudeMeters></Trackpoint>
      <Trackpoint><Position><LatitudeDegrees>48.3</LatitudeDegrees><LongitudeDegrees>9</LongitudeDegrees></Position><AltitudeMeters>700</AltitudeMeters></Trackpoint>
      </Track></Course></Courses></TrainingCenterDatabase>`;
    const kmz = makeZip({ 'doc.kml': kml.replace('Kurz KML', 'Mittel KMZ').replace('48.09', '48.2') });
    const pages: Record<string, () => Response> = {
      '/': () => html('<a href="/info">Infos</a>'),
      '/info': () => html('<a href="/info/strecken">Strecken</a><a href="/impressum">Impressum</a>'),
      '/info/strecken': () =>
        html('<a href="/dl/kurz.kml">Kurz</a><a href="/dl/lang.tcx">Lang</a><a href="/dl/mittel.kmz">Mittel</a>'),
      '/dl/kurz.kml': () => new Response(kml, { headers: { 'content-type': 'application/vnd.google-earth.kml+xml' } }),
      '/dl/lang.tcx': () => new Response(tcx, { headers: { 'content-type': 'application/octet-stream' } }),
      '/dl/mittel.kmz': () => new Response(kmz, { headers: { 'content-type': 'application/vnd.google-earth.kmz' } }),
    };
    function html(body: string) {
      return new Response(body, { headers: { 'content-type': 'text/html' } });
    }
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) =>
      pages[new URL(String(input)).pathname]?.() ?? new Response('not found', { status: 404 })) as typeof fetch;
    try {
      const { createGpxFinder } = await import('./gpxFinder.js');
      const finder = createGpxFinder();
      const result = await finder.search(`${site}/`);
      expect(result.pagesChecked).toBe(3);
      expect(result.files.map((f) => [f.fileName, f.label, Math.round(f.track.distanceKm)])).toEqual([
        ['kurz.kml', 'Kurz', 10],
        ['lang.tcx', 'Lang', 33],
        ['mittel.kmz', 'Mittel', 22],
      ]);
      expect(result.files[1]!.track.gainM).toBe(400);
      const kmzTrack = await finder.download(result.files[2]!.url);
      expect(kmzTrack.name).toBe('Mittel KMZ');
    } finally {
      globalThis.fetch = original;
    }
  });
});
