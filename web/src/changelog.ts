/**
 * Änderungsprotokoll, das die App unter „Neuigkeiten“ zeigt. Neueste Version oben.
 * Bei jeder Version hier einen Eintrag in beiden Sprachen ergänzen; ein Test prüft,
 * dass der oberste Eintrag zur Version im package.json passt.
 */

export interface ChangelogEntry {
  version: string;
  /** JJJJ-MM-TT */
  date: string;
  de: string[];
  en: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.13.0',
    date: '2026-11-23',
    de: [
      'Kosten teilen: Bei jeder Veranstaltung lassen sich Ausgaben erfassen – wer hat bezahlt, wie viel, wofür und für wen. Standardmäßig wird gleich aufgeteilt, einzelne Beträge lassen sich anpassen.',
      'Im Tab „Kosten“ steht jetzt „Wer schuldet wem“, über alle Veranstaltungen verrechnet mit möglichst wenigen Überweisungen. „Erledigt“ hakt eine Zahlung ab.',
    ],
    en: [
      'Split costs: add expenses to any event – who paid, how much, what for and for whom. It is split equally by default, and individual amounts can be adjusted.',
      'The “Costs” tab now shows “Who owes whom”, settled across all events with as few transfers as possible. “Done” ticks off a payment.',
    ],
  },
  {
    version: '0.12.0',
    date: '2026-11-23',
    de: [
      'Streckenkarte: Pro Strecke eine GPX-Datei hochladen, dann gibt es eine Karte mit dem Verlauf und ein Höhenprofil.',
      'Fehlen bei der Strecke Distanz oder Höhenmeter, werden sie aus der GPX-Datei übernommen.',
    ],
    en: [
      'Route map: upload a GPX file per race to get a map of the route and an elevation profile.',
      'If distance or elevation are missing for the race, they are taken from the GPX file.',
    ],
  },
  {
    version: '0.11.0',
    date: '2026-11-23',
    de: [
      'Kommentare pro Veranstaltung, z. B. für Fahrgemeinschaften. Eigene Kommentare lassen sich löschen.',
      'Wer eingetragen ist oder mitschreibt, bekommt eine Benachrichtigung (abschaltbar). In der Terminliste zeigt eine grüne Sprechblase neue Kommentare.',
    ],
    en: [
      'Comments on each event, e.g. for car sharing. You can delete your own comments.',
      'Everyone signed up or taking part in the conversation gets a notification (can be turned off). A green speech bubble in the event list shows new comments.',
    ],
  },
  {
    version: '0.10.0',
    date: '2026-11-23',
    de: [
      'Die Terminliste ist jetzt die Startseite und steht in der Leiste unten ganz links, der Kalender daneben.',
      'Sicherheitsupdate für die Auslieferung der App-Dateien.',
    ],
    en: [
      'The event list is now the start page and sits first in the bottom bar, with the calendar next to it.',
      'Security update for serving the app files.',
    ],
  },
  {
    version: '0.9.0',
    date: '2026-11-23',
    de: [
      "Push-Benachrichtigungen: bei neuen Veranstaltungen, vor dem Anmeldeschluss (wenn du nur Interesse hast) und vor einer Veranstaltung, bei der du eingetragen bist. Vorlauf in den Einstellungen wählbar.",
      "Auf dem iPhone funktionieren Benachrichtigungen nur, wenn RunPlanner auf dem Home-Bildschirm installiert ist.",
      "Nach einem Update erscheint oben ein Hinweis mit Link zu den Neuigkeiten.",
    ],
    en: [
      "Push notifications: for new events, before the registration deadline (if you are only interested) and before an event you are signed up for. Lead time can be set in Settings.",
      "On iPhone, notifications only work when RunPlanner is installed on the home screen.",
      "After an update, a banner at the top links to What's new.",
    ],
  },
  {
    version: '0.8.0',
    date: '2026-11-23',
    de: [
      "Neuigkeiten: Ein Tipp auf die Versionsnummer in den Einstellungen zeigt, was sich in jeder Version geändert hat.",
    ],
    en: [
      "What's new: tap the version number in Settings to see what changed in each version.",
    ],
  },
  {
    version: '0.7.0',
    date: '2026-11-23',
    de: [
      "Einstellungen: Darstellung „Wie Gerät | Hell | Dunkel“, pro Gerät gespeichert.",
    ],
    en: [
      "Settings: appearance “Like device | Light | Dark”, saved per device.",
    ],
  },
  {
    version: '0.6.0',
    date: '2026-11-23',
    de: [
      "Terminliste: Umschalter „Nach Datum | Neu hinzugefügt“. „Neu hinzugefügt“ zeigt die neuesten Einträge zuerst, mit wem und wann.",
      "Abzeichen „Neu“ für Veranstaltungen, die andere seit dem letzten Öffnen der App angelegt haben.",
    ],
    en: [
      "Event list: switch “By date | Recently added”. “Recently added” shows the newest entries first, with who added them and when.",
      "“New” badge for events others added since you last opened the app.",
    ],
  },
  {
    version: '0.5.0',
    date: '2026-11-23',
    de: [
      "Unterkunft pro Nacht: Bei mehrtägigen Veranstaltungen kann jede Person „Jede Nacht anders“ wählen, z. B. bei Etappenläufen.",
      "Vorschläge lassen sich einzelnen Nächten zuordnen, eine Übersicht zeigt pro Nacht, wer wo schläft.",
    ],
    en: [
      "Accommodation per night: for multi-day events everyone can choose “Different place each night”, e.g. for stage races.",
      "Suggestions can be tied to specific nights, and an overview shows who sleeps where each night.",
    ],
  },
  {
    version: '0.4.0',
    date: '2026-11-23',
    de: [
      "Passwort vergessen: Ein Admin der Laufgruppe erzeugt beim Mitglied einen Einmal-Link (zwei Tage gültig) und schickt ihn selbst weiter.",
    ],
    en: [
      "Forgot password: a group admin creates a one-time link for the member (valid for two days) and sends it on.",
    ],
  },
  {
    version: '0.3.0',
    date: '2026-11-23',
    de: [
      "Versionsnummer unten in den Einstellungen.",
      "Unterkünfte: Vorschläge pro Veranstaltung; jede Person wählt keine, einen Vorschlag oder eine andere, mit „gebucht“.",
    ],
    en: [
      "Version number at the bottom of Settings.",
      "Accommodation: suggestions per event; everyone picks none, a suggestion or another place, and marks it as booked.",
    ],
  },
  {
    version: '0.2.0',
    date: '2026-11-23',
    de: [
      "Zeitraum der Veranstaltung im Kalenderdialog wählen, ohne OK-Knopf.",
      "Starttage der Strecken müssen im Zeitraum liegen.",
    ],
    en: [
      "Pick the event period in a calendar dialog, no OK button needed.",
      "Race start days must lie within the event period.",
    ],
  },
  {
    version: '0.1.0',
    date: '2026-11-23',
    de: [
      "Erste Version: Laufgruppen, Veranstaltungen mit Strecken, Kalender, Kosten, Import von der Website.",
    ],
    en: [
      "First version: running groups, events with races, calendar, costs, import from the event website.",
    ],
  },
];
