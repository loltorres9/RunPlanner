/**
 * Push-Benachrichtigungen (Web Push mit VAPID).
 *
 * Der Server baut den Text selbst, in der Sprache der Person, und schickt ihn mit einem
 * Link auf die Veranstaltung. Tote Abonnements (App deinstalliert, anderer Schlüssel)
 * werden beim Versand aufgeräumt.
 */

import webpush from 'web-push';
import { addDays, type Language } from '@runplanner/shared';
import type { Db } from './db.js';

export interface PushMessage {
  title: string;
  body: string;
  /** Pfad in der App, z. B. `/#/event/123`. */
  url: string;
  /** Gleiche Tags ersetzen einander auf dem Gerät. */
  tag: string;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Zustellung an ein einzelnes Abonnement. Wirft bei Fehlern mit `statusCode`. */
export interface PushSender {
  publicKey: string;
  send(subscription: PushSubscriptionData, message: PushMessage): Promise<void>;
}

/**
 * VAPID-Schlüssel aus der Umgebung oder, wenn dort keine stehen, einmal erzeugt und in
 * `app_config` abgelegt. So muss auf Railway nichts eingerichtet werden.
 */
export async function createWebPushSender(
  db: Db,
  env: { publicKey?: string; privateKey?: string; subject?: string },
): Promise<PushSender> {
  let keys = env.publicKey && env.privateKey ? { publicKey: env.publicKey, privateKey: env.privateKey } : null;
  if (keys === null) {
    const generated = webpush.generateVAPIDKeys();
    await db.query('insert into app_config (key, value) values ($1, $2) on conflict (key) do nothing', [
      'vapid_keys',
      JSON.stringify(generated),
    ]);
    const stored = await db.query<{ value: string }>('select value from app_config where key = $1', ['vapid_keys']);
    keys = JSON.parse(stored.rows[0]?.value ?? JSON.stringify(generated)) as { publicKey: string; privateKey: string };
  }
  const vapidDetails = {
    subject: env.subject ?? 'mailto:runplanner@users.noreply.github.com',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  return {
    publicKey: keys.publicKey,
    async send(subscription, message) {
      await webpush.sendNotification(subscription, JSON.stringify(message), { vapidDetails, TTL: 24 * 60 * 60 });
    },
  };
}

/** Schickt Nachrichten an alle Geräte der Personen. Liefert die Zahl der Zustellungen je Person. */
export async function deliver(
  db: Db,
  sender: PushSender | null,
  messages: Map<string, PushMessage>,
  log: (message: string) => void = () => {},
): Promise<Map<string, number>> {
  const delivered = new Map<string, number>();
  if (sender === null || messages.size === 0) return delivered;
  const subscriptions = await db.query<{ endpoint: string; p256dh: string; auth: string; user_id: string }>(
    'select endpoint, p256dh, auth, user_id from push_subscriptions where user_id = any($1::text[])',
    [[...messages.keys()]],
  );
  for (const row of subscriptions.rows) {
    const message = messages.get(row.user_id);
    if (message === undefined) continue;
    try {
      await sender.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, message);
      delivered.set(row.user_id, (delivered.get(row.user_id) ?? 0) + 1);
      await db.query('update push_subscriptions set last_success_at = $1, last_error = null where endpoint = $2', [
        Date.now(),
        row.endpoint,
      ]);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      log(`Push fehlgeschlagen (${status ?? 'keine Antwort'}): ${String(error)}`);
      // 404/410: Abonnement weg. 401/403: mit einem anderen Schlüssel angelegt. Beides
      // heilt nicht von selbst; die App meldet sich beim nächsten Einschalten neu an.
      if (status === 404 || status === 410 || status === 401 || status === 403) {
        await db.query('delete from push_subscriptions where endpoint = $1', [row.endpoint]);
      } else {
        await db.query('update push_subscriptions set last_error = $1 where endpoint = $2', [
          String(status ?? 'unreachable'),
          row.endpoint,
        ]);
      }
    }
  }
  return delivered;
}

// Texte -------------------------------------------------------------------------

const TEXT = {
  de: {
    newEventTitle: 'Neue Veranstaltung',
    newEventBody: '{name} hat „{event}“ eingetragen ({date}).',
    deadlineTitle: 'Anmeldeschluss naht',
    deadlineBody: '„{event}“: Anmeldung bis {date}. Du hast bisher nur Interesse.',
    deadlineToday: '„{event}“: Heute ist Anmeldeschluss. Du hast bisher nur Interesse.',
    eventTitle: 'Bald geht es los',
    eventBody: '„{event}“ beginnt am {date}.',
    eventTomorrow: '„{event}“ beginnt morgen.',
    eventToday: '„{event}“ beginnt heute. Viel Spaß!',
  },
  en: {
    newEventTitle: 'New event',
    newEventBody: '{name} added “{event}” ({date}).',
    deadlineTitle: 'Registration closing soon',
    deadlineBody: '“{event}”: register by {date}. You are only marked as interested so far.',
    deadlineToday: '“{event}”: registration closes today. You are only marked as interested so far.',
    eventTitle: 'Coming up',
    eventBody: '“{event}” starts on {date}.',
    eventTomorrow: '“{event}” starts tomorrow.',
    eventToday: '“{event}” starts today. Have fun!',
  },
} as const;

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

function formatDay(day: string, language: Language): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(language === 'de' ? 'de-DE' : 'en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

// Auslöser ------------------------------------------------------------------------

/** Alle anderen in der Gruppe, die neue Veranstaltungen gemeldet haben wollen. */
export async function notifyNewEvent(
  db: Db,
  sender: PushSender | null,
  event: { id: string; groupId: string; name: string; startDate: string; createdBy: string; createdByName: string },
  log?: (message: string) => void,
): Promise<void> {
  if (sender === null) return;
  const people = await db.query<{ id: string; language: Language }>(
    `select u.id, u.language from users u join memberships m on m.user_id = u.id
     where m.group_id = $1 and u.id <> $2 and u.notify_new_event`,
    [event.groupId, event.createdBy],
  );
  const messages = new Map<string, PushMessage>();
  for (const person of people.rows) {
    const text = TEXT[person.language] ?? TEXT.de;
    messages.set(person.id, {
      title: text.newEventTitle,
      body: fill(text.newEventBody, {
        name: event.createdByName,
        event: event.name,
        date: formatDay(event.startDate, person.language),
      }),
      url: `/#/event/${event.id}`,
      tag: `event-${event.id}`,
    });
  }
  await deliver(db, sender, messages, log);
}

/**
 * Erinnerungen eines Tages: Anmeldeschluss (nur mit Interesse, noch nicht angemeldet)
 * und bevorstehende Veranstaltungen (mit irgendeinem Eintrag). Jede Erinnerung geht
 * genau einmal raus; verschiebt sich das Datum, gilt sie als neu.
 */
export async function runDailyReminders(
  db: Db,
  sender: PushSender | null,
  today: string,
  log?: (message: string) => void,
): Promise<number> {
  if (sender === null) return 0;
  const candidates = await db.query<{
    user_id: string;
    language: Language;
    deadline_days: number;
    event_days: number;
    event_id: string;
    name: string;
    start_date: string;
    registration_deadline: string | null;
    statuses: string[];
  }>(
    `select u.id as user_id, u.language, u.notify_deadline_days as deadline_days, u.notify_event_days as event_days,
            e.id as event_id, e.name, e.start_date, e.registration_deadline,
            array_agg(p.status) as statuses
     from users u
     join participations p on p.user_id = u.id
     join races r on r.id = p.race_id
     join events e on e.id = r.event_id
     join memberships m on m.group_id = e.group_id and m.user_id = u.id
     where exists (select 1 from push_subscriptions s where s.user_id = u.id)
       and (e.start_date >= $1 or e.registration_deadline >= $1)
     group by u.id, e.id`,
    [today],
  );

  const due: { userId: string; key: string; message: PushMessage }[] = [];
  for (const row of candidates.rows) {
    const text = TEXT[row.language] ?? TEXT.de;
    const onlyInterested = row.statuses.every((status) => status === 'interested');
    const deadline = row.registration_deadline;
    if (row.deadline_days > 0 && onlyInterested && deadline !== null && deadline >= today && deadline <= addDays(today, row.deadline_days)) {
      due.push({
        userId: row.user_id,
        key: `${row.event_id}:deadline:${deadline}`,
        message: {
          title: text.deadlineTitle,
          body: fill(deadline === today ? text.deadlineToday : text.deadlineBody, {
            event: row.name,
            date: formatDay(deadline, row.language),
          }),
          url: `/#/event/${row.event_id}`,
          tag: `deadline-${row.event_id}`,
        },
      });
    }
    const start = row.start_date;
    if (row.event_days > 0 && start >= today && start <= addDays(today, row.event_days)) {
      const body = start === today ? text.eventToday : start === addDays(today, 1) ? text.eventTomorrow : text.eventBody;
      due.push({
        userId: row.user_id,
        key: `${row.event_id}:start:${start}`,
        message: {
          title: text.eventTitle,
          body: fill(body, { event: row.name, date: formatDay(start, row.language) }),
          url: `/#/event/${row.event_id}`,
          tag: `start-${row.event_id}`,
        },
      });
    }
  }

  let sent = 0;
  for (const item of due) {
    // Erst eintragen, dann senden: Läuft die Prüfung doppelt, gewinnt nur eine.
    const claimed = await db.query(
      'insert into push_sent (user_id, key, sent_at) values ($1, $2, $3) on conflict do nothing returning key',
      [item.userId, item.key, Date.now()],
    );
    if (claimed.rows.length === 0) continue;
    const delivered = await deliver(db, sender, new Map([[item.userId, item.message]]), log);
    if ((delivered.get(item.userId) ?? 0) === 0) {
      // Nichts angekommen (z. B. Abo gerade ungültig): später noch einmal versuchen.
      await db.query('delete from push_sent where user_id = $1 and key = $2', [item.userId, item.key]);
    } else sent += 1;
  }
  return sent;
}

/** Heutiger Tag und Stunde in der Zeitzone der Gruppe (Standard Europe/Berlin). */
export function localNow(at: number, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
