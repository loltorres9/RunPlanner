/**
 * Integrationstests des Servers gegen ein echtes Postgres (eingebettet als PGlite).
 */

import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventInput, GroupDetail, ImportResult, Me, RunEvent } from '@runplanner/shared';
import { buildApp } from './app.js';
import type { Importer } from './importer.js';
import { createPgliteDb } from './testing.js';

let app: FastifyInstance;
let pg: PGlite;
let importCalls: string[];

const fakeImporter: Importer = {
  async importFromUrl(url: string): Promise<ImportResult> {
    importCalls.push(url);
    return {
      draft: { name: 'Zugspitz Ultratrail', startDate: '2027-06-18', website: url, races: [{ name: 'Basetrail', distanceKm: 43 }] },
      warnings: [],
    };
  },
};

beforeEach(async () => {
  pg = await PGlite.create();
  importCalls = [];
  app = await buildApp({ db: createPgliteDb(pg), tokenSecret: 'test-secret-test-secret', importer: fakeImporter, importsPerHour: 2 });
});

afterEach(async () => {
  await app.close();
  await pg.close();
});

async function call<T>(method: string, url: string, token?: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const response = await app.inject({
    method: method as 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: (response.body ? response.json() : null) as T };
}

async function register(email: string, name: string, inviteCode?: string): Promise<{ token: string; me: Me }> {
  const res = await call<{ token: string; me: Me }>('POST', '/api/auth/register', undefined, {
    email,
    name,
    password: 'geheim1234',
    inviteCode,
  });
  expect(res.status).toBe(201);
  return res.body;
}

const sampleEvent: EventInput = {
  name: 'Chiemgau Trail',
  location: 'Ruhpolding',
  startDate: '2027-05-01',
  endDate: '2027-05-02',
  website: 'https://example.org',
  registrationDeadline: '2027-04-01',
  accommodationNeeded: true,
  races: [
    { name: 'Ultra', distanceKm: 70, elevationUpM: 3800, startDate: '2027-05-01', startTime: '06:00', fee: 95 },
    { name: 'Kurz', distanceKm: 21.5, elevationUpM: 1100, startTime: '10:30', fee: 45, feeNote: 'Frühbucher 39 €' },
  ],
};

describe('Konten', () => {
  it('registriert, meldet an und lehnt falsches Passwort ab', async () => {
    const { me } = await register('Anna@Example.org', 'Anna');
    expect(me.user.email).toBe('anna@example.org');
    const ok = await call<{ token: string }>('POST', '/api/auth/login', undefined, { email: 'anna@example.org', password: 'geheim1234' });
    expect(ok.status).toBe(200);
    const bad = await call('POST', '/api/auth/login', undefined, { email: 'anna@example.org', password: 'falsch' });
    expect(bad.status).toBe(401);
    const dup = await call('POST', '/api/auth/register', undefined, { email: 'anna@example.org', name: 'X', password: 'geheim1234' });
    expect(dup.status).toBe(409);
  });

  it('verlangt eine Anmeldung', async () => {
    expect((await call('GET', '/api/me')).status).toBe(401);
    expect((await call('GET', '/api/me', 'kaputt')).status).toBe(401);
  });

  it('meldet nach Passwortwechsel alte Sitzungen ab', async () => {
    const { token } = await register('a@x.de', 'A');
    const changed = await call<{ token: string }>('POST', '/api/me/password', token, { currentPassword: 'geheim1234', newPassword: 'neuesPasswort' });
    expect(changed.status).toBe(200);
    expect((await call('GET', '/api/me', token)).status).toBe(401);
    expect((await call('GET', '/api/me', changed.body.token)).status).toBe(200);
  });
});

describe('Laufgruppen', () => {
  it('lädt per Einladung ein und trennt Gruppen voneinander', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    expect(group.status).toBe(201);
    expect(group.body.role).toBe('admin');

    const preview = await call<{ groupName: string }>('GET', `/api/invites/${group.body.inviteCode}`);
    expect(preview.body.groupName).toBe('Familie');

    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    expect(ben.me.groups).toEqual([{ id: group.body.id, name: 'Familie', role: 'member' }]);

    const fremd = await register('fremd@x.de', 'Fremd');
    expect((await call('GET', `/api/groups/${group.body.id}`, fremd.token)).status).toBe(404);
    expect((await call('GET', `/api/groups/${group.body.id}/events`, fremd.token)).status).toBe(404);

    // Neuer Code macht den alten ungültig.
    const rotated = await call<GroupDetail>('POST', `/api/groups/${group.body.id}/invite`, anna.token);
    expect(rotated.body.inviteCode).not.toBe(group.body.inviteCode);
    expect((await call('POST', `/api/invites/${group.body.inviteCode}/join`, fremd.token)).status).toBe(404);
    expect((await call('POST', `/api/invites/${rotated.body.inviteCode}/join`, fremd.token)).status).toBe(200);
    // Nur Admins dürfen den Code erneuern.
    expect((await call('POST', `/api/groups/${group.body.id}/invite`, ben.token)).status).toBe(403);
  });

  it('lässt den letzten Admin nicht gehen, solange andere da sind', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    expect((await call('DELETE', `/api/groups/${group.body.id}/members/${anna.me.user.id}`, anna.token)).status).toBe(409);
    await call('PATCH', `/api/groups/${group.body.id}/members/${ben.me.user.id}`, anna.token, { role: 'admin' });
    expect((await call('DELETE', `/api/groups/${group.body.id}/members/${anna.me.user.id}`, anna.token)).status).toBe(200);
  });
});

