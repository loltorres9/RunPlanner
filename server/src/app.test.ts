/**
 * Integrationstests des Servers gegen ein echtes Postgres (eingebettet als PGlite).
 */

import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settleUp, splitEqually, type EventComment, type EventInput, type GroupDetail, type ImportResult, type Me, type RunEvent, type Settlement, type GpxSearchResult, type TrackInput } from '@runplanner/shared';
import { buildApp } from './app.js';
import type { GpxFinder } from './gpxFinder.js';
import type { Importer } from './importer.js';
import { runDailyReminders, type PushMessage, type PushSender } from './push.js';
import { createPgliteDb } from './testing.js';

let app: FastifyInstance;
let pg: PGlite;
let importCalls: string[];
let pushed: { endpoint: string; message: PushMessage }[];
let goneEndpoints: Set<string>;

const fakePush: PushSender = {
  publicKey: 'test-key',
  async send(subscription, message) {
    if (goneEndpoints.has(subscription.endpoint)) throw Object.assign(new Error('gone'), { statusCode: 410 });
    pushed.push({ endpoint: subscription.endpoint, message });
  },
};

const fakeImporter: Importer = {
  async importFromUrl(url: string): Promise<ImportResult> {
    importCalls.push(url);
    return {
      draft: { name: 'Zugspitz Ultratrail', startDate: '2027-06-18', website: url, races: [{ name: 'Basetrail', distanceKm: 43 }] },
      warnings: [],
    };
  },
};

/** Zwei Strecken als Gerade nach Norden: 0,1° Breite sind gut 11 km. */
function line(km: number): TrackInput {
  const lat = 47 + km / 111.2;
  return { name: null, points: [[47, 11, 500], [lat, 11, 900]], distanceKm: km, gainM: 400, lossM: 0, minEle: 500, maxEle: 900 };
}

let gpxSearches: string[];
const fakeFinder: GpxFinder = {
  async search(url) {
    gpxSearches.push(url);
    return {
      files: [
        { url: 'https://example.org/kurz.gpx', fileName: 'kurz.gpx', label: 'Kurz', track: line(22) },
        { url: 'https://example.org/ultra.gpx', fileName: 'ultra.gpx', label: 'Ultra', track: line(69) },
      ],
      external: [{ url: 'https://www.komoot.com/tour/1', service: 'Komoot', label: 'Komoot' }],
      pagesChecked: 3,
    };
  },
  async download(url) {
    if (url.endsWith('ultra.gpx')) return line(69);
    if (url.endsWith('kurz.gpx')) return line(22);
    throw new Error('404');
  },
};

