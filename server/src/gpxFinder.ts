/**
 * GPX-Suche auf der Website einer Veranstaltung.
 *
 * Ablauf: Startseite laden, dann passende Unterseiten derselben Website (auch
 * Subdomains) in zwei Ebenen, Strecken- und Download-Seiten zuerst. Eingebettete
 * Karten (iframes) werden mit durchsucht. Gesammelt werden Streckendateien (GPX, KML,
 * KMZ, TCX), ZIP-Archive (die Streckendateien darin werden einzeln angeboten, Adresse
 * `archiv.zip#datei.gpx`) und öffentliche Dropbox- oder Google-Drive-Links. Was eine
 * Datei ist, entscheidet ihr Inhalt, nicht die Endung.
 *
 * Links zu Diensten wie Komoot oder Strava lassen sich meist nicht ohne Anmeldung
 * laden; sie werden nur gemeldet. Die Zuordnung zu den Strecken übernimmt die App
 * (KI oder Distanz), siehe app.ts.
 */

import { parseTrackText, type ExternalRoute, type TrackInput } from '@runplanner/shared';
import { decodeEntities, fetchPage, fetchPublicBytes, ImportError } from './importer.js';
import { listZip, readZipEntry } from './zip.js';

/** Seiten insgesamt (mit Startseite und eingebetteten Karten). */
const MAX_PAGES = 15;
const MAX_FIRST_LEVEL = 8;
const MAX_EMBEDS = 3;
const MAX_FILES = 20;
const MAX_DOWNLOADS = 16;
/** Davon höchstens so viele Archive oder Freigabe-Links. */
const MAX_ARCHIVES = 4;
const MAX_TRACK_BYTES = 15 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const CACHE_MS = 10 * 60 * 1000;

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
  /gpx|download|strecke|route|course|parcours|percorso|tracc?e|track|distan|karte|map|lauf|läufe|rennen|race|wettkampf|trail|etappe|stage|ultra|marathon|info|ausschreibung/i;