describe('Veranstaltungen', () => {
  async function setup() {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    return { anna, ben, groupId: group.body.id };
  }

  it('legt an, bearbeitet und behält Teilnahmen bekannter Strecken', async () => {
    const { anna, ben, groupId } = await setup();
    const created = await call<RunEvent>('POST', `/api/groups/${groupId}/events`, ben.token, sampleEvent);
    expect(created.status).toBe(201);
    expect(created.body.races.map((r) => r.name)).toEqual(['Ultra', 'Kurz']);
    expect(created.body.createdByName).toBe('Ben');
    const ultra = created.body.races[0]!;
    const kurz = created.body.races[1]!;

    const joined = await call<RunEvent>('PUT', `/api/races/${ultra.id}/participation`, anna.token, { status: 'registered' });
    expect(joined.body.races[0]!.participants).toEqual([{ userId: anna.me.user.id, userName: 'Anna', status: 'registered' }]);
    await call('PUT', `/api/races/${kurz.id}/participation`, ben.token, { status: 'interested' });

    // Anna bearbeitet: Ultra bleibt (mit ID), "Kurz" fällt weg, eine neue Strecke kommt dazu.
    const updated = await call<RunEvent>('PUT', `/api/events/${created.body.id}`, anna.token, {
      ...sampleEvent,
      accommodationBooked: true,
      races: [{ ...sampleEvent.races![0], id: ultra.id, fee: 99 }, { name: 'Mini', distanceKm: 10 }],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.accommodationBooked).toBe(true);
    expect(updated.body.races.map((r) => r.name)).toEqual(['Ultra', 'Mini']);
    expect(updated.body.races[0]!.fee).toBe(99);
    expect(updated.body.races[0]!.participants).toHaveLength(1);

    const list = await call<{ events: RunEvent[] }>('GET', `/api/groups/${groupId}/events?from=2027-05-02&to=2027-05-31`, anna.token);
    expect(list.body.events).toHaveLength(1);
    const none = await call<{ events: RunEvent[] }>('GET', `/api/groups/${groupId}/events?from=2027-05-03`, anna.token);
    expect(none.body.events).toHaveLength(0);
  });

  it('prüft Eingaben', async () => {
    const { anna, groupId } = await setup();
    const bad = await call<{ message: string }>('POST', `/api/groups/${groupId}/events`, anna.token, {
      ...sampleEvent,
      endDate: '2027-04-01',
    });
    expect(bad.status).toBe(400);
    const badTime = await call('POST', `/api/groups/${groupId}/events`, anna.token, {
      ...sampleEvent,
      races: [{ name: 'X', startTime: '25:00' }],
    });
    expect(badTime.status).toBe(400);
    const outside = await call<{ message: string }>('POST', `/api/groups/${groupId}/events`, anna.token, {
      ...sampleEvent,
      races: [{ name: 'X', startDate: '2027-05-03' }],
    });
    expect(outside.status).toBe(400);
    expect(outside.body.message).toContain('außerhalb');
  });

  it('erlaubt Löschen nur Ersteller und Admins', async () => {
    const { anna, ben, groupId } = await setup();
    const byAnna = await call<RunEvent>('POST', `/api/groups/${groupId}/events`, anna.token, sampleEvent);
    expect((await call('DELETE', `/api/events/${byAnna.body.id}`, ben.token)).status).toBe(403);
    const byBen = await call<RunEvent>('POST', `/api/groups/${groupId}/events`, ben.token, sampleEvent);
    expect((await call('DELETE', `/api/events/${byBen.body.id}`, anna.token)).status).toBe(204);
    expect((await call('DELETE', `/api/events/${byAnna.body.id}`, anna.token)).status).toBe(204);
  });
});

describe('Import', () => {
  it('liefert einen Entwurf und bremst nach dem Limit', async () => {
    const { token } = await register('anna@x.de', 'Anna');
    const first = await call<ImportResult>('POST', '/api/import', token, { url: 'zugspitz-ultratrail.com' });
    expect(first.status).toBe(200);
    expect(importCalls).toEqual(['https://zugspitz-ultratrail.com']);
    expect(first.body.draft.races).toHaveLength(1);
    await call('POST', '/api/import', token, { url: 'https://a.example' });
    expect((await call('POST', '/api/import', token, { url: 'https://b.example' })).status).toBe(429);
  });
});
