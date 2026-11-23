import { describe, expect, it } from 'vitest';
import { daysBetween, monthGrid, rangeClick, relativeAgo } from './dates.js';

describe('rangeClick', () => {
  it('setzt Start, dann Ende und schließt', () => {
    expect(rangeClick(null, '2027-06-25')).toEqual({ kind: 'pending', start: '2027-06-25' });
    expect(rangeClick('2027-06-25', '2027-06-27')).toEqual({ kind: 'done', start: '2027-06-25', end: '2027-06-27' });
  });

  it('macht aus zwei Klicks auf denselben Tag eine Eintagesveranstaltung', () => {
    expect(rangeClick('2027-06-25', '2027-06-25')).toEqual({ kind: 'done', start: '2027-06-25', end: null });
  });

  it('nimmt einen früheren zweiten Klick als neuen Start', () => {
    expect(rangeClick('2027-06-25', '2027-06-20')).toEqual({ kind: 'pending', start: '2027-06-20' });
  });
});

describe('daysBetween', () => {
  it('liefert alle Tage, auch über Monatsgrenzen', () => {
    expect(daysBetween('2027-06-29', '2027-07-01')).toEqual(['2027-06-29', '2027-06-30', '2027-07-01']);
    expect(daysBetween('2027-06-29', null)).toEqual(['2027-06-29']);
    expect(daysBetween('', null)).toEqual([]);
  });
});

describe('monthGrid', () => {
  it('beginnt am Montag und deckt ganze Wochen ab', () => {
    const grid = monthGrid('2027-06');
    expect(grid[0]).toBe('2027-05-31');
    expect(grid.length % 7).toBe(0);
    expect(grid).toContain('2027-06-30');
  });
});

describe('relativeAgo', () => {
  it('wählt eine passende Einheit', () => {
    expect(relativeAgo(5 * 60_000)).toEqual({ value: -5, unit: 'minute' });
    expect(relativeAgo(3 * 3_600_000)).toEqual({ value: -3, unit: 'hour' });
    expect(relativeAgo(2 * 86_400_000)).toEqual({ value: -2, unit: 'day' });
    expect(relativeAgo(15 * 86_400_000)).toEqual({ value: -2, unit: 'week' });
    expect(relativeAgo(-1000)).toEqual({ value: -0, unit: 'minute' });
  });
});
