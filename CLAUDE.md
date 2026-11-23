# RunPlanner

Familien-Kalender für Trailrun-Veranstaltungen. TypeScript-Monorepo (npm workspaces):
`shared` (Modell + zod), `server` (Fastify + Postgres), `web` (React + Vite PWA).
Deployment auf Railway per Dockerfile.

- Kommentare, Fehlermeldungen und README auf Deutsch; Oberfläche zweisprachig.
- Neue Texte immer in `web/src/i18n/de.ts` **und** `en.ts` anlegen (der Typ erzwingt es).
- Schema in `server/src/db.ts` ist idempotent; neue Spalten mit `alter table ... add column if not exists`.
- Tage sind Strings `JJJJ-MM-TT`, Uhrzeiten `HH:MM`, keine Zeitzonen.
- Bewusst keine Verbindung zu Google Kalender (Wunsch des Nutzers).
- Prüfen: `npm run typecheck && npm test && npm run build`.
- Version: bei jeder Änderung, die nach main geht, `version` in allen package.json erhöhen
  (`npm version X.Y.Z --no-git-tag-version --workspaces --include-workspace-root`) und
  oben in `web/src/changelog.ts` einen Eintrag auf Deutsch und Englisch ergänzen (ein Test
  prüft das). Die Version steht unten in den Einstellungen; ein Tipp darauf öffnet „Neuigkeiten“.