const STRONG_HINT = /gpx|download|strecke|route|course|parcours|percorso|track|distan|karte|map/i;
const SKIP_FILE = /\.(pdf|jpe?g|png|gif|webp|svg|mp4|mov|docx?|xlsx?|pptx?|ics|zip|gpx|kml|kmz|tcx|css|js)(\?|#|$)/i;
const TRACK_FILE = /\.(gpx|kml|kmz|tcx)($|[?#&])/;
const TRACK_ENTRY = /\.(gpx|kml|tcx)$/i;

export type FileKind = 'track' | 'archive' | 'share';

export interface PageLinks {
  /** Dateien zum Laden: Streckendateien, ZIP-Archive und Freigabe-Links. */
  files: { url: string; label: string; kind: FileKind }[];
  external: ExternalRoute[];
  subpages: { url: string; score: number }[];
  /** Eingebettete Seiten anderer Websites (Karten-Widgets). */
  embeds: string[];
}

/** Website und Subdomains gelten als eine Seite: „anmeldung.xy-trail.de“ gehört zu „xy-trail.de“. */
export function siteOf(hostname: string): string {
  const parts = hostname.toLowerCase().replace(/^www\./, '').split('.');
  // Zweistufige Länderendungen wie co.uk oder com.au.
  const twoLevel = parts.length > 2 && /^(co|com|org|net|ac|gv|or)$/.test(parts[parts.length - 2]!);
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

function sameSite(url: URL, site: string): boolean {
  const host = url.hostname.toLowerCase();
  return host === site || host.endsWith(`.${site}`);
}

function fileKind(url: URL): FileKind | null {
  const full = `${url.pathname}${url.search}`.toLowerCase();
  if (TRACK_FILE.test(full) || /[?&](format|type|export|download)=(gpx|kml|tcx)\b/.test(full) || /\/gpx\/?$/.test(url.pathname.toLowerCase())) {
    return 'track';
  }
  if (/\.zip($|[?#&])/.test(full)) return 'archive';
  return null;
}

/** Öffentliche Freigabe-Links als direkte Download-Adresse, sonst `null`. */
export function directShareUrl(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (/(^|\.)dropbox\.com$/.test(host) && /^\/(s|sh|scl)\//.test(url.pathname)) {
    const direct = new URL(url.toString());
    direct.searchParams.set('dl', '1');
    return direct.toString();
  }
  if (host === 'drive.google.com') {
    const id = /\/file\/d\/([\w-]{10,})/.exec(url.pathname)?.[1] ?? (url.pathname === '/open' ? url.searchParams.get('id') : null);
    if (id && /^[\w-]+$/.test(id)) return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  return null;
}

function cleanLabel(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function attrOf(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1] ?? null;
}

/** Sammelt Dateien, Links zu Routen-Diensten, Unterseiten und eingebettete Karten. */
export function extractLinks(html: string, pageUrl: string, site = siteOf(new URL(pageUrl).hostname)): PageLinks {
  const base = new URL(pageUrl);
  const files = new Map<string, { label: string; kind: FileKind }>();
  const external = new Map<string, ExternalRoute>();
  const subpages = new Map<string, number>();
  const embeds = new Set<string>();

  const resolve = (href: string): URL | null => {
    try {
      const url = new URL(decodeEntities(href.trim()), base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.hash = '';
      return url;
    } catch {
      return null;
    }
  };
  const addFile = (url: string, label: string, kind: FileKind) => {
    const known = files.get(url);
    if (!known || (label && !known.label)) files.set(url, { label, kind });
  };

  const consider = (href: string, label: string) => {
    const url = resolve(href);
    if (!url) return;
    const key = url.toString();
    const share = directShareUrl(url);
    if (share) return addFile(share, label, 'share');
    const kind = fileKind(url);
    if (kind) return addFile(key, label, kind);
    const service = SERVICES.find(([pattern]) => pattern.test(url.hostname))?.[1];
    if (service) {
      // Nur Links auf eine konkrete Tour/Route, nicht die Startseite des Dienstes.
      if (url.pathname.length > 1 && !external.has(key)) external.set(key, { url: key, service, label });
      return;
    }
    if (!sameSite(url, site) || SKIP_FILE.test(url.pathname)) return;
    if (url.pathname === base.pathname && url.search === base.search && url.hostname === base.hostname) return;
    const text = `${label} ${safeDecode(url.pathname)}`;
    if (!SUBPAGE_HINT.test(text)) return;
    const score = /gpx|download/i.test(text) ? 3 : STRONG_HINT.test(text) ? 2 : 1;
    subpages.set(key, Math.max(subpages.get(key) ?? 0, score));
  };

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attrOf(match[1] ?? '', 'href');
    if (href) consider(href, cleanLabel(match[2] ?? ''));
  }
  // Eingebettete Karten: Seite derselben Website wie eine Unterseite, fremde als Einbettung.
  for (const match of html.matchAll(/<iframe\b([^>]*)>/gi)) {
    const src = attrOf(match[1] ?? '', 'src') ?? attrOf(match[1] ?? '', 'data-src');
    const url = src ? resolve(src) : null;
    if (!url) continue;
    // Viele Karten-Widgets tragen die Datei im Parameter, z. B. ?gpx=https%3A%2F%2F…
    const inner = [...safeDecode(url.search).matchAll(/https?:\/\/[^\s"'&<>]+\.(?:gpx|kml|kmz|tcx)\b/gi)];
    for (const found of inner) consider(found[0], '');
    if (inner.length > 0) continue;
    if (fileKind(url) || directShareUrl(url)) consider(url.toString(), '');
    else if (SERVICES.some(([pattern]) => pattern.test(url.hostname))) consider(url.toString(), '');
    else if (sameSite(url, site)) subpages.set(url.toString(), 3);
    else embeds.add(url.toString());
  }
  // Datei-Adressen, die nur in Skripten oder Datenattributen stehen (Karten-Widgets).
  for (const match of html.matchAll(/["'(=]((?:https?:)?\/?\/?[^"'()\s<>=]+\.(?:gpx|kml|kmz|tcx))(?:\?[^"'()\s<>]*)?["')&]/gi)) {
    // Kodierte Adressen (…%2F…) stehen in Parametern und wurden oben schon ausgewertet.
    if (/%2F/i.test(match[1]!)) continue;
    const url = resolve(match[1]!);
    if (url && !files.has(url.toString())) consider(match[1]!, '');
  }

  return {
    files: [...files].map(([url, { label, kind }]) => ({ url, label, kind })),
    external: [...external.values()],
    subpages: [...subpages].map(([url, score]) => ({ url, score })).sort((a, b) => b.score - a.score),
    embeds: [...embeds],
  };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function fileNameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = safeDecode(path.split('/').filter(Boolean).pop() ?? '');
    return last || url;
  } catch {
    return url;
  }
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

const isZip = (data: Buffer) => data.length > 4 && data.readUInt32LE(0) === 0x04034b50;

const cache = new Map<string, { at: number; data: Promise<{ bytes: Buffer; name: string | null }> }>();

/**
 * Lädt eine Datei als Bytes. Archive bleiben kurz im Speicher, weil „Übernehmen“
 * einzelne Einträge daraus erneut braucht.
 */
function fetchFile(url: string, maxBytes: number): Promise<{ bytes: Buffer; name: string | null }> {
  const now = Date.now();
  for (const [key, entry] of cache) if (now - entry.at > CACHE_MS) cache.delete(key);
  const cached = cache.get(url);
  if (cached) return cached.data;
  const data = fetchPublicBytes(url, {
    accept: 'application/gpx+xml,application/vnd.google-earth.kml+xml,application/zip,application/xml,*/*;q=0.5',
    // Viele Server liefern Streckendateien als octet-stream oder text/plain.
    types: /xml|gpx|kml|kmz|tcx|zip|octet-stream|text\/plain|force-download|binary|download|google-earth/i,
    maxBytes,
  }).then((file) => {
    if (file.bytes.length >= maxBytes) throw new ImportError('fetch_failed', 'Datei ist zu groß');
    return { bytes: file.bytes, name: fileNameOf(file.url) };
  });
  data.then(
    (file) => {
      if (!isZip(file.bytes)) cache.delete(url);
    },
    () => cache.delete(url),
  );
  cache.set(url, { at: now, data });
  while (cache.size > MAX_ARCHIVES) cache.delete(cache.keys().next().value!);
  return data;
}

/** Streckendateien eines Archivs (auch KMZ), ohne macOS-Beiwerk. */
function trackEntries(data: Buffer) {
  return listZip(data).filter((e) => TRACK_ENTRY.test(e.name) && !/(^|\/)(__MACOSX\/|\._)/.test(e.name));
}

function readEntry(data: Buffer, entry: ReturnType<typeof trackEntries>[number]): TrackInput {
  return parseTrackText(new TextDecoder().decode(readZipEntry(data, entry, MAX_TRACK_BYTES)));
}

/** Alle Strecken hinter einer Adresse: eine Datei oder die Einträge eines Archivs. */
async function loadFile(url: string, label: string, kind: FileKind): Promise<FoundFile[]> {
  const { bytes, name } = await fetchFile(url, kind === 'track' ? MAX_TRACK_BYTES : MAX_ARCHIVE_BYTES);
  // Bei Freigaben steht der Dateiname erst in der Adresse nach der Weiterleitung.
  const shareName = name && /\.\w{2,4}$/.test(name) ? name : null;
  const fallbackName = kind === 'share' ? shareName || label || url : fileNameOf(url);
  if (!isZip(bytes)) {
    const track = parseTrackText(new TextDecoder().decode(bytes));
    return [{ url, fileName: fallbackName, label: label || track.name || '', track }];
  }
  const entries = trackEntries(bytes);
  const found: FoundFile[] = [];
  for (const entry of entries.slice(0, MAX_FILES)) {
    try {
      const track = readEntry(bytes, entry);
      const fileName = baseName(entry.name);
      // KMZ: ein einziger Eintrag (doc.kml), dann zählt der Name des Archivs.
      const single = entries.length === 1;
      found.push({
        url: `${url}#${encodeURIComponent(entry.name)}`,
        fileName: single ? fallbackName : fileName,
        label: (single ? label : '') || track.name || fileName.replace(TRACK_ENTRY, '') || label,
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
  const fileUrl = hash > 0 ? url.slice(0, hash) : url;
  const { bytes } = await fetchFile(fileUrl, MAX_ARCHIVE_BYTES);
  if (!isZip(bytes)) return parseTrackText(new TextDecoder().decode(bytes));
  const entries = trackEntries(bytes);
  const name = hash > 0 ? safeDecode(url.slice(hash + 1)) : null;
  const entry = name === null ? (entries.length === 1 ? entries[0] : undefined) : entries.find((e) => e.name === name);
  if (!entry) throw new ImportError('fetch_failed', 'Datei nicht im Archiv gefunden');
  return readEntry(bytes, entry);
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

async function loadPages(urls: string[], site: string): Promise<PageLinks[]> {
  const loaded = await pool(urls, 4, async (url) => {
    try {
      const page = await fetchPage(url);
      return extractLinks(page.html, page.url, site);
    } catch {
      return null;
    }
  });
  return loaded.filter((links): links is PageLinks => links !== null);
}

/** Wählt die nächsten Unterseiten: noch nicht besucht, beste Hinweise zuerst. */
function nextPages(pages: PageLinks[], visited: Set<string>, limit: number, minScore: number): string[] {
  const best = new Map<string, number>();
  for (const links of pages) {
    for (const { url, score } of links.subpages) {
      if (visited.has(url) || score < minScore) continue;
      best.set(url, Math.max(best.get(url) ?? 0, score));
    }
  }
  const chosen = [...best].sort((a, b) => b[1] - a[1]).slice(0, Math.max(0, limit)).map(([url]) => url);
  for (const url of chosen) visited.add(url);
  return chosen;
}

/** Gleiche Strecke (z. B. direkt und im Archiv) nur einmal anbieten. */
function sameTrack(f: FoundFile): string {
  return `${f.track.points.length}|${f.track.distanceKm.toFixed(2)}|${f.track.gainM ?? ''}`;
}

export function createGpxFinder(): GpxFinder {
  return {
    async search(websiteUrl) {
      const start = await fetchPage(websiteUrl);
      const site = siteOf(new URL(start.url).hostname);
      const first = extractLinks(start.html, start.url, site);
      const visited = new Set([websiteUrl, start.url]);
      const pages = [first];

      // Ebene 1: die besten Unterseiten der Startseite.
      pages.push(...(await loadPages(nextPages([first], visited, MAX_FIRST_LEVEL, 1), site)));
      // Ebene 2: nur Seiten mit deutlichem Hinweis auf Strecken oder Downloads.
      const embedBudget = Math.min(MAX_EMBEDS, new Set(pages.flatMap((p) => p.embeds)).size);
      pages.push(...(await loadPages(nextPages(pages.slice(1), visited, MAX_PAGES - pages.length - embedBudget, 2), site)));
      // Eingebettete Karten anderer Websites.
      const embeds = [...new Set(pages.flatMap((p) => p.embeds))].filter((url) => !visited.has(url)).slice(0, MAX_EMBEDS);
      for (const url of embeds) visited.add(url);
      pages.push(...(await loadPages(embeds, site)));

      const candidates = new Map<string, { label: string; kind: FileKind }>();
      const external = new Map<string, ExternalRoute>();
      for (const links of pages) {
        for (const file of links.files) {
          const known = candidates.get(file.url);
          if (!known || (file.label && !known.label)) candidates.set(file.url, { label: file.label, kind: file.kind });
        }
        for (const route of links.external) external.set(route.url, route);
      }
      const all = [...candidates].map(([url, { label, kind }]) => ({ url, label, kind }));
      const tracks = all.filter((f) => f.kind === 'track');
      // Archive und Freigaben, deren Name oder Linktext nach Strecken klingt, zuerst.
      const archives = all
        .filter((f) => f.kind !== 'track')
        .map((f) => ({ ...f, score: /gpx|kml|strecke|track|route|course|parcours/i.test(`${f.label} ${f.url}`) ? 1 : 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_ARCHIVES);
      const downloads = [...tracks.slice(0, MAX_DOWNLOADS - archives.length), ...archives];
      const loaded = await pool(downloads, 4, async ({ url, label, kind }) => {
        try {
          return await loadFile(url, label, kind);
        } catch {
          return [];
        }
      });

      const seen = new Set<string>();
      const files = loaded.flat().filter((f) => {
        const key = sameTrack(f);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        files: files.slice(0, MAX_FILES),
        external: [...external.values()].slice(0, 10),
        pagesChecked: pages.length,
      };
    },
    download,
  };
}
