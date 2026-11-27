import { describe, expect, it } from 'vitest';
import { extractLinks } from './gpxFinder.js';

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
    expect(links.gpx).toEqual([
      { url: 'https://lauf.example.org/files/ultra_70k.gpx', label: 'Ultra & Co' },
      { url: 'https://cdn.example.org/dl.php?id=3&format=gpx', label: 'Kurz GPX' },
      { url: 'https://lauf.example.org/maps/marathon.gpx', label: '' },
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
      expect(extractLinks('<a href="/a.zip?x=1">ZIP</a>', `${site}/`).zip).toEqual([{ url: `${site}/a.zip?x=1`, label: 'ZIP' }]);
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
