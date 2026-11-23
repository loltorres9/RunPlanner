# RunPlanner

Gemeinsamer Kalender für Trailrun-Veranstaltungen. Eine Laufgruppe (z. B. die Familie)
trägt Läufe ein, jede Person sieht, wer welche Strecke läuft, was es kostet und ob die
Unterkunft schon gebucht ist. Deutsch und Englisch.

Die App ist eine **PWA**: Sie läuft im Browser und lässt sich auf Android und iPhone wie
eine normale App auf den Startbildschirm legen, ohne App Store.

## Funktionen

- **Konten und Laufgruppen.** Wer eine Gruppe anlegt, ist Admin und teilt einen
  Einladungslink. Mehrere Gruppen pro Person sind möglich.
- **Veranstaltungen** mit Ort, Datum (auch mehrtägig), Website, Anmeldeschluss, Währung,
  Notizen und **Unterkunft nötig / gebucht**.
- **Mehrere Strecken pro Veranstaltung** mit Distanz, Höhenmetern (auf und ab), Starttag,
  Startzeit, Startgebühr, Hinweis zur Gebühr (z. B. Frühbucher) und Zeitlimit.
- **Teilnahme pro Strecke:** Interesse, angemeldet oder bezahlt. Jede Person setzt ihren
  eigenen Status.
- **Kalender** (Monatsansicht) und **Terminliste** mit Filter „Nur meine“.
- **Hinweise** auf offene Unterkunft und nahenden oder verpassten Anmeldeschluss.
- **Kostenübersicht** pro Person und Jahr.
- **Import von der Website:** Link einfügen, Claude liest Strecken, Startzeiten,
  Höhenmeter und Gebühren aus und füllt das Formular vor. Gespeichert wird erst nach
  dem Prüfen.
- **GPX-Suche:** Durchsucht die Website einer Veranstaltung (Startseite und bis zu sechs
  Unterseiten) nach GPX-Dateien und ordnet sie den Strecken zu, mit Claude oder ohne
  API-Schlüssel nach Distanz. Übernommen wird erst nach Bestätigung. Links zu Komoot,
  Strava & Co. werden nur angezeigt.
- **Kosten teilen:** Ausgaben pro Veranstaltung, „Wer schuldet wem“ im Tab Kosten.

Rechte: Jedes Mitglied darf Veranstaltungen anlegen und bearbeiten. Löschen dürfen die
Person, die sie angelegt hat, und Admins.

## Auf Railway deployen

1. In Railway **New Project → Deploy from GitHub repo** und dieses Repo wählen.
   `Dockerfile` und `railway.json` werden automatisch benutzt.
2. Im selben Projekt **+ New → Database → PostgreSQL** anlegen.
3. Im App-Dienst unter *Variables*:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Referenz auf die Datenbank)
   - `ANTHROPIC_API_KEY` = Schlüssel aus der Anthropic Console, für den Website-Import
4. Unter *Settings → Networking* eine Domain erzeugen. Fertig.

Das Schema legt der Server beim Start selbst an. Das Signaturgeheimnis für Sitzungen
wird beim ersten Start erzeugt und in der Datenbank gespeichert.

Optionale Variablen stehen in [`.env.example`](.env.example). `IMPORTS_PER_HOUR`
(Standard 30) begrenzt die Importe pro Person und Stunde und damit die API-Kosten.

**Push-Benachrichtigungen** brauchen keine Einrichtung: Die VAPID-Schlüssel erzeugt der
Server beim ersten Start und legt sie in der Datenbank ab. Erinnerungen prüft er alle
15 Minuten und verschickt sie ab `REMINDER_HOUR` (Standard 8) Uhr in `REMINDER_TIMEZONE`
(Standard `Europe/Berlin`). Der Dienst darf dafür nicht schlafen gelegt werden
(Railway „Serverless“ aus). Wer feste Schlüssel will, setzt `VAPID_PUBLIC_KEY` und
`VAPID_PRIVATE_KEY`.

### Kosten des Imports

Ein Import schickt den Text einer Seite an Claude (Modell `claude-opus-5-5`, niedriger
Denkaufwand). Je nach Länge der Seite kostet das grob 2 bis 8 Cent.
Die Zuordnung bei der GPX-Suche schickt nur Dateinamen und Kennzahlen und kostet
weniger als einen Cent. Import und GPX-Suche zählen gemeinsam gegen das Stundenlimit. Mit
`ANTHROPIC_MODEL` lässt sich ein anderes Modell einstellen.

## Lokal ausprobieren

```bash
npm install
npm run build
npm run start:local     # http://localhost:3000, Datenbank im Arbeitsspeicher
```

Mit `ANTHROPIC_API_KEY=... npm run start:local` geht auch der Import. Mit
`PGLITE_DIR=./data` bleiben die Daten erhalten. Alternativ `docker compose up --build`.

## Entwicklung

```bash
npm test            # Tests (Server gegen eingebettetes Postgres)
npm run typecheck
npm run dev:web     # Vite mit Hot Reload; API dazu: npm run start:local
```

## Aufbau

```
shared/   Datenmodell, Eingabeprüfung (zod), Auswertungen (Kosten, Hinweise)
server/   Fastify-API, Postgres, Website-Import
web/      React-PWA (Vite), Übersetzungen in web/src/i18n
```

Ein Prozess liefert API und App aus. Daten kommen immer frisch vom Server; der Service
Worker hält nur die App-Hülle für schlechten Empfang bereit.
