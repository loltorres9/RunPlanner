/**
 * Datenmodell, das Server und App gemeinsam benutzen.
 *
 * Eingaben werden mit zod geprüft: Der Server validiert damit jede Anfrage, die App
 * benutzt dieselben Typen. Daten (Tage) sind bewusst Zeichenketten im Format
 * JJJJ-MM-TT und Startzeiten HH:MM — eine Veranstaltung findet an einem Ort statt,
 * Zeitzonen würden hier nur Fehler erzeugen.
 */

import { z } from 'zod';

export const LANGUAGES = ['de', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

export const PARTICIPATION_STATUSES = ['interested', 'registered', 'paid'] as const;
export type ParticipationStatus = (typeof PARTICIPATION_STATUSES)[number];

export const GROUP_ROLES = ['admin', 'member'] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value));

export const raceInputSchema = z.object({
  /** Vorhandene Strecke beim Bearbeiten; fehlt bei neuen. */
  id: z.string().nullish(),
  name: z.string().trim().min(1).max(120),
  distanceKm: z.number().min(0).max(1000).nullish(),
  elevationUpM: z.number().int().min(0).max(30000).nullish(),
  elevationDownM: z.number().int().min(0).max(30000).nullish(),
  /** Tag des Starts, falls die Veranstaltung mehrere Tage dauert. */
  startDate: isoDate.nullish(),
  startTime: time.nullish(),
  fee: z.number().min(0).max(100000).nullish(),
  /** z. B. "Frühbucher bis 31.01.: 45 €" */
  feeNote: optionalText(300),
  /** Zielschluss oder Zeitlimit als Text, z. B. "8 h" oder "Zielschluss 18:00". */
  cutoff: optionalText(120),
});
export type RaceInput = z.input<typeof raceInputSchema>;

export const eventInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    location: optionalText(200),
    startDate: isoDate,
    endDate: isoDate.nullish(),
    website: z
      .string()
      .trim()
      .max(500)
      .nullish()
      .transform((value) => (value === undefined || value === null || value === '' ? null : value))
      .refine((value) => value === null || /^https?:\/\//i.test(value), 'Website muss mit http(s):// beginnen'),
    registrationDeadline: isoDate.nullish(),
    currency: z.string().trim().length(3).default('EUR'),
    accommodationNeeded: z.boolean().default(false),
    accommodationNotes: optionalText(2000),
    notes: optionalText(5000),
    races: z.array(raceInputSchema).max(30).default([]),
  })
  .refine((event) => !event.endDate || event.endDate >= event.startDate, {
    message: 'Enddatum liegt vor dem Startdatum',
    path: ['endDate'],
  })
  .superRefine((event, ctx) => {
    const last = event.endDate ?? event.startDate;
    event.races.forEach((race, index) => {
      if (race.startDate && (race.startDate < event.startDate || race.startDate > last)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Starttag der Strecke liegt außerhalb der Veranstaltung',
          path: ['races', index, 'startDate'],
        });
      }
    });
  });
export type EventInput = z.input<typeof eventInputSchema>;
export type EventInputParsed = z.output<typeof eventInputSchema>;

export interface Participation {
  userId: string;
  userName: string;
  status: ParticipationStatus;
}

export interface Race {
  id: string;
  name: string;
  distanceKm: number | null;
  elevationUpM: number | null;
  elevationDownM: number | null;
  startDate: string | null;
  startTime: string | null;
  fee: number | null;
  feeNote: string | null;
  cutoff: string | null;
  participants: Participation[];
}

export interface RunEvent {
  id: string;
  groupId: string;
  name: string;
  location: string | null;
  startDate: string;
  endDate: string | null;
  website: string | null;
  registrationDeadline: string | null;
  currency: string;
  accommodationNeeded: boolean;
  accommodationNotes: string | null;
  notes: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
  races: Race[];
  /** Vorgeschlagene Unterkünfte. */
  accommodations: Accommodation[];
  /** Wer wo übernachtet. */
  stays: Stay[];
}

export const STAY_CHOICES = ['none', 'suggested', 'other'] as const;
export type StayChoice = (typeof STAY_CHOICES)[number];

export const accommodationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value))
    .refine((value) => value === null || /^https?:\/\//i.test(value), 'Link muss mit http(s):// beginnen'),
  /** Freitext, z. B. "ca. 90 € pro Nacht". */
  price: optionalText(120),
  notes: optionalText(1000),
  /** Nächte, für die der Vorschlag gedacht ist (Etappenorte); leer heißt alle. */
  nights: z.array(isoDate).max(60).default([]),
});
export type AccommodationInput = z.input<typeof accommodationInputSchema>;

export const stayInputSchema = z
  .object({
    /** Nacht (Tag, vor dem sie liegt) oder `null` für eine Wahl für alle Nächte. */
    night: isoDate.nullish(),
    choice: z.enum(STAY_CHOICES),
    accommodationId: z.string().nullish(),
    otherText: optionalText(300),
    booked: z.boolean().default(false),
  })
  .refine((stay) => stay.choice !== 'suggested' || !!stay.accommodationId, {
    message: 'Bitte eine Unterkunft wählen',
    path: ['accommodationId'],
  });
export type StayInput = z.input<typeof stayInputSchema>;

export interface Accommodation {
  id: string;
  name: string;
  url: string | null;
  price: string | null;
  notes: string | null;
  /** Nächte, für die der Vorschlag gedacht ist; leer heißt alle. */
  nights: string[];
  createdBy: string;
}

/**
 * Eine Übernachtungswahl. Mit `night: null` gilt sie für alle Nächte; bei mehrtägigen
 * Veranstaltungen kann eine Person stattdessen pro Nacht wählen (`night` = der Lauftag,
 * vor dem die Nacht liegt). Beides zugleich gibt es nicht.
 */
export interface Stay {
  userId: string;
  userName: string;
  night: string | null;
  choice: StayChoice;
  accommodationId: string | null;
  otherText: string | null;
  booked: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  language: Language;
}

export interface GroupSummary {
  id: string;
  name: string;
  role: GroupRole;
}

export interface GroupMember {
  userId: string;
  name: string;
  role: GroupRole;
}

export interface GroupDetail extends GroupSummary {
  inviteCode: string;
  members: GroupMember[];
}

export interface Me {
  user: User;
  groups: GroupSummary[];
}

/** Was der Import von einer Website liefert: ein Entwurf, den man vor dem Speichern prüft. */
export interface ImportResult {
  draft: EventInput;
  /** Hinweise des Imports, z. B. "Gebühren nicht gefunden". */
  warnings: string[];
}
