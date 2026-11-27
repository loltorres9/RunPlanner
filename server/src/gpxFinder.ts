/**
 * GPX-Suche auf der Website einer Veranstaltung.
 *
 * Ablauf: Startseite laden, dazu bis zu sechs passende Unterseiten derselben Website
 * (z. B. „Strecken“, „Downloads“). Dort alle Links auf GPX-Dateien sammeln, die Dateien
 * laden und auswerten. ZIP-Archive werden ebenfalls geladen und die GPX-Dateien darin
 * einzeln angeboten (Adresse `archiv.zip#datei.gpx`). Links zu Diensten wie Komoot oder Strava lassen sich nicht ohne
 * Anmeldung laden; sie werden nur gemeldet. Die Zuordnung zu den Strecken übernimmt
 * die App (KI oder Distanz), siehe app.ts.
 */

import { parseGpxText, type ExternalRoute, type TrackInput } from '@runplanner/shared';
import { decodeEntities, fetchPage, fetchPublic, fetchPublicBytes, ImportError } from './importer.js';
import { listZip, readZipEntry } from './zip.js';

const MAX_SUBPAGES = 6;
const MAX_FILES = 20;
const MAX_GPX_BYTES = 15 * 1024 * 1024;
const MAX_ZIPS = 3;
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const ZIP_CACHE_MS = 10 * 60 * 1000;

export interface FoundFile {
  url: string;
  fileName: string;
  label: string;
  track: TrackInput;
}

export interface GpxFinder {
  search(websiteUrl: string): Promise<{ files: FoundFile[]; external: ExternalRoute[]; pagesChecked: number }>;
  download(url: string): Promise<TrackInput>;
}

const SERVICES: [RegExp, string][] = [
  [/(^|\.)komoot\.(com|de)$/i, 'Komoot'],
  [/(^|\.)strava\.(com|app\.link)$/i, 'Strava'],
  [/(^|\.)outdooractive\.com$/i, 'Outdooractive'],
  [/(^|\.)alltrails\.com$/i, 'AllTrails'],
  [/(^|\.)ridewithgps\.com$/i, 'Ride with GPS'],
  [/(^|\.)wikiloc\.com$/i, 'Wikiloc'],
  [/(^|\.)garmin\.com$/i, 'Garmin Connect'],
  [/(^|\.)tracedetrail\.(fr|com)$/i, 'Tracedetrail'],
  [/(^|\.)openrunner\.com$/i, 'Openrunner'],
  [/(^|\.)suunto\.com$/i, 'Suunto'],
  [/(^|\.)plotaroute\.com$/i, 'Plotaroute'],
];

/** Unterseiten, auf denen Strecken üblicherweise stehen. */
const SUBPAGE_HINT =
  /gpx|download|strecke|route|course|parcours|percorso|tracc?e|track|distan|karte|map|lauf|läufe|rennen|race|wettkampf|trail|etappe|stage|ultra|marathon|info/i;
