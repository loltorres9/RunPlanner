import { describe, expect, it } from 'vitest';
import { buildCalendar, durationMinutes, escapeText, fold, type CalendarEntry } from './ical.js';

const base: CalendarEntry = {
  raceId: 'r1',
  eventId: 'e1',
  eventName: 'Zugspitz Ultratrail',
  raceName: 'Basetrail',
  raceCount: 3,
  location: 'Grainau, Bayern',
  website: 'https://example.org',
  date: '2027-06-18',
  endDate: null,
  startTime: '08:30',
  distanceKm: 43,
  elevationUpM: 2400,
  cutoff: '10 h',
  status: 'registered',
  updatedAt: Date.UTC(2026, 10, 27, 12),
};
const options = { name: 'RunPlanner – Pascal', language: 'de' as const, appUrl: 'https://rp.example', now: Date.UTC(2026, 10, 27, 15) };

describe('buildCalendar', () => {
  it('erzeugt einen Termin mit fester UID und schwebender Startzeit', () => {
    const ics = buildCalendar([base], options);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('UID:r1@runplanner\r\n');
    expect(ics).toContain('DTSTART:20270618T083000\r\n');
    expect(ics).toContain('DURATION:PT10H\r\n');
    expect(ics).toContain('SUMMARY:Zugspitz Ultratrail – Basetrail (43 km)\r\n');
    expect(ics).toContain('LOCATION:Grainau\\, Bayern\r\n');
    expect(ics).toContain('URL:https://rp.example/#/event/e1\r\n');
    // Keine Zeile länger als 75 Byte.
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it('bleibt bei gleichem Stand gleich, bis auf den Zeitstempel', () => {
    const a = buildCalendar([base], options).replace(/DTSTAMP:.*\r\n/g, '');
    const b = buildCalendar([base], { ...options, now: options.now + 3600_000 }).replace(/DTSTAMP:.*\r\n/g, '');
    expect(a).toBe(b);
  });

  it('erhöht SEQUENCE bei einer Änderung', () => {
    const seq = (ics: string) => Number(/SEQUENCE:(\d+)/.exec(ics)?.[1]);
    const before = seq(buildCalendar([base], options));
    const after = seq(buildCalendar([{ ...base, updatedAt: base.updatedAt + 60_000 }], options));
    expect(after).toBeGreaterThan(before);
  });

  it('macht ohne Startzeit einen ganztägigen Termin über alle Tage', () => {
    const ics = buildCalendar([{ ...base, startTime: null, endDate: '2027-06-20', raceCount: 1, raceName: 'Zugspitz Ultratrail' }], options);
    expect(ics).toContain('DTSTART;VALUE=DATE:20270618\r\n');
    expect(ics).toContain('DTEND;VALUE=DATE:20270621\r\n');
    expect(ics).toContain('SUMMARY:Zugspitz Ultratrail\r\n');
  });

  it('beschriftet auf Englisch', () => {
    const ics = buildCalendar([{ ...base, status: 'paid' }], { ...options, language: 'en' }).replace(/\r\n /g, '');
    expect(ics).toContain('DESCRIPTION:Registered and paid\\nDistance: 43 km');
  });
});

describe('Hilfen', () => {
  it('maskiert Sonderzeichen', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('bricht lange Zeilen um, ohne Umlaute zu zerreißen', () => {
    const line = `SUMMARY:${'ü'.repeat(60)}`;
    const folded = fold(line);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    for (const part of folded.split('\r\n')) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
  });

  it('nimmt den Zielschluss als Dauer oder schätzt', () => {
    expect(durationMinutes({ cutoff: '8:30 h', distanceKm: null, elevationUpM: null })).toBe(510);
    expect(durationMinutes({ cutoff: '12 Std.', distanceKm: null, elevationUpM: null })).toBe(720);
    expect(durationMinutes({ cutoff: null, distanceKm: 24, elevationUpM: 1200 })).toBe(300);
    expect(durationMinutes({ cutoff: null, distanceKm: null, elevationUpM: null })).toBe(120);
  });
});
