/**
 * Auswertungen, die App und Tests gleichermaßen brauchen.
 */

import type { ParticipationStatus, RunEvent, Stay } from './model.js';

export interface PersonCost {
  userId: string;
  userName: string;
  /** Summe aller Startgebühren, für die die Person angemeldet ist oder bezahlt hat. */
  committed: number;
  /** Davon bereits bezahlt. */
  paid: number;
  /** Gebühren der Strecken, für die nur Interesse besteht. */
  planned: number;
  races: number;
}

/**
 * Kosten pro Person über die übergebenen Veranstaltungen. Gruppiert nach Währung wäre
 * genauer, aber Trailläufe der Familie liegen praktisch immer in einer Währung; die
 * App zeigt die Währung der ersten Veranstaltung an.
 */
export function costsPerPerson(events: RunEvent[]): PersonCost[] {
  const byUser = new Map<string, PersonCost>();
  for (const event of events) {
    for (const race of event.races) {
      for (const p of race.participants) {
        let entry = byUser.get(p.userId);
        if (entry === undefined) {
          entry = { userId: p.userId, userName: p.userName, committed: 0, paid: 0, planned: 0, races: 0 };
          byUser.set(p.userId, entry);
        }
        const fee = race.fee ?? 0;
        entry.races += 1;
        addFee(entry, p.status, fee);
      }
    }
  }
  return [...byUser.values()].sort((a, b) => a.userName.localeCompare(b.userName));
}

function addFee(entry: PersonCost, status: ParticipationStatus, fee: number): void {
  if (status === 'interested') entry.planned += fee;
  else entry.committed += fee;
  if (status === 'paid') entry.paid += fee;
}

/** Letzter Tag einer Veranstaltung (Enddatum oder Starttag). */
export function lastDay(event: Pick<RunEvent, 'startDate' | 'endDate'>): string {
  return event.endDate ?? event.startDate;
}

/** Liegt die Veranstaltung ganz oder teilweise am Tag `day` (JJJJ-MM-TT)? */
export function coversDay(event: Pick<RunEvent, 'startDate' | 'endDate'>, day: string): boolean {
  return event.startDate <= day && lastDay(event) >= day;
}

/** Offene Aufgaben einer Veranstaltung, die die App als Hinweis anzeigt. */
export type EventTodo = 'accommodation' | 'deadlineSoon' | 'deadlinePassed';

export function eventTodos(event: RunEvent, today: string, soonDays = 14): EventTodo[] {
  const todos: EventTodo[] = [];
  if (event.accommodationNeeded && lastDay(event) >= today && openStays(event).length > 0) {
    todos.push('accommodation');
  }
  const deadline = event.registrationDeadline;
  const someoneUnregistered = event.races.some((race) =>
    race.participants.some((p) => p.status === 'interested'),
  );
  if (deadline !== null && someoneUnregistered) {
    if (deadline < today) todos.push('deadlinePassed');
    else if (deadline <= addDays(today, soonDays)) todos.push('deadlineSoon');
  }
  return todos;
}

/** Alle Personen, die bei irgendeiner Strecke eingetragen sind. */
export function eventPeople(event: RunEvent): { userId: string; userName: string }[] {
  const seen = new Map<string, string>();
  for (const race of event.races) for (const p of race.participants) seen.set(p.userId, p.userName);
  return [...seen].map(([userId, userName]) => ({ userId, userName }));
}

/**
 * Nächte einer mehrtägigen Veranstaltung, jeweils als der Tag, vor dem die Nacht liegt:
 * eine Nacht vor jedem Veranstaltungstag. Eintägige Veranstaltungen haben keine einzelnen
 * Nächte, dort gibt es nur die Wahl für alles.
 */
export function eventNights(event: Pick<RunEvent, 'startDate' | 'endDate'>): string[] {
  if (event.endDate === null || event.endDate <= event.startDate) return [];
  const nights: string[] = [];
  for (let day = event.startDate; day <= event.endDate && nights.length < 60; day = addDays(day, 1)) nights.push(day);
  return nights;
}

/** Wählt die Person pro Nacht? */
export function staysPerNight(event: RunEvent, userId: string): boolean {
  return event.stays.some((s) => s.userId === userId && s.night !== null);
}

/** Wo die Person in einer Nacht schläft: Wahl für diese Nacht oder für alle Nächte. */
export function stayFor(event: RunEvent, userId: string, night: string | null): Stay | undefined {
  return (
    event.stays.find((s) => s.userId === userId && s.night === night) ??
    event.stays.find((s) => s.userId === userId && s.night === null)
  );
}

export interface OpenStay {
  userId: string;
  userName: string;
  reason: 'undecided' | 'unbooked';
  /** Betroffene Nacht, wenn die Person pro Nacht wählt. */
  night: string | null;
}

/**
 * Wer bei der Unterkunft noch etwas tun muss: Teilnehmende ohne Wahl, und alle, die
 * eine Unterkunft gewählt, aber noch nicht gebucht haben. Wer pro Nacht wählt, wird
 * für jede offene Nacht einzeln gezählt.
 */
export function openStays(event: RunEvent): OpenStay[] {
  const open: OpenStay[] = [];
  const nights = eventNights(event);
  const people = new Map(eventPeople(event).map((p) => [p.userId, p.userName]));
  for (const stay of event.stays) people.set(stay.userId, stay.userName);
  for (const [userId, userName] of people) {
    const perNight = nights.length > 0 && staysPerNight(event, userId);
    for (const night of perNight ? nights : [null]) {
      const stay = event.stays.find((s) => s.userId === userId && s.night === night);
      if (stay === undefined) open.push({ userId, userName, reason: 'undecided', night });
      else if (stay.choice !== 'none' && !stay.booked) {
        open.push({ userId, userName, reason: 'unbooked', night });
      }
    }
  }
  return open;
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