beforeEach(async () => {
  gpxSearches = [];
  pg = await PGlite.create();
  importCalls = [];
  pushed = [];
  goneEndpoints = new Set();
  app = await buildApp({ db: createPgliteDb(pg), tokenSecret: 'test-secret-test-secret', importer: fakeImporter, importsPerHour: 2, push: fakePush, gpxFinder: fakeFinder });
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

describe('Passwort zurücksetzen', () => {
  it('Admin erzeugt Einmal-Link, Mitglied setzt neues Passwort', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    const fremd = await register('fremd@x.de', 'Fremd');
    const path = `/api/groups/${group.body.id}/members/${ben.me.user.id}/reset`;

    // Nur Admins, nicht für sich selbst, nicht für Fremde.
    expect((await call('POST', `/api/groups/${group.body.id}/members/${anna.me.user.id}/reset`, ben.token)).status).toBe(403);
    expect((await call('POST', `/api/groups/${group.body.id}/members/${anna.me.user.id}/reset`, anna.token)).status).toBe(400);
    expect((await call('POST', `/api/groups/${group.body.id}/members/${fremd.me.user.id}/reset`, anna.token)).status).toBe(404);

    const first = await call<{ code: string }>('POST', path, anna.token);
    const reset = await call<{ code: string }>('POST', path, anna.token);
    expect(reset.status).toBe(200);
    // Ein neuer Link macht den alten ungültig.
    expect((await call('GET', `/api/resets/${first.body.code}`)).status).toBe(404);
    expect((await call<{ name: string }>('GET', `/api/resets/${reset.body.code}`)).body.name).toBe('Ben');

    expect((await call('POST', `/api/resets/${reset.body.code}`, undefined, { password: 'kurz' })).status).toBe(400);
    const done = await call<{ token: string; me: Me }>('POST', `/api/resets/${reset.body.code}`, undefined, { password: 'neuesPasswort' });
    expect(done.status).toBe(200);
    expect(done.body.me.user.id).toBe(ben.me.user.id);
    // Alte Sitzungen sind abgemeldet, der Link ist verbraucht, das neue Passwort gilt.
    expect((await call('GET', '/api/me', ben.token)).status).toBe(401);
    expect((await call('POST', `/api/resets/${reset.body.code}`, undefined, { password: 'nochmalNeu1' })).status).toBe(404);
    const login = await call('POST', '/api/auth/login', undefined, { email: 'ben@x.de', password: 'neuesPasswort' });
    expect(login.status).toBe(200);
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
    expect(joined.body.races[0]!.participants).toEqual([{ userId: anna.me.user.id, userName: 'Anna', status: 'registered', teamId: null }]);
    await call('PUT', `/api/races/${kurz.id}/participation`, ben.token, { status: 'interested' });

    // Anna bearbeitet: Ultra bleibt (mit ID), "Kurz" fällt weg, eine neue Strecke kommt dazu.
    const updated = await call<RunEvent>('PUT', `/api/events/${created.body.id}`, anna.token, {
      ...sampleEvent,
      races: [{ ...sampleEvent.races![0], id: ultra.id, fee: 99 }, { name: 'Mini', distanceKm: 10 }],
    });
    expect(updated.status).toBe(200);
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

describe('Unterkünfte', () => {
  it('legt Vorschläge über das Formular an, ändert und entfernt sie gezielt', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const created = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, {
      ...sampleEvent,
      accommodations: [
        { name: 'Hotel Adler', url: 'https://adler.example', price: '90 €' },
        { name: 'Jugendherberge', nights: ['2027-05-02'] },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.accommodations.map((a) => [a.name, a.url, a.price, a.nights])).toEqual([
      ['Hotel Adler', 'https://adler.example', '90 €', []],
      ['Jugendherberge', null, null, ['2027-05-02']],
    ]);
    const [adler, herberge] = created.body.accommodations;
    // Parallel in der Veranstaltung ergänzt: bleibt beim Speichern des Formulars erhalten.
    await call<RunEvent>('POST', `/api/events/${created.body.id}/accommodations`, anna.token, { name: 'Camping' });
    const updated = await call<RunEvent>('PUT', `/api/events/${created.body.id}`, anna.token, {
      ...sampleEvent,
      accommodations: [{ id: adler!.id, name: 'Hotel Adler', price: '95 €' }, { name: 'Pension Rose' }],
      removeAccommodationIds: [herberge!.id],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.accommodations.map((a) => [a.name, a.price])).toEqual([
      ['Hotel Adler', '95 €'],
      ['Camping', null],
      ['Pension Rose', null],
    ]);
    // Ohne das Feld bleiben die Vorschläge unverändert.
    const untouched = await call<RunEvent>('PUT', `/api/events/${created.body.id}`, anna.token, sampleEvent);
    expect(untouched.body.accommodations).toHaveLength(3);
  });

  it('schlägt Unterkünfte vor und merkt sich, wer wo schläft', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    const created = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, sampleEvent);
    const eventId = created.body.id;

    const withHotel = await call<RunEvent>('POST', `/api/events/${eventId}/accommodations`, ben.token, {
      name: 'Hotel Post',
      url: 'https://hotel.example',
      price: 'ca. 90 € / Nacht',
    });
    expect(withHotel.status).toBe(201);
    const hotel = withHotel.body.accommodations[0]!;
    expect(hotel).toMatchObject({ name: 'Hotel Post', price: 'ca. 90 € / Nacht' });

    const annaStay = await call<RunEvent>('PUT', `/api/events/${eventId}/stay`, anna.token, {
      choice: 'suggested',
      accommodationId: hotel.id,
      booked: true,
    });
    expect(annaStay.body.stays).toEqual([
      { userId: anna.me.user.id, userName: 'Anna', night: null, choice: 'suggested', accommodationId: hotel.id, otherText: null, booked: true },
    ]);
    const benStay = await call<RunEvent>('PUT', `/api/events/${eventId}/stay`, ben.token, { choice: 'other', otherText: 'Bei Oma' });
    expect(benStay.body.stays.find((s) => s.userId === ben.me.user.id)).toMatchObject({ choice: 'other', otherText: 'Bei Oma', booked: false });

    // Ohne Auswahl einer Unterkunft geht "suggested" nicht.
    expect((await call('PUT', `/api/events/${eventId}/stay`, ben.token, { choice: 'suggested' })).status).toBe(400);

    // Löschen der Unterkunft nimmt Annas Wahl mit.
    const deleted = await call<RunEvent>('DELETE', `/api/accommodations/${hotel.id}`, ben.token);
    expect(deleted.body.accommodations).toHaveLength(0);
    expect(deleted.body.stays.map((s) => s.userName)).toEqual(['Ben']);

    const reset = await call<RunEvent>('PUT', `/api/events/${eventId}/stay`, ben.token, { choice: null });
    expect(reset.body.stays).toHaveLength(0);

    // Pro Nacht: sampleEvent geht vom 1. bis 2. Mai, also zwei Nächte.
    const hut = (
      await call<RunEvent>('POST', `/api/events/${eventId}/accommodations`, anna.token, { name: 'Hütte', nights: ['2027-05-02'] })
    ).body.accommodations[0]!;
    expect(hut.nights).toEqual(['2027-05-02']);
    await call('PUT', `/api/events/${eventId}/stay`, anna.token, { choice: 'other', otherText: 'Zelt', booked: true });
    const split = await call<RunEvent>('PUT', `/api/events/${eventId}/stay-mode`, anna.token, { perNight: true });
    expect(split.body.stays.map((s) => [s.night, s.otherText])).toEqual([
      ['2027-05-01', 'Zelt'],
      ['2027-05-02', 'Zelt'],
    ]);
    const night2 = await call<RunEvent>('PUT', `/api/events/${eventId}/stay`, anna.token, {
      night: '2027-05-02',
      choice: 'suggested',
      accommodationId: hut.id,
    });
    expect(night2.body.stays.find((s) => s.night === '2027-05-02')).toMatchObject({ accommodationId: hut.id, booked: false });
    expect((await call('PUT', `/api/events/${eventId}/stay`, anna.token, { night: '2027-06-01', choice: 'none' })).status).toBe(400);
    // Wahl für alles ersetzt die einzelnen Nächte.
    const whole = await call<RunEvent>('PUT', `/api/events/${eventId}/stay`, anna.token, { choice: 'none' });
    expect(whole.body.stays.map((s) => s.night)).toEqual([null]);
    await call('PUT', `/api/events/${eventId}/stay-mode`, anna.token, { perNight: true });
    const back = await call<RunEvent>('PUT', `/api/events/${eventId}/stay-mode`, anna.token, { perNight: false });
    expect(back.body.stays).toHaveLength(0);

    // Fremde sehen nichts.
    const fremd = await register('fremd@x.de', 'Fremd');
    expect((await call('POST', `/api/events/${eventId}/accommodations`, fremd.token, { name: 'X' })).status).toBe(404);
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

describe('Push-Benachrichtigungen', () => {
  const sub = (name: string) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: 'p', auth: 'a' } });

  it('meldet neue Veranstaltungen und erinnert einmal an Fristen und Start', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    expect((await call('POST', '/api/push/subscribe', ben.token, sub('ben'))).status).toBe(204);
    expect((await call('POST', '/api/push/subscribe', anna.token, sub('anna'))).status).toBe(204);
    expect((await call('POST', '/api/push/subscribe', anna.token, { endpoint: 'http://x', keys: { p256dh: 'p', auth: 'a' } })).status).toBe(400);

    const created = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, sampleEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ endpoint: 'https://push.example/ben', message: { title: 'Neue Veranstaltung', url: `/#/event/${created.body.id}` } });
    expect(pushed[0]!.message.body).toContain('Anna hat „Chiemgau Trail“ eingetragen');

    // Ben hat nur Interesse am Ultra, Anna ist angemeldet. Anmeldeschluss 1.4., Start 1.5.
    const [ultra] = created.body.races;
    await call('PUT', `/api/races/${ultra!.id}/participation`, ben.token, { status: 'interested' });
    await call('PUT', `/api/races/${ultra!.id}/participation`, anna.token, { status: 'registered' });
    const me = await call<Me>('PATCH', '/api/me', anna.token, { notifications: { eventDays: 3, newEvent: false } });
    expect(me.body.notifications).toEqual({ newEvent: false, deadlineDays: 7, eventDays: 3, comments: true });
    expect((await call('PATCH', '/api/me', anna.token, { notifications: { eventDays: 5 } })).status).toBe(400);

    const db = createPgliteDb(pg);
    pushed = [];
    expect(await runDailyReminders(db, fakePush, '2027-03-20')).toBe(0);
    expect(await runDailyReminders(db, fakePush, '2027-03-26')).toBe(1);
    expect(pushed[0]).toMatchObject({ endpoint: 'https://push.example/ben', message: { title: 'Anmeldeschluss naht' } });
    // Am nächsten Tag nicht noch einmal.
    expect(await runDailyReminders(db, fakePush, '2027-03-27')).toBe(0);

    // Start: Anna (3 Tage) und Ben (Standard 7 Tage, auch mit nur Interesse).
    pushed = [];
    expect(await runDailyReminders(db, fakePush, '2027-04-24')).toBe(1);
    expect(pushed.map((p) => p.endpoint)).toEqual(['https://push.example/ben']);
    expect(await runDailyReminders(db, fakePush, '2027-04-30')).toBe(1);
    expect(pushed[1]).toMatchObject({ endpoint: 'https://push.example/anna', message: { body: '„Chiemgau Trail“ beginnt morgen.' } });

    // Ein totes Abonnement wird beim nächsten Versand entfernt.
    goneEndpoints.add('https://push.example/ben');
    await call('POST', `/api/groups/${group.body.id}/events`, anna.token, { ...sampleEvent, name: 'Zweites' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const left = await pg.query<{ endpoint: string }>('select endpoint from push_subscriptions');
    expect(left.rows.map((r) => r.endpoint)).toEqual(['https://push.example/anna']);
  });
});

describe('Kommentare', () => {
  it('schreibt, zählt, benachrichtigt und löscht nur eigene', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    const carla = await register('carla@x.de', 'Carla', group.body.inviteCode);
    const created = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, sampleEvent);
    const id = created.body.id;
    expect(created.body.comments).toEqual({ count: 0, lastAt: null, lastBy: null });
    await call('PUT', `/api/races/${created.body.races[0]!.id}/participation`, ben.token, { status: 'registered' });
    await call('POST', '/api/push/subscribe', ben.token, { endpoint: 'https://push.example/ben', keys: { p256dh: 'p', auth: 'a' } });
    await call('POST', '/api/push/subscribe', carla.token, { endpoint: 'https://push.example/carla', keys: { p256dh: 'p', auth: 'a' } });
    pushed = [];

    const first = await call<EventComment[]>('POST', `/api/events/${id}/comments`, anna.token, { text: 'Wer fährt mit?' });
    expect(first.status).toBe(201);
    expect(first.body.map((c) => [c.userName, c.text])).toEqual([['Anna', 'Wer fährt mit?']]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Ben ist eingetragen, Carla nicht.
    expect(pushed.map((p) => [p.endpoint, p.message.title, p.message.body])).toEqual([
      ['https://push.example/ben', 'Anna · Chiemgau Trail', 'Wer fährt mit?'],
    ]);

    // Carla schreibt mit und bekommt danach auch Antworten.
    await call('POST', `/api/events/${id}/comments`, carla.token, { text: 'Ich!' });
    pushed = [];
    await call('POST', `/api/events/${id}/comments`, ben.token, { text: 'Super' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed.map((p) => p.endpoint)).toEqual(['https://push.example/carla']);

    const event = await call<RunEvent>('GET', `/api/events/${id}`, anna.token);
    expect(event.body.comments).toMatchObject({ count: 3, lastBy: ben.me.user.id });
    expect((await call('POST', `/api/events/${id}/comments`, anna.token, { text: '   ' })).status).toBe(400);

    const list = await call<EventComment[]>('GET', `/api/events/${id}/comments`, ben.token);
    const annas = list.body[0]!;
    expect((await call('DELETE', `/api/comments/${annas.id}`, ben.token)).status).toBe(403);
    const after = await call<EventComment[]>('DELETE', `/api/comments/${annas.id}`, anna.token);
    expect(after.body.map((c) => c.text)).toEqual(['Ich!', 'Super']);

    const fremd = await register('fremd@x.de', 'Fremd');
    expect((await call('GET', `/api/events/${id}/comments`, fremd.token)).status).toBe(404);
  });
});

describe('Streckenverlauf', () => {
  it('speichert GPX-Verlauf, füllt leere Werte und liefert Punkte', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const created = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, {
      ...sampleEvent,
      races: [{ name: 'Ohne Werte' }, { name: 'Mit Werten', distanceKm: 21, elevationUpM: 900, itraPoints: 2 }],
    });
    const [empty, filled] = created.body.races;
    expect([empty!.itraPoints, filled!.itraPoints]).toEqual([null, 2]);
    expect(empty!.track).toBe(null);
    const track = {
      name: 'Basetrail',
      points: [
        [47.4, 11.0, 700],
        [47.5, 11.1, 2900],
      ],
      distanceKm: 43.24,
      gainM: 2200,
      lossM: 0,
      minEle: 700,
      maxEle: 2900,
    };
    const a = await call<RunEvent>('PUT', `/api/races/${empty!.id}/track`, anna.token, track);
    expect(a.status).toBe(200);
    expect(a.body.races[0]).toMatchObject({ distanceKm: 43.2, elevationUpM: 2200, elevationDownM: 0, track: { name: 'Basetrail', gainM: 2200 } });
    const b = await call<RunEvent>('PUT', `/api/races/${filled!.id}/track`, anna.token, track);
    expect(b.body.races[1]).toMatchObject({ distanceKm: 21, elevationUpM: 900 });

    const got = await call<{ points: number[][] }>('GET', `/api/races/${empty!.id}/track`, anna.token);
    expect(got.body.points).toEqual(track.points);
    expect((await call('PUT', `/api/races/${empty!.id}/track`, anna.token, { ...track, points: [[95, 0, null], [0, 0, null]] })).status).toBe(400);

    const fremd = await register('fremd@x.de', 'Fremd');
    expect((await call('GET', `/api/races/${empty!.id}/track`, fremd.token)).status).toBe(404);
    const removed = await call<RunEvent>('DELETE', `/api/races/${empty!.id}/track`, anna.token);
    expect(removed.body.races[0]!.track).toBe(null);
    // Beim Bearbeiten der Veranstaltung bleibt der Verlauf einer bekannten Strecke erhalten.
    const kept = await call<RunEvent>('PUT', `/api/events/${created.body.id}`, anna.token, {
      ...sampleEvent,
      races: b.body.races.map((r) => ({ id: r.id, name: r.name })),
    });
    expect(kept.body.races[1]!.track).not.toBe(null);
  });
});

describe('Kosten teilen', () => {
  it('erfasst Ausgaben, prüft Rechte und hält erledigte Zahlungen fest', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    const carla = await register('carla@x.de', 'Carla', group.body.inviteCode);
    const fremd = await register('fremd@x.de', 'Fremd');
    const [a, b, c] = [anna.me.user.id, ben.me.user.id, carla.me.user.id];
    const created = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, sampleEvent);
    const id = created.body.id;
    expect(created.body.expenses).toEqual([]);

    const hut = { paidBy: a, description: 'Hütte', amountCents: 24000, shares: splitEqually(24000, [a, b, c]) };
    const added = await call<RunEvent>('POST', `/api/events/${id}/expenses`, carla.token, hut);
    expect(added.status).toBe(201);
    const expense = added.body.expenses[0]!;
    expect(expense).toMatchObject({ paidByName: 'Anna', description: 'Hütte', amountCents: 24000, currency: 'EUR', createdBy: c });
    expect(expense.shares.map((s) => [s.userName, s.amountCents])).toEqual([
      ['Anna', 8000],
      ['Ben', 8000],
      ['Carla', 8000],
    ]);

    // Ungültige Eingaben und Fremde.
    expect((await call('POST', `/api/events/${id}/expenses`, anna.token, { ...hut, amountCents: 1 })).status).toBe(400);
    expect(
      (await call('POST', `/api/events/${id}/expenses`, anna.token, { ...hut, shares: [{ userId: fremd.me.user.id, amountCents: 24000 }] }))
        .status,
    ).toBe(400);
    expect((await call('POST', `/api/events/${id}/expenses`, fremd.token, hut)).status).toBe(404);

    // Ben hat weder bezahlt noch erfasst und ist kein Admin.
    expect((await call('PUT', `/api/expenses/${expense.id}`, ben.token, hut)).status).toBe(403);
    const edited = await call<RunEvent>('PUT', `/api/expenses/${expense.id}`, anna.token, {
      ...hut,
      shares: [
        { userId: a, amountCents: 0 },
        { userId: b, amountCents: 12000 },
        { userId: c, amountCents: 12000 },
      ],
    });
    // Anteile von 0 werden nicht gespeichert.
    expect(edited.body.expenses[0]!.shares.map((s) => s.userName)).toEqual(['Ben', 'Carla']);

    const settled = await call<Settlement[]>('POST', `/api/groups/${group.body.id}/settlements`, ben.token, {
      fromUser: b,
      toUser: a,
      amountCents: 12000,
      currency: 'EUR',
    });
    expect(settled.status).toBe(201);
    const transfers = settleUp(edited.body.expenses, settled.body);
    expect(transfers.map((t) => `${t.fromName}→${t.toName} ${t.amountCents}`)).toEqual(['Carla→Anna 12000']);

    expect((await call('GET', `/api/groups/${group.body.id}/settlements`, fremd.token)).status).toBe(404);
    expect((await call('DELETE', `/api/settlements/${settled.body[0]!.id}`, carla.token)).status).toBe(403);
    expect((await call<Settlement[]>('DELETE', `/api/settlements/${settled.body[0]!.id}`, ben.token)).body).toEqual([]);

    const removed = await call<RunEvent>('DELETE', `/api/expenses/${expense.id}`, carla.token);
    expect(removed.body.expenses).toEqual([]);
  });
});

