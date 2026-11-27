/**
 * Kalender-Export im iCalendar-Format (RFC 5545).
 *
 * Jede Strecke, bei der man angemeldet ist, wird ein Termin. Die UID hängt nur an der
 * Strecke, deshalb erkennt eine Kalender-App den Termin beim nächsten Abruf oder beim
 * erneuten Import wieder und aktualisiert ihn, statt ihn doppelt anzulegen.
 *
 * Zeiten sind „schwebend“ (ohne Zeitzone): 08:00 bleibt 08:00, egal wo der Kalender
 * steht. Das passt dazu, dass RunPlanner überall ohne Zeitzonen rechnet.
 */

import type { Language } from './model.js';

export interface CalendarEntry {
  raceId: string;
  eventId: string;
  eventName: string;
  raceName: string;
  /** Wie viele Strecken die Veranstaltung hat; bei nur einer reicht der Name der Veranstaltung. */
  raceCount: number;
  location: string | null;
  website: string | null;
  /** Lauftag der Strecke, sonst der erste Tag der Veranstaltung. JJJJ-MM-TT */
  date: string;
  /** Letzter Tag, wenn die Strecke keinen eigenen Tag hat und die Veranstaltung mehrtägig ist. */
  endDate: string | null;
  /** HH:MM oder null für ganztägig. */
  startTime: string | null;
  distanceKm: number | null;
  elevationUpM: number | null;
  cutoff: string | null;
  status: 'registered' | 'paid';
  /** Letzte Änderung (Veranstaltung oder Anmeldung), Millisekunden. */
  updatedAt: number;
}

export interface CalendarOptions {
  /** Name des Kalenders in der Kalender-App. */
  name: string;
  language: Language;
  /** Adresse der App ohne Schrägstrich am Ende, für den Link zurück. */
  appUrl: string;
  now: number;
}

const LABELS = {
  de: {
    status: { registered: 'Angemeldet', paid: 'Angemeldet und bezahlt' },
    distance: 'Distanz',
    up: 'Höhenmeter',
    cutoff: 'Zielschluss',
    website: 'Website',
    open: 'In RunPlanner öffnen',
  },
  en: {
    status: { registered: 'Registered', paid: 'Registered and paid' },
    distance: 'Distance',
    up: 'Elevation gain',
    cutoff: 'Cut-off',
    website: 'Website',
    open: 'Open in RunPlanner',
  },
} as const;

/** Baut die komplette .ics-Datei. Zeilenenden sind CRLF, wie der Standard es verlangt. */
export function buildCalendar(entries: CalendarEntry[], options: CalendarOptions): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RunPlanner//Kalender//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.name)}`,
    // Hinweis an Kalender-Apps, wie oft sie nachsehen sollen.
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.raceId.localeCompare(b.raceId));
  for (const entry of sorted) lines.push(...eventLines(entry, options));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function eventLines(entry: CalendarEntry, options: CalendarOptions): string[] {
  const labels = LABELS[options.language];
  const lines = [
    'BEGIN:VEVENT',
    `UID:${entry.raceId}@runplanner`,
    `DTSTAMP:${utcStamp(options.now)}`,
    `LAST-MODIFIED:${utcStamp(entry.updatedAt)}`,
    // Steigt mit jeder Änderung, damit ein erneuter Import die alte Fassung ersetzt.
    `SEQUENCE:${sequence(entry.updatedAt)}`,
    `SUMMARY:${escapeText(summary(entry))}`,
  ];

  if (entry.startTime !== null) {
    const start = `${compactDate(entry.date)}T${entry.startTime.replace(':', '')}00`;
    lines.push(`DTSTART:${start}`, `DURATION:${formatDuration(durationMinutes(entry))}`);
  } else {
    // Ganztägig: Das Ende ist der Tag nach dem letzten Tag (exklusiv).
    const last = entry.endDate !== null && entry.endDate > entry.date ? entry.endDate : entry.date;
    lines.push(`DTSTART;VALUE=DATE:${compactDate(entry.date)}`, `DTEND;VALUE=DATE:${compactDate(addDays(last, 1))}`);
    lines.push('TRANSP:TRANSPARENT');
  }

  if (entry.location) lines.push(`LOCATION:${escapeText(entry.location)}`);
  const link = `${options.appUrl}/#/event/${encodeURIComponent(entry.eventId)}`;
  lines.push(`URL:${link}`);

  const details: string[] = [labels.status[entry.status]];
  if (entry.distanceKm !== null) details.push(`${labels.distance}: ${formatNumber(entry.distanceKm)} km`);
  if (entry.elevationUpM !== null) details.push(`${labels.up}: ${entry.elevationUpM} m`);
  if (entry.cutoff) details.push(`${labels.cutoff}: ${entry.cutoff}`);
  if (entry.website) details.push(`${labels.website}: ${entry.website}`);
  details.push(`${labels.open}: ${link}`);
  lines.push(`DESCRIPTION:${escapeText(details.join('\n'))}`);

  lines.push('STATUS:CONFIRMED', 'END:VEVENT');
  return lines;
}

function summary(entry: CalendarEntry): string {
  const race = entry.raceName.trim();
  if (entry.raceCount <= 1 && (race === '' || race === entry.eventName.trim())) return entry.eventName;
  const distance = entry.distanceKm !== null && !race.includes('km') ? ` (${formatNumber(entry.distanceKm)} km)` : '';
  return `${entry.eventName} – ${race}${distance}`;
}

/**
 * Dauer eines Termins mit Startzeit: der Zielschluss, wenn er als Stundenangabe lesbar
 * ist („10 h“, „8:30 h“, „12 Std“), sonst eine grobe Schätzung aus Distanz und
 * Höhenmetern. Hauptsache, der Lauf blockiert ungefähr die richtige Zeit.
 */
export function durationMinutes(entry: Pick<CalendarEntry, 'cutoff' | 'distanceKm' | 'elevationUpM'>): number {
  const cutoff = entry.cutoff?.match(/(\d{1,2})(?:[:.,](\d{1,2}))?\s*(?:h\b|std|stunden|hours?)/i);
  if (cutoff) {
    const minutes = Number(cutoff[1]) * 60 + Number(cutoff[2] ?? 0);
    if (minutes > 0 && minutes <= 72 * 60) return minutes;
  }
  if (entry.distanceKm !== null && entry.distanceKm > 0) {
    // Trailtempo: etwa 8 km pro Stunde in der Ebene plus eine Stunde je 600 Höhenmeter.
    const hours = entry.distanceKm / 8 + (entry.elevationUpM ?? 0) / 600;
    return Math.min(48 * 60, Math.max(60, Math.round((hours * 60) / 30) * 30));
  }
  return 120;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `PT${h > 0 ? `${h}H` : ''}${m > 0 || h === 0 ? `${m}M` : ''}`;
}

/** Sekunden seit 2026, damit die Zahl lange klein genug für 32 Bit bleibt. */
function sequence(updatedAt: number): number {
  return Math.max(0, Math.floor((updatedAt - Date.UTC(2026, 0, 1)) / 1000));
}

function formatNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function compactDate(day: string): string {
  return day.replaceAll('-', '');
}

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Sonderzeichen im Text maskieren (RFC 5545, Abschnitt 3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Zeilen über 75 Byte umbrechen; Fortsetzungszeilen beginnen mit einem Leerzeichen. */
export function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
