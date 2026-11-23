import { describe, expect, it } from 'vitest';
import type { RunEvent } from './model.js';
import { addDays, costsPerPerson, coversDay, eventTodos } from './summary.js';

function event(overrides: Partial<RunEvent>): RunEvent {
  return {
    id: 'e',
    groupId: 'g',
    name: 'Lauf',
    location: null,
    startDate: '2027-05-01',
    endDate: null,
    website: null,
    registrationDeadline: null,
    currency: 'EUR',
    accommodationNeeded: false,
    accommodationNotes: null,
    notes: null,
    createdBy: 'u1',
    createdByName: 'Anna',
    createdAt: 0,
    updatedAt: 0,
    races: [],
    accommodations: [],
    stays: [],
    ...overrides,
  };
}

const race = (fee: number | null, participants: RunEvent['races'][number]['participants']) => ({
  id: 'r',
  name: 'R',
  distanceKm: null,
  elevationUpM: null,
  elevationDownM: null,
  startDate: null,
  startTime: null,
  fee,
  feeNote: null,
  cutoff: null,
  participants,
});

describe('costsPerPerson', () => {
  it('trennt angemeldet, bezahlt und geplant', () => {
    const costs = costsPerPerson([
      event({
        races: [
          race(95, [
            { userId: 'a', userName: 'Anna', status: 'paid' },
            { userId: 'b', userName: 'Ben', status: 'interested' },
          ]),
          race(40, [{ userId: 'a', userName: 'Anna', status: 'registered' }]),
          race(null, [{ userId: 'b', userName: 'Ben', status: 'registered' }]),
        ],
      }),
    ]);
    expect(costs).toEqual([
      { userId: 'a', userName: 'Anna', committed: 135, paid: 95, planned: 0, races: 2 },
      { userId: 'b', userName: 'Ben', committed: 0, paid: 0, planned: 95, races: 2 },
    ]);
  });
});

describe('Tage', () => {
  it('rechnet über Monatsgrenzen und mehrtägige Läufe', () => {
    expect(addDays('2027-02-27', 2)).toBe('2027-03-01');
    expect(coversDay(event({ startDate: '2027-05-01', endDate: '2027-05-03' }), '2027-05-02')).toBe(true);
    expect(coversDay(event({ startDate: '2027-05-01' }), '2027-05-02')).toBe(false);
  });
});

describe('eventTodos', () => {
  it('meldet fehlende Unterkunft und nahen Anmeldeschluss', () => {
    const e = event({
      accommodationNeeded: true,
      registrationDeadline: '2027-04-10',
      races: [race(10, [{ userId: 'a', userName: 'Anna', status: 'interested' }])],
    });
    expect(eventTodos(e, '2027-04-01')).toEqual(['accommodation', 'deadlineSoon']);
    expect(eventTodos(e, '2027-04-11')).toEqual(['accommodation', 'deadlinePassed']);
    const booked = { ...e, stays: [{ userId: 'a', userName: 'Anna', choice: 'other' as const, accommodationId: null, otherText: 'Oma', booked: true }] };
    expect(eventTodos(booked, '2027-01-01')).toEqual([]);
    const unbooked = { ...e, stays: [{ ...booked.stays[0]!, booked: false }] };
    expect(eventTodos(unbooked, '2027-01-01')).toEqual(['accommodation']);
    const none = { ...e, stays: [{ ...booked.stays[0]!, choice: 'none' as const, booked: false }] };
    expect(eventTodos(none, '2027-01-01')).toEqual([]);
  });
});