describe('GPX-Suche', () => {
  it('schlägt Dateien nach Distanz vor und übernimmt bestätigte', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const created = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, sampleEvent);
    const [ultra, kurz] = created.body.races;

    const found = await call<GpxSearchResult>('POST', `/api/events/${created.body.id}/gpx-search`, anna.token);
    expect(found.status).toBe(200);
    expect(gpxSearches).toEqual(['https://example.org']);
    expect(found.body.matchedBy).toBe('distance');
    expect(found.body.candidates.map((c) => [c.fileName, c.raceId, c.distanceKm])).toEqual([
      ['kurz.gpx', kurz!.id, 22],
      ['ultra.gpx', ultra!.id, 69],
    ]);
    expect(found.body.external[0]!.service).toBe('Komoot');

    const applied = await call<RunEvent>('POST', `/api/events/${created.body.id}/gpx-apply`, anna.token, {
      items: [{ raceId: ultra!.id, url: 'https://example.org/ultra.gpx' }],
    });
    expect(applied.status).toBe(200);
    expect(applied.body.races[0]!.track).toMatchObject({ distanceKm: 69, gainM: 400 });
    expect(applied.body.races[1]!.track).toBeNull();

    const broken = await call('POST', `/api/events/${created.body.id}/gpx-apply`, anna.token, {
      items: [{ raceId: kurz!.id, url: 'https://example.org/weg.gpx' }],
    });
    expect(broken.status).toBe(422);
    const foreign = await call('POST', `/api/events/${created.body.id}/gpx-apply`, anna.token, {
      items: [{ raceId: 'fremd', url: 'https://example.org/ultra.gpx' }],
    });
    expect(foreign.status).toBe(400);
    // Zähler: höchstens zwei Suchen pro Stunde in den Tests.
    await call('POST', `/api/events/${created.body.id}/gpx-search`, anna.token);
    expect((await call('POST', `/api/events/${created.body.id}/gpx-search`, anna.token)).status).toBe(429);
  });

  it('nutzt die KI-Zuordnung, wenn vorhanden', async () => {
    await app.close();
    app = await buildApp({
      db: createPgliteDb(pg),
      tokenSecret: 'test-secret-test-secret',
      importer: { ...fakeImporter, matchTracks: async (races) => new Map(races.map((r, i) => [r.id, i === 0 ? 0 : null])) },
      gpxFinder: fakeFinder,
    });
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const created = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, sampleEvent);
    const found = await call<GpxSearchResult>('POST', `/api/events/${created.body.id}/gpx-search`, anna.token);
    expect(found.body.matchedBy).toBe('ai');
    expect(found.body.candidates.map((c) => c.raceId)).toEqual([created.body.races[0]!.id, null]);
  });
});

