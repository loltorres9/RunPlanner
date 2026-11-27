/**
 * Datenbankzugriff.
 *
 * Der Server spricht nur über dieses schmale Interface mit Postgres. Im Betrieb steckt
 * dahinter ein `pg`-Pool, in den Tests und lokal ein eingebettetes Postgres (PGlite).
 */

export interface QueryResult<T> {
  rows: T[];
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Mehrere Anweisungen am Stück, ohne Parameter — nur für das Schema. */
  exec(sql: string): Promise<void>;
  /** Führt die Funktion in einer Transaktion aus und rollt bei Fehlern zurück. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Schema. Wird bei jedem Start ausgeführt und ist absichtlich idempotent. Neue Spalten
 * kommen später mit `alter table ... add column if not exists` dazu.
 *
 * Tage sind `text` (JJJJ-MM-TT), Zeitstempel `bigint` in Millisekunden.
 */
export const SCHEMA = `
create table if not exists app_config (
  key text primary key,
  value text not null
);

create table if not exists users (
  id text primary key,
  email text not null unique,
  name text not null,
  password_hash text not null,
  language text not null default 'de',
  created_at bigint not null,
  token_epoch integer not null default 0
);

-- Einmal-Links zum Zurücksetzen des Passworts, die ein Gruppen-Admin erzeugt.
-- Gespeichert wird nur der SHA-256 des Codes.
create table if not exists password_resets (
  code_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_by text not null,
  expires_at bigint not null
);

create table if not exists groups (
  id text primary key,
  name text not null,
  invite_code text not null unique,
  created_at bigint not null
);

create table if not exists memberships (
  group_id text not null references groups(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  joined_at bigint not null,
  primary key (group_id, user_id)
);

create index if not exists memberships_user_idx on memberships (user_id);

create table if not exists events (
  id text primary key,
  group_id text not null references groups(id) on delete cascade,
  name text not null,
  location text,
  start_date text not null,
  end_date text,
  website text,
  registration_deadline text,
  currency text not null default 'EUR',
  accommodation_needed boolean not null default false,
  accommodation_booked boolean not null default false,
  accommodation_notes text,
  notes text,
  created_by text not null references users(id),
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists events_group_date_idx on events (group_id, start_date);

create table if not exists races (
  id text primary key,
  event_id text not null references events(id) on delete cascade,
  position integer not null,
  name text not null,
  distance_km double precision,
  elevation_up_m integer,
  elevation_down_m integer,
  start_date text,
  start_time text,
  fee double precision,
  fee_note text,
  cutoff text
);

create index if not exists races_event_idx on races (event_id);

create table if not exists participations (
  race_id text not null references races(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  status text not null check (status in ('interested', 'registered', 'paid')),
  updated_at bigint not null,
  primary key (race_id, user_id)
);

-- Vorgeschlagene Unterkünfte einer Veranstaltung.
create table if not exists accommodations (
  id text primary key,
  event_id text not null references events(id) on delete cascade,
  name text not null,
  url text,
  price text,
  notes text,
  created_by text not null references users(id),
  created_at bigint not null
);

create index if not exists accommodations_event_idx on accommodations (event_id);

-- Wer wo übernachtet. Wird eine vorgeschlagene Unterkunft gelöscht, entfällt auch die
-- Wahl derer, die dort schlafen wollten; sie tauchen dann wieder als offen auf.
create table if not exists stays (
  event_id text not null references events(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  choice text not null check (choice in ('none', 'suggested', 'other')),
  accommodation_id text references accommodations(id) on delete cascade,
  other_text text,
  booked boolean not null default false,
  updated_at bigint not null,
  primary key (event_id, user_id)
);

-- Nächte, für die ein Vorschlag gedacht ist (Etappenorte), als Tage mit Komma getrennt.
alter table accommodations add column if not exists nights text not null default '';

-- Wahl pro Nacht bei mehrtägigen Veranstaltungen. Wer pro Nacht wählt, hat keinen
-- Eintrag in stays; night ist der Lauftag, vor dem die Nacht liegt.
create table if not exists night_stays (
  event_id text not null references events(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  night text not null,
  choice text not null check (choice in ('none', 'suggested', 'other')),
  accommodation_id text references accommodations(id) on delete cascade,
  other_text text,
  booked boolean not null default false,
  updated_at bigint not null,
  primary key (event_id, user_id, night)
);

-- Push-Benachrichtigungen: ein Abonnement pro Gerät.
create table if not exists push_subscriptions (
  endpoint text primary key,
  user_id text not null references users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at bigint not null,
  last_success_at bigint,
  last_error text
);

-- Schon verschickte Erinnerungen, damit jede nur einmal kommt.
create table if not exists push_sent (
  user_id text not null references users(id) on delete cascade,
  key text not null,
  sent_at bigint not null,
  primary key (user_id, key)
);

alter table users add column if not exists notify_new_event boolean not null default true;
alter table users add column if not exists notify_deadline_days integer not null default 7;
alter table users add column if not exists notify_event_days integer not null default 7;
alter table users add column if not exists notify_comments boolean not null default true;

-- Kommentare zu einer Veranstaltung.
create table if not exists comments (
  id text primary key,
  event_id text not null references events(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  text text not null,
  created_at bigint not null
);

create index if not exists comments_event_idx on comments (event_id, created_at);

-- Streckenverlauf aus einer GPX-Datei, ausgedünnt, als JSON [[lat, lon, ele], ...].
create table if not exists race_tracks (
  race_id text primary key references races(id) on delete cascade,
  name text,
  points text not null,
  distance_km double precision not null,
  gain_m integer,
  loss_m integer,
  min_ele integer,
  max_ele integer,
  uploaded_by text not null references users(id),
  uploaded_at bigint not null
);

-- Kosten teilen: Ausgaben einer Veranstaltung, Beträge in Cent.
create table if not exists expenses (
  id text primary key,
  event_id text not null references events(id) on delete cascade,
  paid_by text not null references users(id),
  description text not null,
  amount_cents integer not null,
  created_by text not null references users(id),
  created_at bigint not null
);

create index if not exists expenses_event_idx on expenses (event_id);

-- Wer welchen Anteil einer Ausgabe trägt.
create table if not exists expense_shares (
  expense_id text not null references expenses(id) on delete cascade,
  user_id text not null references users(id),
  amount_cents integer not null,
  primary key (expense_id, user_id)
);

-- Erledigte Zahlungen zwischen zwei Personen einer Gruppe.
create table if not exists settlements (
  id text primary key,
  group_id text not null references groups(id) on delete cascade,
  from_user text not null references users(id),
  to_user text not null references users(id),
  amount_cents integer not null,
  currency text not null,
  created_by text not null references users(id),
  created_at bigint not null
);

create index if not exists settlements_group_idx on settlements (group_id, created_at);

-- Teamstrecken: Teamgröße an der Strecke, Teams mit einer zahlenden Person.
alter table races add column if not exists team_size integer;
alter table races add column if not exists itra_points integer;

create table if not exists race_teams (
  id text primary key,
  race_id text not null references races(id) on delete cascade,
  name text not null,
  payer_id text not null references users(id),
  -- Automatisch angelegte Ausgabe für die Gebühr; wer sie löscht, löscht nur sie.
  expense_id text references expenses(id) on delete set null,
  created_at bigint not null
);

create index if not exists race_teams_race_idx on race_teams (race_id);

alter table participations add column if not exists team_id text references race_teams(id) on delete set null;
alter table participations add column if not exists joined_at bigint;
`;

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA);
}
