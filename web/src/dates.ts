/** Datumshilfen für Kalender und Datumsdialog. Tage sind Strings JJJJ-MM-TT. */

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** Tage der Monatsansicht, Montag zuerst, inkl. Randtage der Nachbarmonate. */
export function monthGrid(month: string): string[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(y, m - 1, 1 - offset));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Math.ceil((offset + daysInMonth) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** Alle Tage von `start` bis `end` (einschließlich). Höchstens 31, als Schutz vor Unsinn. */
export function daysBetween(start: string, end: string | null): string[] {
  if (!start) return [];
  const last = end && end > start ? end : start;
  const days: string[] = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  while (days.length < 31) {
    const day = cursor.toISOString().slice(0, 10);
    days.push(day);
    if (day >= last) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export interface RangeState {
  /** Gesetzt, solange nach dem ersten Klick das Ende noch fehlt. */
  pending: string | null;
}

export type RangeClick =
  | { kind: 'pending'; start: string }
  | { kind: 'done'; start: string; end: string | null };

/**
 * Logik des Zeitraum-Dialogs: Erster Klick setzt den Start, zweiter Klick das Ende und
 * schließt. Zweimal derselbe Tag ergibt eine Eintagesveranstaltung. Ein zweiter Klick
 * vor dem Start wird zum neuen Start, und der Dialog wartet weiter auf das Ende.
 */
export function rangeClick(pending: string | null, day: string): RangeClick {
  if (pending === null || day < pending) return { kind: 'pending', start: day };
  return { kind: 'done', start: pending, end: day === pending ? null : day };
}

/** Abstand in die Vergangenheit als passende Einheit, für „vor 2 Tagen“. */
export function relativeAgo(diffMs: number): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const minutes = Math.round(Math.max(0, diffMs) / 60_000);
  if (minutes < 60) return { value: -minutes, unit: 'minute' };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { value: -hours, unit: 'hour' };
  const days = Math.round(hours / 24);
  if (days < 7) return { value: -days, unit: 'day' };
  if (days < 30) return { value: -Math.round(days / 7), unit: 'week' };
  if (days < 365) return { value: -Math.round(days / 30), unit: 'month' };
  return { value: -Math.round(days / 365), unit: 'year' };
}
