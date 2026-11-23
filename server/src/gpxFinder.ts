/**
 * GPX-Suche auf der Website einer Veranstaltung.
 *
 * Ablauf: Startseite laden, dazu bis zu sechs passende Unterseiten derselben Website
 * (z. B. „Strecken“, „Downloads“). Dort alle Links auf GPX-Dateien sammeln, die Dateien
 * laden und auswerten. Links zu Diensten wie Komoot oder Strava lassen sich nicht ohne
 * Anmeldung laden; sie werden nur gemeldet. Die Zuordnung zu den Strecken übernimmt
 * die App (KI oder Distanz), siehe app.ts.
 */

import { parseGpxText, type ExternalRoute, type TrackInput } from '@runplanner/shared';
import { decodeEntities, fetchPage, fetchPublic, ImportError } from './importer.js';

const MAX_SUBPAGES = 6;
const MAX_FILES = 12;
const MAX_GPX_BYTES = 15 * 1024 * 1024;

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
const SKIP_FILE = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mov|docx?|xlsx?|ics|kmz)(\?|#|$)/i;

export interface PageLinks {
  gpx: { url: string; label: string }[];
  external: ExternalRoute[];
  subpages: { url: string; score: number }[];
}

function isGpxUrl(url: URL): boolean {
  const full = `${url.pathname}${url.search}`.toLowerCase();
  return /\.gpx($|[?#&])/.test(full) || /[?&](format|type|export|download)=gpx\b/.test(full) || /\/gpx\/?$/.test(url.pathname.toLowerCase());
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
      const external = new Map<string, ExternalRoute>();
      for (const links of pages) {
        for (const link of links.gpx) if (!gpx.get(link.url)) gpx.set(link.url, link.label);
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
      return {
        files: files.filter((f): f is FoundFile => f !== null),
        external: [...external.values()].slice(0, 10),
        pagesChecked: pages.length,
      };
    },
    download: downloadGpx,
  };
}