describe('Teamstrecken', () => {
  it('Teams gründen und beitreten, eine Person zahlt, Ausgabe wird angelegt', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    const carla = await register('carla@x.de', 'Carla', group.body.inviteCode);
    const dora = await register('dora@x.de', 'Dora', group.body.inviteCode);
    const [a, b, c] = [anna.me.user.id, ben.me.user.id, carla.me.user.id];
    const created = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, {
      ...sampleEvent,
      races: [{ name: 'Staffel', fee: 220, teamSize: 3 }],
    });
    const race = created.body.races[0]!;
    expect(race.teamSize).toBe(3);
    const url = `/api/races/${race.id}/participation`;

    // Anna gründet ein Team, Ben und Carla treten bei.
    const founded = await call<RunEvent>('PUT', url, anna.token, { status: 'registered' });
    const team = founded.body.races[0]!.teams[0]!;
    expect(team).toMatchObject({ name: 'Team Anna', payerId: a, expenseId: null });
    await call('PUT', url, ben.token, { status: 'registered', teamId: team.id });
    await call('PUT', url, carla.token, { status: 'interested', teamId: team.id });
    // Das Team ist voll.
    expect((await call('PUT', url, dora.token, { status: 'registered', teamId: team.id })).status).toBe(409);
    // Nur die zahlende Person setzt „Bezahlt“.
    expect((await call('PUT', url, ben.token, { status: 'paid' })).status).toBe(403);

    const paid = await call<RunEvent>('PUT', url, anna.token, { status: 'paid' });
    const after = paid.body.races[0]!;
    expect(after.participants.filter((p) => p.teamId === team.id).map((p) => p.status)).toEqual(['paid', 'paid', 'paid']);
    const expense = paid.body.expenses[0]!;
    expect(expense).toMatchObject({ paidBy: a, amountCents: 22000, description: 'Startgebühr Staffel (Team Anna)' });
    expect(expense.shares.map((s) => [s.userId, s.amountCents])).toEqual([
      [a, 7334],
      [b, 7333],
      [c, 7333],
    ]);
    expect(after.teams[0]!.expenseId).toBe(expense.id);
    // Nur einmal angelegt, auch wenn jemand erneut speichert.
    const again = await call<RunEvent>('PUT', url, ben.token, { status: 'registered' });
    expect(again.body.expenses).toHaveLength(1);
    expect(again.body.races[0]!.participants.find((p) => p.userId === b)!.status).toBe('paid');

    // Dora gründet ein zweites Team.
    const second = await call<RunEvent>('PUT', url, dora.token, { status: 'interested', teamId: 'new' });
    expect(second.body.races[0]!.teams.map((t) => t.name)).toEqual(['Team Anna', 'Team Dora']);

    // Doch nicht bezahlt: Status zurück, Ausgabe weg.
    const unpaid = await call<RunEvent>('PUT', url, anna.token, { status: 'registered' });
    expect(unpaid.body.expenses).toEqual([]);
    expect(unpaid.body.races[0]!.participants.find((p) => p.userId === b)!.status).toBe('registered');

    // Zahlende Person wechseln, nur innerhalb des Teams.
    expect((await call('PUT', `/api/teams/${team.id}`, ben.token, { payerId: dora.me.user.id })).status).toBe(400);
    const switched = await call<RunEvent>('PUT', `/api/teams/${team.id}`, ben.token, { payerId: b, name: 'Die Gämsen' });
    expect(switched.body.races[0]!.teams[0]).toMatchObject({ name: 'Die Gämsen', payerId: b, payerName: 'Ben' });

    // Ben tritt aus: Anna zahlt wieder. Leere Teams verschwinden.
    const left = await call<RunEvent>('PUT', url, ben.token, { status: null });
    expect(left.body.races[0]!.teams[0]!.payerId).toBe(a);
    const gone = await call<RunEvent>('PUT', url, dora.token, { status: null });
    expect(gone.body.races[0]!.teams).toHaveLength(1);

    // Keine Teamstrecke mehr: Teams weg, Anmeldungen bleiben.
    const edited = await call<RunEvent>('PUT', `/api/events/${created.body.id}`, anna.token, {
      ...sampleEvent,
      races: [{ id: race.id, name: 'Staffel', fee: 220 }],
    });
    expect(edited.body.races[0]!.teams).toEqual([]);
    expect(edited.body.races[0]!.participants.map((p) => p.teamId)).toEqual([null, null]);
  });
});