const SKIP_FILE = /\.(pdf|jpe?g|png|gif|webp|svg|mp4|mov|docx?|xlsx?|ics|kmz)(\?|#|$)/i;

export interface PageLinks {
  gpx: { url: string; label: string }[];
  zip: { url: string; label: string }[];
  external: ExternalRoute[];
  subpages: { url: string; score: number }[];
}

function isGpxUrl(url: URL): boolean {
  const full = `${url.pathname}${url.search}`.toLowerCase();
  return /\.gpx($|[?#&])/.test(full) || /[?&](format|type|export|download)=gpx\b/.test(full) || /\/gpx\/?$/.test(url.pathname.toLowerCase());
}

function isZipUrl(url: URL): boolean {
  return /\.zip($|[?#&])/.test(`${url.pathname}${url.search}`.toLowerCase());
}

function cleanLabel(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Sammelt GPX-Links, Links zu Routen-Diensten und interessante Unterseiten. */
export function extractLinks(html: string, pageUrl: string): PageLinks {
  const base = new URL(pageUrl);
  const gpx = new Map<string, string>();
  const zip = new Map<string, string>();
  const external = new Map<string, ExternalRoute>();
  const subpages = new Map<string, number>();

  const consider = (href: string, label: string) => {
    let url: URL;
    try {
      url = new URL(decodeEntities(href.trim()), base);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    url.hash = '';
    const key = url.toString();
    if (isGpxUrl(url)) {
      if (!gpx.has(key) || (label && !gpx.get(key))) gpx.set(key, label);
      return;
    }
    if (isZipUrl(url)) {
      if (!zip.has(key) || (label && !zip.get(key))) zip.set(key, label);
      return;
    }
    const service = SERVICES.find(([pattern]) => pattern.test(url.hostname))?.[1];
    if (service) {
      // Nur Links auf eine konkrete Tour/Route, nicht die Startseite des Dienstes.
      if (url.pathname.length > 1 && !external.has(key)) external.set(key, { url: key, service, label });
      return;
    }
    if (url.hostname !== base.hostname || SKIP_FILE.test(url.pathname)) return;
    if (url.pathname === base.pathname && url.search === base.search) return;
    const text = `${label} ${decodeURIComponent(url.pathname)}`;
    if (!SUBPAGE_HINT.test(text)) return;
    const score = /gpx|download/i.test(text) ? 3 : /strecke|route|course|parcours|percorso|track|distan|karte|map/i.test(text) ? 2 : 1;
    subpages.set(key, Math.max(subpages.get(key) ?? 0, score));
  };

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1] ?? '')?.[1];
    if (href) consider(href, cleanLabel(match[2] ?? ''));
  }
  // GPX-Adressen, die nur in Skripten oder Datenattributen stehen (Karten-Widgets).
  for (const match of html.matchAll(/["'(]((?:https?:)?\/?\/?[^"'()\s<>]+\.gpx)(?:\?[^"'()\s<>]*)?["')]/gi)) {
    const href = match[1]!;
    const url = (() => {
      try {
        return new URL(decodeEntities(href), base).toString();
      } catch {
        return null;
      }
    })();
    if (url && !gpx.has(url)) consider(href, '');
  }

  return {
    gpx: [...gpx].map(([url, label]) => ({ url, label })),
    zip: [...zip].map(([url, label]) => ({ url, label })),
    external: [...external.values()],
    subpages: [...subpages].map(([url, score]) => ({ url, score })).sort((a, b) => b.score - a.score),
  };
}

function fileNameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    return last || url;
  } catch {
    return url;
  }
}

const zipCache = new Map<string, { at: number; data: Promise<Buffer> }>();

/** Lädt ein ZIP-Archiv; kurz zwischengespeichert, weil „Übernehmen“ es erneut braucht. */
function downloadZip(url: string): Promise<Buffer> {
  const now = Date.now();
  for (const [key, entry] of zipCache) if (now - entry.at > ZIP_CACHE_MS) zipCache.delete(key);
  const cached = zipCache.get(url);
  if (cached) return cached.data;
  const data = fetchPublicBytes(url, {
    accept: 'application/zip,application/octet-stream,*/*;q=0.5',
    types: /zip|octet-stream|force-download|binary|download/i,
    maxBytes: MAX_ZIP_BYTES,
  }).then((file) => {
    if (file.bytes.length >= MAX_ZIP_BYTES) throw new ImportError('fetch_failed', 'ZIP-Datei ist zu groß');
    return file.bytes;
  });
  data.catch(() => zipCache.delete(url));
  zipCache.set(url, { at: now, data });
  while (zipCache.size > MAX_ZIPS) zipCache.delete(zipCache.keys().next().value!);
  return data;
}

/** GPX-Einträge eines Archivs, ohne macOS-Beiwerk. */
function gpxEntries(data: Buffer) {
  return listZip(data).filter((e) => /\.gpx$/i.test(e.name) && !/(^|\/)(__MACOSX\/|\._)/.test(e.name));
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Alle GPX-Dateien eines Archivs; kaputte werden übersprungen. */
async function filesInZip(url: string, label: string): Promise<FoundFile[]> {
  const data = await downloadZip(url);
  const found: FoundFile[] = [];
  for (const entry of gpxEntries(data).slice(0, MAX_FILES)) {
    try {
      const track = parseGpxText(new TextDecoder().decode(readZipEntry(data, entry, MAX_GPX_BYTES)));
      const fileName = baseName(entry.name);
      found.push({
        url: `${url}#${encodeURIComponent(entry.name)}`,
        fileName,
        label: track.name || fileName.replace(/\.gpx$/i, '') || label,
        track,
      });
    } catch {
      // Kaputte Datei im Archiv: überspringen.
    }
  }
  return found;
}

async function download(url: string): Promise<TrackInput> {
  const hash = url.indexOf('#');
  if (hash > 0 && isZipUrl(new URL(url.slice(0, hash)))) {
    const name = decodeURIComponent(url.slice(hash + 1));
    const data = await downloadZip(url.slice(0, hash));
    const entry = gpxEntries(data).find((e) => e.name === name);
    if (!entry) throw new ImportError('fetch_failed', 'Datei nicht im Archiv gefunden');
    return parseGpxText(new TextDecoder().decode(readZipEntry(data, entry, MAX_GPX_BYTES)));
  }
  return downloadGpx(url);
}

async function downloadGpx(url: string): Promise<TrackInput> {
  const file = await fetchPublic(url, {
    accept: 'application/gpx+xml,application/xml,text/xml,*/*;q=0.5',
    // Viele Server liefern GPX als octet-stream oder text/plain.
    types: /xml|gpx|octet-stream|text\/plain|force-download|binary/i,
    maxBytes: MAX_GPX_BYTES,
  });
  if (file.body.length >= MAX_GPX_BYTES) throw new ImportError('fetch_failed', 'GPX-Datei ist zu groß');
  return parseGpxText(file.body);
}

/** Führt höchstens `limit` Aufgaben gleichzeitig aus. */
async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]!);
      }
    }),
  );
  return results;
}

