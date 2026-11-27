/**
 * Die HTTP-API.
 *
 * Rechte sind einfach gehalten: Wer in einer Laufgruppe ist, darf dort Veranstaltungen
 * anlegen und bearbeiten. Löschen dürfen die Person, die sie angelegt hat, und die
 * Admins der Gruppe. Die eigene Teilnahme setzt jeder nur für sich selbst.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  accommodationInputSchema,
  buildCalendar,
  type CalendarEntry,
  eventInputSchema,
  eventNights,
  trackInputSchema,
  gpxApplySchema,
  matchByDistance,
  type GpxSearchResult,
  type TrackInput,
  commentInputSchema,
  expenseInputSchema,
  settlementInputSchema,
  type Expense,
  type Settlement,
  type EventComment,
  notificationSettingsSchema,
  stayInputSchema,
  type Accommodation,
  type Stay,
  GROUP_ROLES,
  LANGUAGES,
  participationInputSchema,
  teamInputSchema,
  splitEqually,
  type ParticipationStatus,
  type RaceTeam,
  type EventInputParsed,
  type GroupDetail,
  type GroupRole,
  type Language,
  type Me,
  type Race,
  type RunEvent,
} from '@runplanner/shared';
import { z } from 'zod';
import {
  checkPassword,
  hashPassword,
  newCalendarToken,
  newId,
  hashResetCode,
  newInviteCode,
  newResetCode,
  signToken,
  Throttle,
  TOKEN_TTL_MS,
  verifyToken,
} from './auth.js';
import { migrate, type Db } from './db.js';
import { createGpxFinder, type GpxFinder } from './gpxFinder.js';
import { ImportError, type Importer } from './importer.js';
import { notifyComment, notifyNewEvent, type PushSender } from './push.js';

export interface AppOptions {
  db: Db;
  tokenSecret: string;
  /** Fehlt er, ist der Website-Import abgeschaltet. */
  importer?: Importer | null;
  logger?: boolean;
  now?: () => number;
  /** Höchstzahl Importe pro Person und Stunde. Begrenzt die API-Kosten. */
  importsPerHour?: number;
  /** Fehlt er, gibt es keine Push-Benachrichtigungen. */
  push?: PushSender | null;
  /** GPX-Suche auf Websites; in Tests ersetzbar. */
  gpxFinder?: GpxFinder;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200),
  language: z.enum(LANGUAGES).default('de'),
  inviteCode: z.string().trim().max(64).nullish(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(200),
  password: z.string().max(200),
});

const profileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  language: z.enum(LANGUAGES).optional(),
  notifications: notificationSettingsSchema.optional(),
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000).refine((url) => url.startsWith('https://'), 'Ungültiger Push-Endpunkt'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

const passwordSchema = z.object({
  currentPassword: z.string().max(200),
  newPassword: z.string().min(8).max(200),
});

const stayModeSchema = z.object({ perNight: z.boolean() });
const resetSchema = z.object({ password: z.string().min(8).max(200) });
/** Reset-Links gelten zwei Tage. */
const RESET_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const groupSchema = z.object({ name: z.string().trim().min(1).max(80) });
const roleSchema = z.object({ role: z.enum(GROUP_ROLES) });
const importSchema = z.object({ url: z.string().trim().min(4).max(2000), language: z.enum(LANGUAGES).optional() });
const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Nächte eines Vorschlags, sortiert und ohne Doppelte, als Text für die Datenbank. */
function joinNights(nights: string[]): string {
  return [...new Set(nights)].sort().join(',');
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join('.') ?? '';
    throw new HttpError(400, 'invalid_input', `${where ? `${where}: ` : ''}${first?.message ?? 'Ungültige Eingabe'}`);
  }
  return result.data;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  language: Language;
  token_epoch: number;
  notify_new_event: boolean;
  notify_deadline_days: number;
  notify_event_days: number;
  notify_comments: boolean;
}

interface EventRow {
  id: string;
  group_id: string;
  name: string;
  location: string | null;
  start_date: string;
  end_date: string | null;
  website: string | null;
  registration_deadline: string | null;
  currency: string;
  accommodation_needed: boolean;
  accommodation_notes: string | null;
  notes: string | null;
  created_by: string;
  created_by_name: string;
  created_at: number;
  updated_at: number;
}

interface RaceRow {
  id: string;
  event_id: string;
  name: string;
  distance_km: number | null;
  elevation_up_m: number | null;
  elevation_down_m: number | null;
  start_date: string | null;
  start_time: string | null;
  fee: number | null;
  fee_note: string | null;
  cutoff: string | null;
  team_size: number | null;
  itra_points: number | null;
}

interface ParticipationRow {
  race_id: string;
  user_id: string;
  user_name: string;
  status: Race['participants'][number]['status'];
  team_id: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { db, tokenSecret } = options;
  const now = options.now ?? (() => Date.now());
  const importer = options.importer ?? null;
  const push = options.push ?? null;
  const gpxFinder = options.gpxFinder ?? createGpxFinder();
  const loginThrottle = new Throttle(10, 15 * 60 * 1000);
  const importThrottle = new Throttle(options.importsPerHour ?? 30, 60 * 60 * 1000);

  await migrate(db);