describe('Kalender-Abo', () => {
  it('liefert nur angemeldete Strecken mit festen UIDs und lässt sich erneuern', async () => {
    const anna = await register('anna@x.de', 'Anna');
    const group = await call<GroupDetail>('POST', '/api/groups', anna.token, { name: 'Familie' });
    const ben = await register('ben@x.de', 'Ben', group.body.inviteCode);
    const event = await call<RunEvent>('POST', `/api/groups/${group.body.id}/events`, anna.token, sampleEvent);
    const [ultra, kurz] = event.body.races as [RunEvent['races'][number], RunEvent['races'][number]];
    await call('PUT', `/api/races/${ultra.id}/participation`, anna.token, { status: 'paid' });
    await call('PUT', `/api/races/${kurz.id}/participation`, anna.token, { status: 'interested' });
    await call('PUT', `/api/races/${kurz.id}/participation`, ben.token, { status: 'registered' });

    expect((await call('GET', '/api/me/calendar')).status).toBe(401);
    const link = await call<{ token: string }>('GET', '/api/me/calendar', anna.token);
    expect(link.body.token.length).toBeGreaterThanOrEqual(30);
    // Gleicher Link beim nächsten Abruf.
    expect((await call<{ token: string }>('GET', '/api/me/calendar', anna.token)).body.token).toBe(link.body.token);

    const feed = await app.inject({ method: 'GET', url: `/api/calendar/${link.body.token}.ics` });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('text/calendar');
    const ics = feed.body.replace(/\r\n /g, '');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain(`UID:${ultra.id}@runplanner`);
    expect(ics).toContain('DTSTART:20270501T060000');
    expect(ics).toContain('SUMMARY:Chiemgau Trail – Ultra (70 km)');
    expect(ics).not.toContain(kurz.id);

    const download = await app.inject({ method: 'GET', url: `/api/calendar/${link.body.token}.ics?download=1` });
    expect(download.headers['content-disposition']).toContain('attachment');

    const renewed = await call<{ token: string }>('POST', '/api/me/calendar', anna.token);
    expect(renewed.body.token).not.toBe(link.body.token);
    expect((await app.inject({ method: 'GET', url: `/api/calendar/${link.body.token}.ics` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/calendar/${renewed.body.token}.ics` })).statusCode).toBe(200);
  });
});