export function createGpxFinder(): GpxFinder {
  return {
    async search(websiteUrl) {
      const start = await fetchPage(websiteUrl);
      const first = extractLinks(start.html, start.url);
      const pages = [first];
      const subpages = first.subpages.slice(0, MAX_SUBPAGES).map((s) => s.url);
      const loaded = await pool(subpages, 3, async (url) => {
        try {
          const page = await fetchPage(url);
          return extractLinks(page.html, page.url);
        } catch {
          return null;
        }
      });
      for (const links of loaded) if (links) pages.push(links);

      const gpx = new Map<string, string>();
      const zip = new Map<string, string>();
      const external = new Map<string, ExternalRoute>();
      for (const links of pages) {
        for (const link of links.gpx) if (!gpx.get(link.url)) gpx.set(link.url, link.label);
        for (const link of links.zip) if (!zip.get(link.url)) zip.set(link.url, link.label);
        for (const route of links.external) external.set(route.url, route);
      }
      const files = await pool([...gpx].slice(0, MAX_FILES), 4, async ([url, label]): Promise<FoundFile | null> => {
        try {
          const track = await downloadGpx(url);
          return { url, fileName: fileNameOf(url), label: label || track.name || '', track };
        } catch {
          return null;
        }
      });
      const direct = files.filter((f): f is FoundFile => f !== null);
      // Archive, deren Name oder Linktext nach Strecken klingt, zuerst.
      const zips = [...zip]
        .map(([url, label]) => ({ url, label, score: /gpx|strecke|track|route|course|parcours/i.test(`${label} ${url}`) ? 1 : 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_ZIPS);
      const fromZips = (
        await pool(zips, 2, async ({ url, label }) => {
          try {
            return await filesInZip(url, label);
          } catch {
            return [];
          }
        })
      ).flat();
      // Dieselbe Strecke direkt und im Archiv: nur einmal anbieten.
      const sameTrack = (f: FoundFile) => `${f.track.points.length}|${f.track.distanceKm.toFixed(2)}|${f.track.gainM ?? ''}`;
      const seen = new Set(direct.map(sameTrack));
      const unique = fromZips.filter((f) => {
        const key = sameTrack(f);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        files: [...direct, ...unique].slice(0, MAX_FILES),
        external: [...external.values()].slice(0, 10),
        pagesChecked: pages.length,
      };
    },
    download,
  };
}