  const app = Fastify({ logger: options.logger ?? false, trustProxy: true, bodyLimit: 512 * 1024 });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'internal', message: 'Interner Fehler' });
  });

  // ------------------------------------------------------------------ Hilfen

  function issueToken(user: Pick<UserRow, 'id' | 'token_epoch'>): string {
    return signToken({ sub: user.id, epoch: user.token_epoch, exp: now() + TOKEN_TTL_MS }, tokenSecret);
  }

  async function requireUser(request: FastifyRequest): Promise<string> {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token, tokenSecret, now());
    if (payload === null) throw new HttpError(401, 'unauthorized', 'Bitte anmelden');
    const found = await db.query<{ token_epoch: number }>('select token_epoch from users where id = $1', [
      payload.sub,
    ]);
    const row = found.rows[0];
    if (row === undefined || row.token_epoch !== payload.epoch) {
      throw new HttpError(401, 'unauthorized', 'Sitzung abgelaufen');
    }
    request.userId = payload.sub;
    return payload.sub;
  }

  async function membership(groupId: string, userId: string): Promise<GroupRole> {
    const found = await db.query<{ role: GroupRole }>(
      'select role from memberships where group_id = $1 and user_id = $2',
      [groupId, userId],
    );
    const role = found.rows[0]?.role;
    if (role === undefined) throw new HttpError(404, 'not_found', 'Laufgruppe nicht gefunden');
    return role;
  }

  async function requireAdmin(groupId: string, userId: string): Promise<void> {
    if ((await membership(groupId, userId)) !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Nur Admins der Laufgruppe dürfen das');
    }
  }

  async function loadMe(userId: string): Promise<Me> {
    const users = await db.query<UserRow>('select * from users where id = $1', [userId]);
    const user = users.rows[0];
    if (user === undefined) throw new HttpError(401, 'unauthorized', 'Konto nicht gefunden');
    const groups = await db.query<{ id: string; name: string; role: GroupRole }>(
      `select g.id, g.name, m.role from groups g join memberships m on m.group_id = g.id
       where m.user_id = $1 order by m.joined_at`,
      [userId],
    );
    return {
      user: { id: user.id, email: user.email, name: user.name, language: user.language },
      groups: groups.rows,
      notifications: {
        newEvent: user.notify_new_event,
        deadlineDays: user.notify_deadline_days,
        eventDays: user.notify_event_days,
        comments: user.notify_comments,
      },
    };
  }

  async function loadGroup(groupId: string, userId: string): Promise<GroupDetail> {
    const role = await membership(groupId, userId);
    const groups = await db.query<{ id: string; name: string; invite_code: string }>(
      'select id, name, invite_code from groups where id = $1',
      [groupId],
    );
    const group = groups.rows[0];
    if (group === undefined) throw new HttpError(404, 'not_found', 'Laufgruppe nicht gefunden');
    const members = await db.query<{ user_id: string; name: string; role: GroupRole }>(
      `select m.user_id, u.name, m.role from memberships m join users u on u.id = m.user_id
       where m.group_id = $1 order by u.name`,
      [groupId],
    );
    return {
      id: group.id,
      name: group.name,
      role,
      inviteCode: group.invite_code,
      members: members.rows.map((m) => ({ userId: m.user_id, name: m.name, role: m.role })),
    };
  }

  async function loadEvents(where: string, params: unknown[]): Promise<RunEvent[]> {
    const events = await db.query<EventRow>(
      `select e.*, u.name as created_by_name from events e join users u on u.id = e.created_by
       where ${where} order by e.start_date, e.name`,
      params,
    );
    if (events.rows.length === 0) return [];
    const ids = events.rows.map((e) => e.id);
    const races = await db.query<RaceRow>(
      'select * from races where event_id = any($1::text[]) order by position',
      [ids],
    );
    const raceIds = races.rows.map((r) => r.id);
    const participations =
      raceIds.length === 0
        ? { rows: [] as ParticipationRow[] }
        : await db.query<ParticipationRow>(
            `select p.race_id, p.user_id, u.name as user_name, p.status, p.team_id from participations p
             join users u on u.id = p.user_id where p.race_id = any($1::text[]) order by u.name`,
            [raceIds],
          );

    const byRace = new Map<string, Race['participants']>();
    for (const p of participations.rows) {
      const list = byRace.get(p.race_id) ?? [];
      list.push({ userId: p.user_id, userName: p.user_name, status: p.status, teamId: p.team_id });
      byRace.set(p.race_id, list);
    }
    const teams =
      raceIds.length === 0
        ? { rows: [] }
        : await db.query<{ id: string; race_id: string; name: string; payer_id: string; payer_name: string; expense_id: string | null }>(
            `select t.id, t.race_id, t.name, t.payer_id, u.name as payer_name, t.expense_id from race_teams t
             join users u on u.id = t.payer_id where t.race_id = any($1::text[]) order by t.created_at, t.id`,
            [raceIds],
          );
    const teamsByRace = new Map<string, RaceTeam[]>();
    for (const t of teams.rows) {
      const list = teamsByRace.get(t.race_id) ?? [];
      list.push({ id: t.id, name: t.name, payerId: t.payer_id, payerName: t.payer_name, expenseId: t.expense_id });
      teamsByRace.set(t.race_id, list);
    }
    const accommodations = await db.query<{
      id: string;
      event_id: string;
      name: string;
      url: string | null;
      price: string | null;
      notes: string | null;
      nights: string;
      created_by: string;
    }>('select * from accommodations where event_id = any($1::text[]) order by created_at', [ids]);
    const stays = await db.query<{
      event_id: string;
      user_id: string;
      user_name: string;
      night: string | null;
      choice: Stay['choice'];
      accommodation_id: string | null;
      other_text: string | null;
      booked: boolean;
    }>(
      `select s.event_id, s.user_id, null as night, s.choice, s.accommodation_id, s.other_text, s.booked,
         u.name as user_name from stays s join users u on u.id = s.user_id where s.event_id = any($1::text[])
       union all
       select n.event_id, n.user_id, n.night, n.choice, n.accommodation_id, n.other_text, n.booked,
         u.name as user_name from night_stays n join users u on u.id = n.user_id where n.event_id = any($1::text[])
       order by user_name, night nulls first`,
      [ids],
    );
    const accommodationsByEvent = new Map<string, Accommodation[]>();
    for (const a of accommodations.rows) {
      const list = accommodationsByEvent.get(a.event_id) ?? [];
      list.push({
        id: a.id,
        name: a.name,
        url: a.url,
        price: a.price,
        notes: a.notes,
        nights: a.nights ? a.nights.split(',') : [],
        createdBy: a.created_by,
      });
      accommodationsByEvent.set(a.event_id, list);
    }
    const staysByEvent = new Map<string, Stay[]>();
    for (const s of stays.rows) {
      const list = staysByEvent.get(s.event_id) ?? [];
      list.push({
        userId: s.user_id,
        userName: s.user_name,
        night: s.night,
        choice: s.choice,
        accommodationId: s.accommodation_id,
        otherText: s.other_text,
        booked: s.booked,
      });
      staysByEvent.set(s.event_id, list);
    }

    const commentStats = await db.query<{ event_id: string; count: string | number; last_at: string | number; last_by: string }>(
      `select distinct on (event_id) event_id, count(*) over (partition by event_id) as count,
         created_at as last_at, user_id as last_by
       from comments where event_id = any($1::text[]) order by event_id, created_at desc`,
      [ids],
    );
    const commentsByEvent = new Map(
      commentStats.rows.map((c) => [c.event_id, { count: Number(c.count), lastAt: Number(c.last_at), lastBy: c.last_by }]),
    );

    const tracks = await db.query<{
      race_id: string;
      name: string | null;
      distance_km: number;
      gain_m: number | null;
      loss_m: number | null;
      min_ele: number | null;
      max_ele: number | null;
    }>(
      `select race_id, name, distance_km, gain_m, loss_m, min_ele, max_ele from race_tracks
       where race_id = any($1::text[])`,
      [raceIds],
    );
    const trackByRace = new Map(
      tracks.rows.map((t) => [
        t.race_id,
        { name: t.name, distanceKm: Number(t.distance_km), gainM: t.gain_m, lossM: t.loss_m, minEle: t.min_ele, maxEle: t.max_ele },
      ]),
    );

    const expensesByEvent = await loadExpenses(ids, new Map(events.rows.map((e) => [e.id, e.currency])));

    const byEvent = new Map<string, Race[]>();
    for (const r of races.rows) {
      const list = byEvent.get(r.event_id) ?? [];
      list.push({
        id: r.id,
        name: r.name,
        distanceKm: r.distance_km,
        elevationUpM: r.elevation_up_m,
        elevationDownM: r.elevation_down_m,
        startDate: r.start_date,
        startTime: r.start_time,
        fee: r.fee,
        feeNote: r.fee_note,
        cutoff: r.cutoff,
        teamSize: r.team_size,
        itraPoints: r.itra_points,
        participants: byRace.get(r.id) ?? [],
        teams: r.team_size === null ? [] : (teamsByRace.get(r.id) ?? []),
        track: trackByRace.get(r.id) ?? null,
      });
      byEvent.set(r.event_id, list);
    }
    return events.rows.map((e) => ({
      id: e.id,
      groupId: e.group_id,
      name: e.name,
      location: e.location,
      startDate: e.start_date,
      endDate: e.end_date,
      website: e.website,
      registrationDeadline: e.registration_deadline,
      currency: e.currency,
      accommodationNeeded: e.accommodation_needed,
      accommodationNotes: e.accommodation_notes,
      notes: e.notes,
      createdBy: e.created_by,
      createdByName: e.created_by_name,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      races: byEvent.get(e.id) ?? [],
      accommodations: accommodationsByEvent.get(e.id) ?? [],
      stays: staysByEvent.get(e.id) ?? [],
      comments: commentsByEvent.get(e.id) ?? { count: 0, lastAt: null, lastBy: null },
      expenses: expensesByEvent.get(e.id) ?? [],
    }));
  }

  async function loadEvent(eventId: string, userId: string): Promise<RunEvent> {
    const [event] = await loadEvents(
      'e.id = $1 and exists (select 1 from memberships m where m.group_id = e.group_id and m.user_id = $2)',
      [eventId, userId],
    );
    if (event === undefined) throw new HttpError(404, 'not_found', 'Veranstaltung nicht gefunden');
    return event;
  }

  /** Schreibt die Strecken einer Veranstaltung. Bekannte Strecken behalten ihre Teilnahmen. */
  async function writeRaces(tx: Db, eventId: string, races: EventInputParsed['races']): Promise<void> {
    const existing = await tx.query<{ id: string }>('select id from races where event_id = $1', [eventId]);
    const existingIds = new Set(existing.rows.map((r) => r.id));
    const keep = new Set<string>();
    for (const [position, race] of races.entries()) {
      const values = [
        race.name,
        race.distanceKm ?? null,
        race.elevationUpM ?? null,
        race.elevationDownM ?? null,
        race.startDate ?? null,
        race.startTime ?? null,
        race.fee ?? null,
        race.feeNote,
        race.cutoff,
        position,
        race.teamSize ?? null,
        race.itraPoints ?? null,
      ];
      if (race.id && existingIds.has(race.id)) {
        keep.add(race.id);
        await tx.query(
          `update races set name = $1, distance_km = $2, elevation_up_m = $3, elevation_down_m = $4,
           start_date = $5, start_time = $6, fee = $7, fee_note = $8, cutoff = $9, position = $10,
           team_size = $11, itra_points = $12 where id = $13`,
          [...values, race.id],
        );
        // Keine Teamstrecke mehr: Teams auflösen, die Anmeldungen bleiben.
        if (race.teamSize == null) await tx.query('delete from race_teams where race_id = $1', [race.id]);
      } else {
        await tx.query(
          `insert into races (name, distance_km, elevation_up_m, elevation_down_m, start_date, start_time,
           fee, fee_note, cutoff, position, team_size, itra_points, id, event_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [...values, newId(), eventId],
        );
      }
    }
    const remove = [...existingIds].filter((id) => !keep.has(id));
    if (remove.length > 0) {
      await tx.query('delete from races where id = any($1::text[])', [remove]);
    }
  }

  /**
   * Unterkunfts-Vorschläge aus dem Formular: vorhandene ändern, neue anlegen, ausdrücklich
   * entfernte löschen. Andere Vorschläge der Veranstaltung bleiben unberührt.
   */
  async function writeAccommodations(tx: Db, eventId: string, input: EventInputParsed, userId: string): Promise<void> {
    const existing = await tx.query<{ id: string }>('select id from accommodations where event_id = $1', [eventId]);
    const ids = new Set(existing.rows.map((r) => r.id));
    const remove = (input.removeAccommodationIds ?? []).filter((id) => ids.has(id));
    if (remove.length > 0) await tx.query('delete from accommodations where id = any($1::text[])', [remove]);
    const at = now();
    for (const [index, a] of (input.accommodations ?? []).entries()) {
      if (a.id && remove.includes(a.id)) continue;
      if (a.id && ids.has(a.id)) {
        await tx.query('update accommodations set name = $1, url = $2, price = $3, notes = $4, nights = $5 where id = $6', [
          a.name,
          a.url,
          a.price,
          a.notes,
          joinNights(a.nights),
          a.id,
        ]);
      } else {
        await tx.query(
          `insert into accommodations (id, event_id, name, url, price, notes, nights, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          // Fortlaufende Zeit, damit die Reihenfolge aus dem Formular erhalten bleibt.
          [newId(), eventId, a.name, a.url, a.price, a.notes, joinNights(a.nights), userId, at + index],
        );
      }
    }
  }

  function eventValues(input: EventInputParsed): unknown[] {
    return [
      input.name,
      input.location,
      input.startDate,
      input.endDate ?? null,
      input.website,
      input.registrationDeadline ?? null,
      input.currency.toUpperCase(),
      input.accommodationNeeded,
      input.accommodationNotes,
      input.notes,
    ];
  }

  function retryAfter(reply: FastifyReply, ms: number): FastifyReply {
    return reply.header('retry-after', String(Math.ceil(ms / 1000)));
  }

  // ------------------------------------------------------------------ Routen

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async () => ({ importEnabled: importer !== null }));

  app.post('/api/auth/register', async (request, reply) => {
    const input = parse(registerSchema, request.body);
    const userId = newId();
    const passwordHash = await hashPassword(input.password);
    const at = now();

    await db.transaction(async (tx) => {
      const taken = await tx.query('select 1 from users where email = $1', [input.email]);
      if (taken.rows.length > 0) throw new HttpError(409, 'email_taken', 'Diese E-Mail ist schon registriert');
      let groupId: string | null = null;
      if (input.inviteCode) {
        const group = await tx.query<{ id: string }>('select id from groups where invite_code = $1', [
          input.inviteCode,
        ]);
        groupId = group.rows[0]?.id ?? null;
        if (groupId === null) throw new HttpError(404, 'invite_invalid', 'Einladung ungültig oder abgelaufen');
      }
      await tx.query(
        'insert into users (id, email, name, password_hash, language, created_at) values ($1,$2,$3,$4,$5,$6)',
        [userId, input.email, input.name, passwordHash, input.language, at],
      );
      if (groupId !== null) {
        await tx.query('insert into memberships (group_id, user_id, role, joined_at) values ($1,$2,$3,$4)', [
          groupId,
          userId,
          'member',
          at,
        ]);
      }
    });

    reply.code(201);
    return { token: issueToken({ id: userId, token_epoch: 0 }), me: await loadMe(userId) };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const input = parse(loginSchema, request.body);
    const key = `${request.ip}|${input.email}`;
    const wait = loginThrottle.retryAfter(key, now());
    if (wait > 0) {
      return retryAfter(reply, wait).code(429).send({ error: 'too_many_attempts', message: 'Zu viele Versuche' });
    }
    const found = await db.query<UserRow>('select * from users where email = $1', [input.email]);
    const user = found.rows[0];
    const ok = user !== undefined && (await checkPassword(input.password, user.password_hash));
    if (!ok || user === undefined) {
      loginThrottle.record(key, now());
      throw new HttpError(401, 'invalid_credentials', 'E-Mail oder Passwort falsch');
    }
    loginThrottle.clear(key);
    return { token: issueToken(user), me: await loadMe(user.id) };
  });

  app.get('/api/me', async (request) => loadMe(await requireUser(request)));

  app.patch('/api/me', async (request) => {
    const userId = await requireUser(request);
    const input = parse(profileSchema, request.body);
    if (input.name !== undefined) await db.query('update users set name = $1 where id = $2', [input.name, userId]);
    if (input.language !== undefined) {
      await db.query('update users set language = $1 where id = $2', [input.language, userId]);
    }
    const notify = input.notifications;
    if (notify?.newEvent !== undefined) {
      await db.query('update users set notify_new_event = $1 where id = $2', [notify.newEvent, userId]);
    }
    if (notify?.deadlineDays !== undefined) {
      await db.query('update users set notify_deadline_days = $1 where id = $2', [notify.deadlineDays, userId]);
    }
    if (notify?.eventDays !== undefined) {
      await db.query('update users set notify_event_days = $1 where id = $2', [notify.eventDays, userId]);
    }
    if (notify?.comments !== undefined) {
      await db.query('update users set notify_comments = $1 where id = $2', [notify.comments, userId]);
    }
    return loadMe(userId);
  });

  app.post('/api/me/password', async (request) => {
    const userId = await requireUser(request);
    const input = parse(passwordSchema, request.body);
    const found = await db.query<UserRow>('select * from users where id = $1', [userId]);
    const user = found.rows[0];
    if (user === undefined || !(await checkPassword(input.currentPassword, user.password_hash))) {
      throw new HttpError(403, 'invalid_credentials', 'Aktuelles Passwort stimmt nicht');
    }
    // Neue Epoche: Alle anderen Geräte werden abgemeldet, dieses bekommt ein neues Token.
    const updated = await db.query<UserRow>(
      'update users set password_hash = $1, token_epoch = token_epoch + 1 where id = $2 returning *',
      [await hashPassword(input.newPassword), userId],
    );
    return { token: issueToken(updated.rows[0] ?? user) };
  });

  // Kalender-Abo ---------------------------------------------------------------

  /** Der geheime Abo-Link der Person; wird beim ersten Abruf angelegt. */
  app.get('/api/me/calendar', async (request) => {
    const userId = await requireUser(request);
    const found = await db.query<{ calendar_token: string | null }>('select calendar_token from users where id = $1', [userId]);
    const existing = found.rows[0]?.calendar_token ?? null;
    if (existing !== null) return { token: existing };
    const updated = await db.query<{ calendar_token: string }>(
      'update users set calendar_token = coalesce(calendar_token, $1) where id = $2 returning calendar_token',
      [newCalendarToken(), userId],
    );
    const token = updated.rows[0]?.calendar_token;
    if (token === undefined) throw new HttpError(401, 'unauthorized', 'Konto nicht gefunden');
    return { token };
  });

  /** Neuer Link; der alte funktioniert ab sofort nicht mehr. */
  app.post('/api/me/calendar', async (request) => {
    const userId = await requireUser(request);
    const token = newCalendarToken();
    await db.query('update users set calendar_token = $1 where id = $2', [token, userId]);
    return { token };
  });

  /**
   * Der Kalender selbst. Ohne Anmeldung erreichbar, weil Kalender-Apps keine Tokens
   * schicken können; der lange Zufallswert im Pfad ist der Schlüssel.
   * Mit `?download=1` kommt er als Datei zum Speichern.
   */
  app.get<{ Params: { file: string }; Querystring: { download?: string } }>('/api/calendar/:file', async (request, reply) => {
    const token = request.params.file.replace(/\.ics$/, '');
    if (token.length < 20) throw new HttpError(404, 'not_found', 'Kalender nicht gefunden');
    const users = await db.query<{ id: string; name: string; language: Language }>(
      'select id, name, language from users where calendar_token = $1',
      [token],
    );
    const user = users.rows[0];
    if (user === undefined) throw new HttpError(404, 'not_found', 'Kalender nicht gefunden');

    // Nur Strecken in Gruppen, in denen die Person noch ist.
    const rows = await db.query<{
      race_id: string;
      race_name: string;
      race_date: string | null;
      start_time: string | null;
      distance_km: number | null;
      elevation_up_m: number | null;
      cutoff: string | null;
      status: 'registered' | 'paid';
      participation_updated: string | number;
      event_id: string;
      event_name: string;
      location: string | null;
      website: string | null;
      start_date: string;
      end_date: string | null;
      event_updated: string | number;
      race_count: string | number;
    }>(
      `select r.id as race_id, r.name as race_name, r.start_date as race_date, r.start_time, r.distance_km,
              r.elevation_up_m, r.cutoff, p.status, p.updated_at as participation_updated,
              e.id as event_id, e.name as event_name, e.location, e.website, e.start_date, e.end_date,
              e.updated_at as event_updated,
              (select count(*) from races r2 where r2.event_id = e.id) as race_count
       from participations p
       join races r on r.id = p.race_id
       join events e on e.id = r.event_id
       join memberships m on m.group_id = e.group_id and m.user_id = p.user_id
       where p.user_id = $1 and p.status in ('registered', 'paid')`,
      [user.id],
    );

    const entries: CalendarEntry[] = rows.rows.map((r) => ({
      raceId: r.race_id,
      eventId: r.event_id,
      eventName: r.event_name,
      raceName: r.race_name,
      raceCount: Number(r.race_count),
      location: r.location,
      website: r.website,
      date: r.race_date ?? r.start_date,
      endDate: r.race_date === null ? r.end_date : null,
      startTime: r.start_time,
      distanceKm: r.distance_km,
      elevationUpM: r.elevation_up_m,
      cutoff: r.cutoff,
      status: r.status,
      updatedAt: Math.max(Number(r.event_updated), Number(r.participation_updated)),
    }));

    const body = buildCalendar(entries, {
      name: `RunPlanner – ${user.name}`,
      language: user.language,
      appUrl: `${request.protocol}://${request.host}`,
      now: now(),
    });
    reply.header('content-type', 'text/calendar; charset=utf-8');
    reply.header('cache-control', 'private, no-cache');
    if (request.query.download !== undefined) {
      reply.header('content-disposition', 'attachment; filename="runplanner.ics"');
    }
    return body;
  });

  // Laufgruppen ----------------------------------------------------------------

  app.post('/api/groups', async (request, reply) => {
    const userId = await requireUser(request);
    const input = parse(groupSchema, request.body);
    const groupId = newId();
    await db.transaction(async (tx) => {
      await tx.query('insert into groups (id, name, invite_code, created_at) values ($1,$2,$3,$4)', [
        groupId,
        input.name,
        newInviteCode(),
        now(),
      ]);
      await tx.query('insert into memberships (group_id, user_id, role, joined_at) values ($1,$2,$3,$4)', [
        groupId,
        userId,
        'admin',
        now(),
      ]);
    });
    reply.code(201);
    return loadGroup(groupId, userId);
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id', async (request) =>
    loadGroup(request.params.id, await requireUser(request)),
  );

  app.patch<{ Params: { id: string } }>('/api/groups/:id', async (request) => {
    const userId = await requireUser(request);
    await requireAdmin(request.params.id, userId);
    const input = parse(groupSchema, request.body);
    await db.query('update groups set name = $1 where id = $2', [input.name, request.params.id]);
    return loadGroup(request.params.id, userId);
  });

  app.post<{ Params: { id: string } }>('/api/groups/:id/invite', async (request) => {
    const userId = await requireUser(request);
    await requireAdmin(request.params.id, userId);
    await db.query('update groups set invite_code = $1 where id = $2', [newInviteCode(), request.params.id]);
    return loadGroup(request.params.id, userId);
  });

  app.patch<{ Params: { id: string; userId: string } }>('/api/groups/:id/members/:userId', async (request) => {
    const userId = await requireUser(request);
    await requireAdmin(request.params.id, userId);
    const input = parse(roleSchema, request.body);
    if (input.role === 'member') await assertAnotherAdmin(request.params.id, request.params.userId);
    await db.query('update memberships set role = $1 where group_id = $2 and user_id = $3', [
      input.role,
      request.params.id,
      request.params.userId,
    ]);
    return loadGroup(request.params.id, userId);
  });

  /** Entfernt ein Mitglied, oder sich selbst (Gruppe verlassen). */
  app.delete<{ Params: { id: string; userId: string } }>('/api/groups/:id/members/:userId', async (request) => {
    const userId = await requireUser(request);
    const target = request.params.userId;
    if (target === userId) await membership(request.params.id, userId);
    else await requireAdmin(request.params.id, userId);
    await assertAnotherAdmin(request.params.id, target);
    await db.query('delete from memberships where group_id = $1 and user_id = $2', [request.params.id, target]);
    // Die Gruppe bleibt bestehen, solange noch jemand drin ist.
    await db.query(
      'delete from groups where id = $1 and not exists (select 1 from memberships where group_id = $1)',
      [request.params.id],
    );
    return loadMe(userId);
  });

  /** Eine Gruppe darf nicht ohne Admin zurückbleiben, solange noch Mitglieder da sind. */
  async function assertAnotherAdmin(groupId: string, leavingUserId: string): Promise<void> {
    const rows = await db.query<{ user_id: string; role: GroupRole }>(
      'select user_id, role from memberships where group_id = $1',
      [groupId],
    );
    const others = rows.rows.filter((r) => r.user_id !== leavingUserId);
    const leavingIsAdmin = rows.rows.some((r) => r.user_id === leavingUserId && r.role === 'admin');
    if (leavingIsAdmin && others.length > 0 && !others.some((r) => r.role === 'admin')) {
      throw new HttpError(409, 'last_admin', 'Erst eine andere Person zum Admin machen');
    }
  }

  // Passwort zurücksetzen ------------------------------------------------------
  // Es gibt keinen Mailversand: Ein Admin einer gemeinsamen Gruppe erzeugt einen
  // Einmal-Link und schickt ihn selbst weiter (z. B. per Messenger).

  /** Erzeugt einen Reset-Link für ein Mitglied; ältere Links der Person verfallen. */
  app.post<{ Params: { id: string; userId: string } }>('/api/groups/:id/members/:userId/reset', async (request) => {
    const userId = await requireUser(request);
    const target = request.params.userId;
    await requireAdmin(request.params.id, userId);
    if (target === userId) throw new HttpError(400, 'own_account', 'Das eigene Passwort bitte in den Einstellungen ändern');
    await membership(request.params.id, target);
    const code = newResetCode();
    const expiresAt = now() + RESET_TTL_MS;
    await db.transaction(async (tx) => {
      await tx.query('delete from password_resets where user_id = $1', [target]);
      await tx.query('insert into password_resets (code_hash, user_id, created_by, expires_at) values ($1,$2,$3,$4)', [
        hashResetCode(code),
        target,
        userId,
        expiresAt,
      ]);
    });
    return { code, expiresAt };
  });

  async function findReset(code: string): Promise<{ user_id: string; name: string }> {
    const found = await db.query<{ user_id: string; name: string; expires_at: number | string }>(
      `select r.user_id, u.name, r.expires_at from password_resets r join users u on u.id = r.user_id
       where r.code_hash = $1`,
      [hashResetCode(code)],
    );
    const row = found.rows[0];
    if (row === undefined || Number(row.expires_at) < now()) {
      throw new HttpError(404, 'reset_invalid', 'Link ungültig oder abgelaufen. Bitte einen neuen beim Admin anfordern.');
    }
    return row;
  }

  app.get<{ Params: { code: string } }>('/api/resets/:code', async (request) => {
    const reset = await findReset(request.params.code);
    return { name: reset.name };
  });

  app.post<{ Params: { code: string } }>('/api/resets/:code', async (request) => {
    const input = parse(resetSchema, request.body);
    const reset = await findReset(request.params.code);
    const updated = await db.transaction(async (tx) => {
      await tx.query('delete from password_resets where user_id = $1', [reset.user_id]);
      // Neue Epoche: Alle Geräte werden abgemeldet.
      return tx.query<UserRow>(
        'update users set password_hash = $1, token_epoch = token_epoch + 1 where id = $2 returning *',
        [await hashPassword(input.password), reset.user_id],
      );
    });
    const user = updated.rows[0]!;
    return { token: issueToken(user), me: await loadMe(user.id) };
  });

  app.get<{ Params: { code: string } }>('/api/invites/:code', async (request) => {
    const found = await db.query<{ id: string; name: string }>('select id, name from groups where invite_code = $1', [
      request.params.code,
    ]);
    const group = found.rows[0];
    if (group === undefined) throw new HttpError(404, 'invite_invalid', 'Einladung ungültig oder abgelaufen');
    return { groupName: group.name };
  });

  app.post<{ Params: { code: string } }>('/api/invites/:code/join', async (request) => {
    const userId = await requireUser(request);
    const found = await db.query<{ id: string }>('select id from groups where invite_code = $1', [request.params.code]);
    const group = found.rows[0];
    if (group === undefined) throw new HttpError(404, 'invite_invalid', 'Einladung ungültig oder abgelaufen');
    await db.query(
      `insert into memberships (group_id, user_id, role, joined_at) values ($1,$2,'member',$3)
       on conflict (group_id, user_id) do nothing`,
      [group.id, userId, now()],
    );
    return { groupId: group.id, me: await loadMe(userId) };
  });

  // Veranstaltungen ------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/api/groups/:id/events',
    async (request) => {
      const userId = await requireUser(request);
      await membership(request.params.id, userId);
      const range = parse(rangeSchema, request.query);
      const params: unknown[] = [request.params.id];
      let where = 'e.group_id = $1';
      if (range.from) {
        params.push(range.from);
        where += ` and coalesce(e.end_date, e.start_date) >= $${params.length}`;
      }
      if (range.to) {
        params.push(range.to);
        where += ` and e.start_date <= $${params.length}`;
      }
      return { events: await loadEvents(where, params) };
    },
  );

  app.post<{ Params: { id: string } }>('/api/groups/:id/events', async (request, reply) => {
    const userId = await requireUser(request);
    await membership(request.params.id, userId);
    const input = parse(eventInputSchema, request.body);
    const eventId = newId();
    const at = now();
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into events (name, location, start_date, end_date, website, registration_deadline, currency,
         accommodation_needed, accommodation_notes, notes,
         id, group_id, created_by, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [...eventValues(input), eventId, request.params.id, userId, at, at],
      );
      await writeRaces(tx, eventId, input.races);
      await writeAccommodations(tx, eventId, input, userId);
    });
    reply.code(201);
    const created = await loadEvent(eventId, userId);
    // Nicht auf die Zustellung warten: Langsame Push-Dienste sollen das Speichern nicht bremsen.
    void notifyNewEvent(db, push, { ...created, groupId: request.params.id }, (m) => request.log.warn(m)).catch((error) =>
      request.log.error(error),
    );
    return created;
  });

  app.get<{ Params: { id: string } }>('/api/events/:id', async (request) =>
    loadEvent(request.params.id, await requireUser(request)),
  );

  app.put<{ Params: { id: string } }>('/api/events/:id', async (request) => {
    const userId = await requireUser(request);
    const existing = await loadEvent(request.params.id, userId);
    const input = parse(eventInputSchema, request.body);
    await db.transaction(async (tx) => {
      await tx.query(
        `update events set name = $1, location = $2, start_date = $3, end_date = $4, website = $5,
         registration_deadline = $6, currency = $7, accommodation_needed = $8,
         accommodation_notes = $9, notes = $10, updated_at = $11 where id = $12`,
        [...eventValues(input), now(), existing.id],
      );
      await writeRaces(tx, existing.id, input.races);
      await writeAccommodations(tx, existing.id, input, userId);
    });
    return loadEvent(existing.id, userId);
  });

  app.delete<{ Params: { id: string } }>('/api/events/:id', async (request, reply) => {
    const userId = await requireUser(request);
    const event = await loadEvent(request.params.id, userId);
    const role = await membership(event.groupId, userId);
    if (event.createdBy !== userId && role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Löschen dürfen nur die Person, die sie angelegt hat, und Admins');
    }
    await db.query('delete from events where id = $1', [event.id]);
    return reply.code(204).send();
  });

  /** Veranstaltung einer Strecke, sofern sie in einer eigenen Gruppe liegt. */
  async function raceEvent(raceId: string, userId: string): Promise<string> {
    const found = await db.query<{ event_id: string }>(
      `select r.event_id from races r join events e on e.id = r.event_id
       join memberships m on m.group_id = e.group_id and m.user_id = $2 where r.id = $1`,
      [raceId, userId],
    );
    const eventId = found.rows[0]?.event_id;
    if (eventId === undefined) throw new HttpError(404, 'not_found', 'Strecke nicht gefunden');
    return eventId;
  }

  // Teilnahme und Teams -----------------------------------------------------------
  // Bei Teamstrecken gehört jede Anmeldung zu einem Team. Eine Person zahlt fürs Team;
  // setzt sie „Bezahlt“, gelten alle im Team als bezahlt, und die Gebühr wird als
  // Ausgabe angelegt und aufs Team aufgeteilt (löschbar wie jede andere Ausgabe).

  type Tx = Pick<Db, 'query'>;

  async function teamRow(tx: Tx, teamId: string) {
    const found = await tx.query<{ id: string; race_id: string; name: string; payer_id: string; expense_id: string | null }>(
      'select id, race_id, name, payer_id, expense_id from race_teams where id = $1',
      [teamId],
    );
    return found.rows[0];
  }

  async function teamMemberIds(tx: Tx, teamId: string): Promise<string[]> {
    const found = await tx.query<{ user_id: string }>(
      'select user_id from participations where team_id = $1 order by joined_at nulls last, user_id',
      [teamId],
    );
    return found.rows.map((r) => r.user_id);
  }

  /** Nach dem Austritt: leeres Team auflösen, sonst ggf. eine neue zahlende Person bestimmen. */
  async function afterLeave(tx: Tx, teamId: string, userId: string): Promise<void> {
    const members = await teamMemberIds(tx, teamId);
    if (members.length === 0) {
      await tx.query('delete from race_teams where id = $1', [teamId]);
      return;
    }
    const team = await teamRow(tx, teamId);
    if (team !== undefined && team.payer_id === userId) {
      await tx.query('update race_teams set payer_id = $1 where id = $2', [members[0], teamId]);
    }
  }

  /** Die zahlende Person hat ihren Status geändert: aufs Team übertragen. */
  async function payerChanged(
    tx: Tx,
    teamId: string,
    payerId: string,
    before: ParticipationStatus | null,
    after: ParticipationStatus,
  ): Promise<void> {
    if (after === 'paid' && before !== 'paid') {
      await tx.query(`update participations set status = 'paid', updated_at = $2 where team_id = $1`, [teamId, now()]);
      await createTeamExpense(tx, teamId, payerId);
    } else if (after !== 'paid' && before === 'paid') {
      await tx.query(
        `update participations set status = 'registered', updated_at = $2 where team_id = $1 and status = 'paid'`,
        [teamId, now()],
      );
      // Doch nicht bezahlt: die automatisch angelegte Ausgabe entfällt.
      const team = await teamRow(tx, teamId);
      if (team?.expense_id) await tx.query('delete from expenses where id = $1', [team.expense_id]);
    }
  }

  async function createTeamExpense(tx: Tx, teamId: string, payerId: string): Promise<void> {
    const team = await teamRow(tx, teamId);
    if (team === undefined || team.expense_id !== null) return;
    const race = await tx.query<{ event_id: string; name: string; fee: number | null }>(
      'select event_id, name, fee from races where id = $1',
      [team.race_id],
    );
    const info = race.rows[0];
    const cents = Math.round((info?.fee ?? 0) * 100);
    const members = await teamMemberIds(tx, teamId);
    if (info === undefined || cents <= 0 || members.length < 2) return;
    const lang = await tx.query<{ language: Language }>('select language from users where id = $1', [payerId]);
    const label = lang.rows[0]?.language === 'en' ? 'Entry fee' : 'Startgebühr';
    const id = newId();
    await tx.query(
      `insert into expenses (id, event_id, paid_by, description, amount_cents, created_by, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, info.event_id, payerId, `${label} ${info.name} (${team.name})`.slice(0, 200), cents, payerId, now()],
    );
    await writeShares(tx, id, splitEqually(cents, [payerId, ...members.filter((m) => m !== payerId)]));
    await tx.query('update race_teams set expense_id = $1 where id = $2', [id, teamId]);
  }

  app.put<{ Params: { id: string } }>('/api/races/:id/participation', async (request) => {
    const userId = await requireUser(request);
    const input = parse(participationInputSchema, request.body);
    const raceId = request.params.id;
    const eventId = await raceEvent(raceId, userId);
    await db.transaction(async (tx) => {
      const race = (await tx.query<{ team_size: number | null }>('select team_size from races where id = $1', [raceId])).rows[0];
      const current = (
        await tx.query<{ status: ParticipationStatus; team_id: string | null }>(
          'select status, team_id from participations where race_id = $1 and user_id = $2',
          [raceId, userId],
        )
      ).rows[0];
      const oldTeam = current?.team_id ?? null;

      if (input.status === null) {
        await tx.query('delete from participations where race_id = $1 and user_id = $2', [raceId, userId]);
        if (oldTeam !== null) await afterLeave(tx, oldTeam, userId);
        return;
      }

      if (race?.team_size == null) {
        await tx.query(
          `insert into participations (race_id, user_id, status, updated_at) values ($1,$2,$3,$4)
           on conflict (race_id, user_id) do update set status = excluded.status, updated_at = excluded.updated_at`,
          [raceId, userId, input.status, now()],
        );
        return;
      }

      // Teamstrecke: Team bestimmen (bisheriges, gewähltes oder neues).
      let teamId: string;
      const wanted = input.teamId ?? null;
      if (wanted === 'new' || (wanted === null && oldTeam === null)) {
        const me = await tx.query<{ name: string }>('select name from users where id = $1', [userId]);
        teamId = newId();
        await tx.query('insert into race_teams (id, race_id, name, payer_id, created_at) values ($1,$2,$3,$4,$5)', [
          teamId,
          raceId,
          `Team ${me.rows[0]?.name ?? ''}`.trim().slice(0, 80),
          userId,
          now(),
        ]);
      } else if (wanted !== null && wanted !== oldTeam) {
        const team = await teamRow(tx, wanted);
        if (team === undefined || team.race_id !== raceId) throw new HttpError(404, 'not_found', 'Team nicht gefunden');
        const members = await teamMemberIds(tx, wanted);
        if (members.length >= race.team_size) throw new HttpError(409, 'team_full', 'Das Team ist schon voll');
        teamId = wanted;
      } else {
        teamId = oldTeam!;
      }

      const team = (await teamRow(tx, teamId))!;
      const isPayer = team.payer_id === userId;
      const sameTeam = teamId === oldTeam;
      if (input.status === 'paid' && !isPayer) {
        throw new HttpError(403, 'forbidden', `Bezahlt setzt die Person, die fürs Team zahlt`);
      }
      let status = input.status;
      if (!isPayer) {
        const payer = await tx.query<{ status: ParticipationStatus }>(
          'select status from participations where race_id = $1 and user_id = $2',
          [raceId, team.payer_id],
        );
        if (payer.rows[0]?.status === 'paid') status = 'paid';
      }
      await tx.query(
        `insert into participations (race_id, user_id, status, updated_at, team_id, joined_at) values ($1,$2,$3,$4,$5,$4)
         on conflict (race_id, user_id) do update set status = excluded.status, updated_at = excluded.updated_at,
           team_id = excluded.team_id,
           joined_at = case when participations.team_id is not distinct from excluded.team_id
             then coalesce(participations.joined_at, excluded.joined_at) else excluded.joined_at end`,
        [raceId, userId, status, now(), teamId],
      );
      if (oldTeam !== null && !sameTeam) await afterLeave(tx, oldTeam, userId);
      if (isPayer) await payerChanged(tx, teamId, userId, sameTeam ? (current?.status ?? null) : null, status);
    });
    return loadEvent(eventId, userId);
  });

  /** Team umbenennen oder eine andere Person zahlen lassen. Dürfen Teammitglieder und Admins. */
  app.put<{ Params: { id: string } }>('/api/teams/:id', async (request) => {
    const userId = await requireUser(request);
    const input = parse(teamInputSchema, request.body);
    const team = await teamRow(db, request.params.id);
    if (team === undefined) throw new HttpError(404, 'not_found', 'Team nicht gefunden');
    const eventId = await raceEvent(team.race_id, userId);
    const event = await loadEvent(eventId, userId);
    const members = await teamMemberIds(db, team.id);
    if (!members.includes(userId) && (await membership(event.groupId, userId)) !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Nur Teammitglieder dürfen das Team ändern');
    }
    if (input.payerId !== undefined && !members.includes(input.payerId)) {
      throw new HttpError(400, 'invalid_input', 'Zahlen kann nur jemand aus dem Team');
    }
    await db.query('update race_teams set name = coalesce($1, name), payer_id = coalesce($2, payer_id) where id = $3', [
      input.name ?? null,
      input.payerId ?? null,
      team.id,
    ]);
    return loadEvent(eventId, userId);
  });

  // Streckenverlauf -------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/races/:id/track', async (request) => {
    const userId = await requireUser(request);
    await raceEvent(request.params.id, userId);
    const found = await db.query<{ name: string | null; points: string; distance_km: number; gain_m: number | null; loss_m: number | null; min_ele: number | null; max_ele: number | null }>(
      'select * from race_tracks where race_id = $1',
      [request.params.id],
    );
    const t = found.rows[0];
    if (t === undefined) throw new HttpError(404, 'not_found', 'Kein Streckenverlauf hinterlegt');
    return {
      name: t.name,
      points: JSON.parse(t.points) as unknown,
      distanceKm: Number(t.distance_km),
      gainM: t.gain_m,
      lossM: t.loss_m,
      minEle: t.min_ele,
      maxEle: t.max_ele,
    };
  });

  /**
   * GPX-Verlauf hinterlegen (im Browser eingelesen und ausgedünnt). Fehlen bei der
   * Strecke Distanz oder Höhenmeter, werden sie aus dem Verlauf übernommen.
   */
  /** Speichert einen Streckenverlauf und füllt leere Distanz/Höhenmeter der Strecke. */
  async function saveTrack(raceId: string, input: z.output<typeof trackInputSchema>, userId: string): Promise<void> {
    const km = Math.round(input.distanceKm * 10) / 10;
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into race_tracks (race_id, name, points, distance_km, gain_m, loss_m, min_ele, max_ele, uploaded_by, uploaded_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (race_id) do update set name = excluded.name, points = excluded.points,
           distance_km = excluded.distance_km, gain_m = excluded.gain_m, loss_m = excluded.loss_m,
           min_ele = excluded.min_ele, max_ele = excluded.max_ele, uploaded_by = excluded.uploaded_by,
           uploaded_at = excluded.uploaded_at`,
        [
          raceId,
          input.name,
          JSON.stringify(input.points),
          input.distanceKm,
          input.gainM === null ? null : Math.round(input.gainM),
          input.lossM === null ? null : Math.round(input.lossM),
          input.minEle === null ? null : Math.round(input.minEle),
          input.maxEle === null ? null : Math.round(input.maxEle),
          userId,
          now(),
        ],
      );
      await tx.query(
        `update races set distance_km = coalesce(distance_km, $2),
           elevation_up_m = coalesce(elevation_up_m, $3), elevation_down_m = coalesce(elevation_down_m, $4)
         where id = $1`,
        [
          raceId,
          km,
          input.gainM === null ? null : Math.round(input.gainM),
          input.lossM === null ? null : Math.round(input.lossM),
        ],
      );
    });
  }

  app.put<{ Params: { id: string } }>('/api/races/:id/track', async (request) => {
    const userId = await requireUser(request);
    const eventId = await raceEvent(request.params.id, userId);
    const input = parse(trackInputSchema, request.body);
    await saveTrack(request.params.id, input, userId);
    return loadEvent(eventId, userId);
  });

  // GPX-Suche auf der Website ---------------------------------------------------

  /** Sucht GPX-Dateien auf der Website der Veranstaltung und schlägt eine Zuordnung vor. */
  app.post<{ Params: { id: string } }>('/api/events/:id/gpx-search', async (request, reply) => {
    const userId = await requireUser(request);
    const event = await loadEvent(request.params.id, userId);
    if (!event.website) throw new HttpError(400, 'no_website', 'Die Veranstaltung hat keine Website');
    const wait = importThrottle.retryAfter(userId, now());
    if (wait > 0) {
      return retryAfter(reply, wait)
        .code(429)
        .send({ error: 'too_many_imports', message: 'Zu viele Suchen in dieser Stunde' });
    }
    importThrottle.record(userId, now());
    let found;
    try {
      found = await gpxFinder.search(event.website);
    } catch (error) {
      if (error instanceof ImportError) throw new HttpError(422, error.code, error.message);
      throw error;
    }
    const files = found.files;
    let matches: Map<string, number | null> | null = null;
    let matchedBy: GpxSearchResult['matchedBy'] = null;
    if (files.length > 0 && event.races.length > 0) {
      if (importer?.matchTracks) {
        try {
          matches = await importer.matchTracks(
            event.races.map((r) => ({ id: r.id, name: r.name, distanceKm: r.distanceKm, elevationUpM: r.elevationUpM })),
            files.map((f) => ({ fileName: f.fileName, label: f.label, distanceKm: f.track.distanceKm, gainM: f.track.gainM ?? null })),
          );
          matchedBy = 'ai';
        } catch (error) {
          request.log.warn({ err: error }, 'GPX-Zuordnung per KI fehlgeschlagen, nehme Distanz');
        }
      }
      if (matches === null) {
        matches = matchByDistance(event.races, files.map((f) => ({ distanceKm: f.track.distanceKm })));
        matchedBy = 'distance';
      }
    }
    const raceOfFile = new Map<number, string>();
    for (const [raceId, index] of matches ?? []) if (index !== null) raceOfFile.set(index, raceId);
    const result: GpxSearchResult = {
      candidates: files.map((f, index) => ({
        url: f.url,
        fileName: f.fileName,
        label: f.label,
        distanceKm: Math.round(f.track.distanceKm * 10) / 10,
        gainM: f.track.gainM === null || f.track.gainM === undefined ? null : Math.round(f.track.gainM),
        raceId: raceOfFile.get(index) ?? null,
      })),
      external: found.external,
      pagesChecked: found.pagesChecked,
      matchedBy,
    };
    return result;
  });

  /** Übernimmt bestätigte Dateien: lädt sie erneut und speichert sie bei den Strecken. */
  app.post<{ Params: { id: string } }>('/api/events/:id/gpx-apply', async (request) => {
    const userId = await requireUser(request);
    const event = await loadEvent(request.params.id, userId);
    const input = parse(gpxApplySchema, request.body);
    const raceIds = new Set(event.races.map((r) => r.id));
    if (input.items.some((item) => !raceIds.has(item.raceId))) {
      throw new HttpError(400, 'invalid_input', 'Strecke gehört nicht zur Veranstaltung');
    }
    const tracks: { raceId: string; track: TrackInput }[] = [];
    for (const item of input.items) {
      try {
        tracks.push({ raceId: item.raceId, track: await gpxFinder.download(item.url) });
      } catch {
        throw new HttpError(422, 'fetch_failed', `GPX-Datei konnte nicht geladen werden: ${item.url}`);
      }
    }
    for (const { raceId, track } of tracks) await saveTrack(raceId, parse(trackInputSchema, track), userId);
    return loadEvent(event.id, userId);
  });

  app.delete<{ Params: { id: string } }>('/api/races/:id/track', async (request) => {
    const userId = await requireUser(request);
    const eventId = await raceEvent(request.params.id, userId);
    await db.query('delete from race_tracks where race_id = $1', [request.params.id]);
    return loadEvent(eventId, userId);
  });

  // Unterkünfte ----------------------------------------------------------------

  /** Veranstaltung einer vorgeschlagenen Unterkunft, sofern sie in einer eigenen Gruppe liegt. */
  async function accommodationEvent(accommodationId: string, userId: string): Promise<string> {
    const found = await db.query<{ event_id: string }>(
      `select a.event_id from accommodations a join events e on e.id = a.event_id
       join memberships m on m.group_id = e.group_id and m.user_id = $2 where a.id = $1`,
      [accommodationId, userId],
    );
    const eventId = found.rows[0]?.event_id;
    if (eventId === undefined) throw new HttpError(404, 'not_found', 'Unterkunft nicht gefunden');
    return eventId;
  }

  app.post<{ Params: { id: string } }>('/api/events/:id/accommodations', async (request, reply) => {
    const userId = await requireUser(request);
    const event = await loadEvent(request.params.id, userId);
    const input = parse(accommodationInputSchema, request.body);
    await db.query(
      `insert into accommodations (id, event_id, name, url, price, notes, nights, created_by, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId(), event.id, input.name, input.url, input.price, input.notes, joinNights(input.nights), userId, now()],
    );
    reply.code(201);
    return loadEvent(event.id, userId);
  });

  app.put<{ Params: { id: string } }>('/api/accommodations/:id', async (request) => {
    const userId = await requireUser(request);
    const eventId = await accommodationEvent(request.params.id, userId);
    const input = parse(accommodationInputSchema, request.body);
    await db.query('update accommodations set name = $1, url = $2, price = $3, notes = $4, nights = $5 where id = $6', [
      input.name,
      input.url,
      input.price,
      input.notes,
      joinNights(input.nights),
      request.params.id,
    ]);
    return loadEvent(eventId, userId);
  });

  app.delete<{ Params: { id: string } }>('/api/accommodations/:id', async (request) => {
    const userId = await requireUser(request);
    const eventId = await accommodationEvent(request.params.id, userId);
    await db.query('delete from accommodations where id = $1', [request.params.id]);
    return loadEvent(eventId, userId);
  });

  /**
   * Eigene Unterkunft setzen, für alle Nächte (`night` leer) oder eine einzelne Nacht.
   * `choice: null` nimmt die Wahl zurück. Beide Arten schließen sich aus: Wer eine
   * Nacht setzt, verliert die Wahl für alle Nächte, und umgekehrt.
   */
  app.put<{ Params: { id: string } }>('/api/events/:id/stay', async (request) => {
    const userId = await requireUser(request);
    const event = await loadEvent(request.params.id, userId);
    const body = (request.body ?? {}) as { choice?: unknown; night?: unknown };
    const night = typeof body.night === 'string' ? body.night : null;
    if (night !== null && !eventNights(event).includes(night)) {
      throw new HttpError(400, 'invalid_input', 'Diese Nacht gehört nicht zur Veranstaltung');
    }
    if (body.choice === null || body.choice === undefined) {
      if (night === null) await db.query('delete from stays where event_id = $1 and user_id = $2', [event.id, userId]);
      else {
        await db.query('delete from night_stays where event_id = $1 and user_id = $2 and night = $3', [event.id, userId, night]);
      }
      return loadEvent(event.id, userId);
    }
    const input = parse(stayInputSchema, request.body);
    const accommodationId = input.choice === 'suggested' ? (input.accommodationId ?? null) : null;
    if (accommodationId !== null && !event.accommodations.some((a) => a.id === accommodationId)) {
      throw new HttpError(400, 'invalid_input', 'Diese Unterkunft gehört nicht zur Veranstaltung');
    }
    const values = [
      input.choice,
      accommodationId,
      input.choice === 'other' ? input.otherText : null,
      input.choice === 'none' ? false : input.booked,
      now(),
    ];
    await db.transaction(async (tx) => {
      if (night === null) {
        await tx.query('delete from night_stays where event_id = $1 and user_id = $2', [event.id, userId]);
        await tx.query(
          `insert into stays (event_id, user_id, choice, accommodation_id, other_text, booked, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (event_id, user_id) do update set choice = excluded.choice,
             accommodation_id = excluded.accommodation_id, other_text = excluded.other_text,
             booked = excluded.booked, updated_at = excluded.updated_at`,
          [event.id, userId, ...values],
        );
      } else {
        await tx.query('delete from stays where event_id = $1 and user_id = $2', [event.id, userId]);
        await tx.query(
          `insert into night_stays (event_id, user_id, night, choice, accommodation_id, other_text, booked, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (event_id, user_id, night) do update set choice = excluded.choice,
             accommodation_id = excluded.accommodation_id, other_text = excluded.other_text,
             booked = excluded.booked, updated_at = excluded.updated_at`,
          [event.id, userId, night, ...values],
        );
      }
    });
    return loadEvent(event.id, userId);
  });

  /**
   * Zwischen „eine Unterkunft für alles“ und „jede Nacht anders“ wechseln. Beim Wechsel
   * auf pro Nacht wird die bisherige Wahl in jede Nacht übernommen; zurück werden die
   * einzelnen Nächte verworfen.
   */
  app.put<{ Params: { id: string } }>('/api/events/:id/stay-mode', async (request) => {
    const userId = await requireUser(request);
    const event = await loadEvent(request.params.id, userId);
    const input = parse(stayModeSchema, request.body);
    await db.transaction(async (tx) => {
      if (!input.perNight) {
        await tx.query('delete from night_stays where event_id = $1 and user_id = $2', [event.id, userId]);
        return;
      }
      const nights = eventNights(event);
      if (nights.length === 0) throw new HttpError(400, 'invalid_input', 'Nur bei mehrtägigen Veranstaltungen möglich');
      const found = await tx.query<{ choice: string; accommodation_id: string | null; other_text: string | null; booked: boolean }>(
        'select choice, accommodation_id, other_text, booked from stays where event_id = $1 and user_id = $2',
        [event.id, userId],
      );
      const current = found.rows[0];
      if (current === undefined) return;
      for (const night of nights) {
        await tx.query(
          `insert into night_stays (event_id, user_id, night, choice, accommodation_id, other_text, booked, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (event_id, user_id, night) do nothing`,
          [event.id, userId, night, current.choice, current.accommodation_id, current.other_text, current.booked, now()],
        );
      }
      await tx.query('delete from stays where event_id = $1 and user_id = $2', [event.id, userId]);
    });
    return loadEvent(event.id, userId);
  });

  // Kommentare ------------------------------------------------------------------

  async function loadComments(eventId: string): Promise<EventComment[]> {
    const rows = await db.query<{ id: string; user_id: string; user_name: string; text: string; created_at: string | number }>(
      `select c.id, c.user_id, u.name as user_name, c.text, c.created_at from comments c
       join users u on u.id = c.user_id where c.event_id = $1 order by c.created_at, c.id`,
      [eventId],
    );
    return rows.rows.map((c) => ({ id: c.id, userId: c.user_id, userName: c.user_name, text: c.text, createdAt: Number(c.created_at) }));
  }

  app.get<{ Params: { id: string } }>('/api/events/:id/comments', async (request) => {
    const event = await loadEvent(request.params.id, await requireUser(request));
    return loadComments(event.id);
  });

  app.post<{ Params: { id: string } }>('/api/events/:id/comments', async (request, reply) => {
    const userId = await requireUser(request);
    const event = await loadEvent(request.params.id, userId);
    const input = parse(commentInputSchema, request.body);
    await db.query('insert into comments (id, event_id, user_id, text, created_at) values ($1,$2,$3,$4,$5)', [
      newId(),
      event.id,
      userId,
      input.text,
      now(),
    ]);
    const me = await loadMe(userId);
    void notifyComment(db, push, { id: event.id, name: event.name }, { id: userId, name: me.user.name }, input.text, (m) =>
      request.log.warn(m),
    ).catch((error) => request.log.error(error));
    reply.code(201);
    return loadComments(event.id);
  });

  /** Eigene Kommentare löschen. */
  app.delete<{ Params: { id: string } }>('/api/comments/:id', async (request) => {
    const userId = await requireUser(request);
    const found = await db.query<{ event_id: string; user_id: string }>('select event_id, user_id from comments where id = $1', [
      request.params.id,
    ]);
    const comment = found.rows[0];
    if (comment === undefined) throw new HttpError(404, 'not_found', 'Kommentar nicht gefunden');
    await loadEvent(comment.event_id, userId);
    if (comment.user_id !== userId) throw new HttpError(403, 'forbidden', 'Nur eigene Kommentare lassen sich löschen');
    await db.query('delete from comments where id = $1', [request.params.id]);
    return loadComments(comment.event_id);
  });

  // Kosten teilen ---------------------------------------------------------------
  // Jedes Gruppenmitglied darf Ausgaben erfassen. Ändern und löschen dürfen die Person,
  // die sie erfasst hat, die Person, die bezahlt hat, und die Admins.

  async function loadExpenses(eventIds: string[], currencyByEvent: Map<string, string>): Promise<Map<string, Expense[]>> {
    const rows = await db.query<{
      id: string;
      event_id: string;
      paid_by: string;
      paid_by_name: string;
      description: string;
      amount_cents: number;
      created_by: string;
      created_at: string | number;
    }>(
      `select x.*, u.name as paid_by_name from expenses x join users u on u.id = x.paid_by
       where x.event_id = any($1::text[]) order by x.created_at, x.id`,
      [eventIds],
    );
    const shares = await db.query<{ expense_id: string; user_id: string; user_name: string; amount_cents: number }>(
      `select s.expense_id, s.user_id, u.name as user_name, s.amount_cents from expense_shares s
       join users u on u.id = s.user_id where s.expense_id = any($1::text[]) order by u.name`,
      [rows.rows.map((r) => r.id)],
    );
    const sharesByExpense = new Map<string, Expense['shares']>();
    for (const s of shares.rows) {
      const list = sharesByExpense.get(s.expense_id) ?? [];
      list.push({ userId: s.user_id, userName: s.user_name, amountCents: Number(s.amount_cents) });
      sharesByExpense.set(s.expense_id, list);
    }
    const result = new Map<string, Expense[]>();
    for (const r of rows.rows) {
      const list = result.get(r.event_id) ?? [];
      list.push({
        id: r.id,
        eventId: r.event_id,
        paidBy: r.paid_by,
        paidByName: r.paid_by_name,
        description: r.description,
        amountCents: Number(r.amount_cents),
        currency: currencyByEvent.get(r.event_id) ?? 'EUR',
        shares: sharesByExpense.get(r.id) ?? [],
        createdBy: r.created_by,
        createdAt: Number(r.created_at),
      });
      result.set(r.event_id, list);
    }
    return result;
  }

  /** Alle beteiligten Personen müssen in der Gruppe der Veranstaltung sein. */
  async function assertMembers(groupId: string, userIds: string[]): Promise<void> {
    const unique = [...new Set(userIds)];
    const found = await db.query<{ user_id: string }>(
      'select user_id from memberships where group_id = $1 and user_id = any($2::text[])',
      [groupId, unique],
    );
    if (found.rows.length !== unique.length) {
      throw new HttpError(400, 'invalid_input', 'Alle Beteiligten müssen in der Laufgruppe sein');
    }
  }

  async function writeShares(tx: Pick<Db, 'query'>, expenseId: string, shares: { userId: string; amountCents: number }[]) {
    await tx.query('delete from expense_shares where expense_id = $1', [expenseId]);
    for (const s of shares.filter((share) => share.amountCents > 0)) {
      await tx.query('insert into expense_shares (expense_id, user_id, amount_cents) values ($1,$2,$3)', [
        expenseId,
        s.userId,
        s.amountCents,
      ]);
    }
  }

  app.post<{ Params: { id: string } }>('/api/events/:id/expenses', async (request, reply) => {
    const userId = await requireUser(request);
    const event = await loadEvent(request.params.id, userId);
    const input = parse(expenseInputSchema, request.body);
    await assertMembers(event.groupId, [input.paidBy, ...input.shares.map((s) => s.userId)]);
    const id = newId();
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into expenses (id, event_id, paid_by, description, amount_cents, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, event.id, input.paidBy, input.description, input.amountCents, userId, now()],
      );
      await writeShares(tx, id, input.shares);
    });
    reply.code(201);
    return loadEvent(event.id, userId);
  });

  async function editableExpense(expenseId: string, userId: string): Promise<RunEvent> {
    const found = await db.query<{ event_id: string; paid_by: string; created_by: string }>(
      'select event_id, paid_by, created_by from expenses where id = $1',
      [expenseId],
    );
    const expense = found.rows[0];
    if (expense === undefined) throw new HttpError(404, 'not_found', 'Ausgabe nicht gefunden');
    const event = await loadEvent(expense.event_id, userId);
    const role = await membership(event.groupId, userId);
    if (role !== 'admin' && expense.paid_by !== userId && expense.created_by !== userId) {
      throw new HttpError(403, 'forbidden', 'Nur wer bezahlt oder erfasst hat und Admins dürfen das');
    }
    return event;
  }

  app.put<{ Params: { id: string } }>('/api/expenses/:id', async (request) => {
    const userId = await requireUser(request);
    const event = await editableExpense(request.params.id, userId);
    const input = parse(expenseInputSchema, request.body);
    await assertMembers(event.groupId, [input.paidBy, ...input.shares.map((s) => s.userId)]);
    await db.transaction(async (tx) => {
      await tx.query('update expenses set paid_by = $1, description = $2, amount_cents = $3 where id = $4', [
        input.paidBy,
        input.description,
        input.amountCents,
        request.params.id,
      ]);
      await writeShares(tx, request.params.id, input.shares);
    });
    return loadEvent(event.id, userId);
  });

  app.delete<{ Params: { id: string } }>('/api/expenses/:id', async (request) => {
    const userId = await requireUser(request);
    const event = await editableExpense(request.params.id, userId);
    await db.query('delete from expenses where id = $1', [request.params.id]);
    return loadEvent(event.id, userId);
  });

  async function loadSettlements(groupId: string): Promise<Settlement[]> {
    const rows = await db.query<{
      id: string;
      from_user: string;
      from_name: string;
      to_user: string;
      to_name: string;
      amount_cents: number;
      currency: string;
      created_by: string;
      created_at: string | number;
    }>(
      `select s.*, f.name as from_name, t.name as to_name from settlements s
       join users f on f.id = s.from_user join users t on t.id = s.to_user
       where s.group_id = $1 order by s.created_at desc, s.id`,
      [groupId],
    );
    return rows.rows.map((r) => ({
      id: r.id,
      groupId,
      fromUser: r.from_user,
      fromName: r.from_name,
      toUser: r.to_user,
      toName: r.to_name,
      amountCents: Number(r.amount_cents),
      currency: r.currency,
      createdBy: r.created_by,
      createdAt: Number(r.created_at),
    }));
  }

  app.get<{ Params: { id: string } }>('/api/groups/:id/settlements', async (request) => {
    await membership(request.params.id, await requireUser(request));
    return loadSettlements(request.params.id);
  });

  /** "Erledigt": hält fest, dass eine Überweisung stattgefunden hat. */
  app.post<{ Params: { id: string } }>('/api/groups/:id/settlements', async (request, reply) => {
    const userId = await requireUser(request);
    await membership(request.params.id, userId);
    const input = parse(settlementInputSchema, request.body);
    const known = await db.query<{ id: string }>('select id from users where id = any($1::text[])', [
      [input.fromUser, input.toUser],
    ]);
    if (known.rows.length !== 2) throw new HttpError(400, 'invalid_input', 'Unbekannte Person');
    await db.query(
      `insert into settlements (id, group_id, from_user, to_user, amount_cents, currency, created_by, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), request.params.id, input.fromUser, input.toUser, input.amountCents, input.currency.toUpperCase(), userId, now()],
    );
    reply.code(201);
    return loadSettlements(request.params.id);
  });

  /** Versehentlich als erledigt markiert: rückgängig machen. */
  app.delete<{ Params: { id: string } }>('/api/settlements/:id', async (request) => {
    const userId = await requireUser(request);
    const found = await db.query<{ group_id: string; from_user: string; to_user: string; created_by: string }>(
      'select group_id, from_user, to_user, created_by from settlements where id = $1',
      [request.params.id],
    );
    const settlement = found.rows[0];
    if (settlement === undefined) throw new HttpError(404, 'not_found', 'Zahlung nicht gefunden');
    const role = await membership(settlement.group_id, userId);
    if (role !== 'admin' && ![settlement.from_user, settlement.to_user, settlement.created_by].includes(userId)) {
      throw new HttpError(403, 'forbidden', 'Nur Beteiligte und Admins dürfen das');
    }
    await db.query('delete from settlements where id = $1', [request.params.id]);
    return loadSettlements(settlement.group_id);
  });

  // Push-Benachrichtigungen ----------------------------------------------------

  app.get('/api/push/key', async () => ({ publicKey: push?.publicKey ?? null }));

  /** Meldet dieses Gerät für Benachrichtigungen an. Ein Endpunkt gehört immer der letzten Person. */
  app.post('/api/push/subscribe', async (request, reply) => {
    const userId = await requireUser(request);
    const input = parse(pushSubscriptionSchema, request.body);
    await db.query(
      `insert into push_subscriptions (endpoint, user_id, p256dh, auth, created_at) values ($1,$2,$3,$4,$5)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
         auth = excluded.auth, last_error = null`,
      [input.endpoint, userId, input.keys.p256dh, input.keys.auth, now()],
    );
    reply.code(204);
  });

  app.post('/api/push/unsubscribe', async (request, reply) => {
    const userId = await requireUser(request);
    const endpoint = (request.body as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint === 'string') {
      await db.query('delete from push_subscriptions where endpoint = $1 and user_id = $2', [endpoint, userId]);
    }
    reply.code(204);
  });

  // Import ---------------------------------------------------------------------

  app.post('/api/import', async (request, reply) => {
    const userId = await requireUser(request);
    if (importer === null) {
      throw new HttpError(503, 'import_disabled', 'Der Import ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt)');
    }
    const input = parse(importSchema, request.body);
    const wait = importThrottle.retryAfter(userId, now());
    if (wait > 0) {
      return retryAfter(reply, wait)
        .code(429)
        .send({ error: 'too_many_imports', message: 'Zu viele Importe in dieser Stunde' });
    }
    importThrottle.record(userId, now());
    const url = /^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`;
    const today = new Date(now()).toISOString().slice(0, 10);
    try {
      return await importer.importFromUrl(url, today, input.language);
    } catch (error) {
      if (error instanceof ImportError) {
        const status = error.code === 'not_configured' ? 503 : error.code === 'extract_failed' ? 502 : 422;
        throw new HttpError(status, error.code, error.message);
      }
      throw error;
    }
  });

  return app;
}
