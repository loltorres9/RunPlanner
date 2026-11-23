/**
 * Die HTTP-API.
 *
 * Rechte sind einfach gehalten: Wer in einer Laufgruppe ist, darf dort Veranstaltungen
 * anlegen und bearbeiten. Löschen dürfen die Person, die sie angelegt hat, und die
 * Admins der Gruppe. Die eigene Teilnahme setzt jeder nur für sich selbst.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  eventInputSchema,
  GROUP_ROLES,
  LANGUAGES,
  PARTICIPATION_STATUSES,
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
  newId,
  newInviteCode,
  signToken,
  Throttle,
  TOKEN_TTL_MS,
  verifyToken,
} from './auth.js';
import { migrate, type Db } from './db.js';
import { ImportError, type Importer } from './importer.js';

export interface AppOptions {
  db: Db;
  tokenSecret: string;
  /** Fehlt er, ist der Website-Import abgeschaltet. */
  importer?: Importer | null;
  logger?: boolean;
  now?: () => number;
  /** Höchstzahl Importe pro Person und Stunde. Begrenzt die API-Kosten. */
  importsPerHour?: number;
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
});

const passwordSchema = z.object({
  currentPassword: z.string().max(200),
  newPassword: z.string().min(8).max(200),
});

const groupSchema = z.object({ name: z.string().trim().min(1).max(80) });
const roleSchema = z.object({ role: z.enum(GROUP_ROLES) });
const participationSchema = z.object({ status: z.enum(PARTICIPATION_STATUSES).nullable() });
const importSchema = z.object({ url: z.string().trim().min(4).max(2000), language: z.enum(LANGUAGES).optional() });
const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

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
  accommodation_booked: boolean;
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
}

interface ParticipationRow {
  race_id: string;
  user_id: string;
  user_name: string;
  status: Race['participants'][number]['status'];
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
            `select p.race_id, p.user_id, u.name as user_name, p.status from participations p
             join users u on u.id = p.user_id where p.race_id = any($1::text[]) order by u.name`,
            [raceIds],
          );

    const byRace = new Map<string, Race['participants']>();
    for (const p of participations.rows) {
      const list = byRace.get(p.race_id) ?? [];
      list.push({ userId: p.user_id, userName: p.user_name, status: p.status });
      byRace.set(p.race_id, list);
    }
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
        participants: byRace.get(r.id) ?? [],
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
      accommodationBooked: e.accommodation_booked,
      accommodationNotes: e.accommodation_notes,
      notes: e.notes,
      createdBy: e.created_by,
      createdByName: e.created_by_name,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      races: byEvent.get(e.id) ?? [],
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
      ];
      if (race.id && existingIds.has(race.id)) {
        keep.add(race.id);
        await tx.query(
          `update races set name = $1, distance_km = $2, elevation_up_m = $3, elevation_down_m = $4,
           start_date = $5, start_time = $6, fee = $7, fee_note = $8, cutoff = $9, position = $10
           where id = $11`,
          [...values, race.id],
        );
      } else {
        await tx.query(
          `insert into races (name, distance_km, elevation_up_m, elevation_down_m, start_date, start_time,
           fee, fee_note, cutoff, position, id, event_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [...values, newId(), eventId],
        );
      }
    }
    const remove = [...existingIds].filter((id) => !keep.has(id));
    if (remove.length > 0) {
      await tx.query('delete from races where id = any($1::text[])', [remove]);
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
      input.accommodationBooked,
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
         accommodation_needed, accommodation_booked, accommodation_notes, notes,
         id, group_id, created_by, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [...eventValues(input), eventId, request.params.id, userId, at, at],
      );
      await writeRaces(tx, eventId, input.races);
    });
    reply.code(201);
    return loadEvent(eventId, userId);
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
         registration_deadline = $6, currency = $7, accommodation_needed = $8, accommodation_booked = $9,
         accommodation_notes = $10, notes = $11, updated_at = $12 where id = $13`,
        [...eventValues(input), now(), existing.id],
      );
      await writeRaces(tx, existing.id, input.races);
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

  app.put<{ Params: { id: string } }>('/api/races/:id/participation', async (request) => {
    const userId = await requireUser(request);
    const input = parse(participationSchema, request.body);
    const found = await db.query<{ event_id: string }>(
      `select r.event_id from races r join events e on e.id = r.event_id
       join memberships m on m.group_id = e.group_id and m.user_id = $2 where r.id = $1`,
      [request.params.id, userId],
    );
    const eventId = found.rows[0]?.event_id;
    if (eventId === undefined) throw new HttpError(404, 'not_found', 'Strecke nicht gefunden');
    if (input.status === null) {
      await db.query('delete from participations where race_id = $1 and user_id = $2', [request.params.id, userId]);
    } else {
      await db.query(
        `insert into participations (race_id, user_id, status, updated_at) values ($1,$2,$3,$4)
         on conflict (race_id, user_id) do update set status = excluded.status, updated_at = excluded.updated_at`,
        [request.params.id, userId, input.status, now()],
      );
    }
    return loadEvent(eventId, userId);
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
