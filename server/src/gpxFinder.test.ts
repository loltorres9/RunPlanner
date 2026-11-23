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
