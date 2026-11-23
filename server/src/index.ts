/**
 * Einstiegspunkt für den Betrieb.
 *
 * Ein einziger Prozess liefert die PWA aus und beantwortet die API. Das hält das
 * Deployment auf Railway bei einem Dienst plus Datenbank und erspart CORS.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { resolveTokenSecret } from './auth.js';
import { migrate } from './db.js';
import { createClaudeImporter } from './importer.js';
import { createPgDb } from './pgdb.js';
import { serveWeb } from './static.js';

const here = dirname(fileURLToPath(import.meta.url));

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

async function main(): Promise<void> {
  const databaseUrl = env('DATABASE_URL');
  if (databaseUrl === undefined) {
    console.error('DATABASE_URL fehlt. Auf Railway wird sie gesetzt, sobald der Dienst mit Postgres verknüpft ist.');
    process.exit(1);
  }

  const port = Number.parseInt(env('PORT') ?? '3000', 10);
  const webDir = env('WEB_DIR') ?? resolve(here, '../../web/dist');
  const db = createPgDb(databaseUrl);

  // Das Schema muss stehen, bevor das Signaturgeheimnis aus `app_config` gelesen wird.
  await migrate(db);
  const tokenSecret = await resolveTokenSecret(db, env('TOKEN_SECRET'));

  const apiKey = env('ANTHROPIC_API_KEY');
  const importer = apiKey === undefined ? null : createClaudeImporter({ apiKey, model: env('ANTHROPIC_MODEL') });
  if (importer === null) console.warn('ANTHROPIC_API_KEY fehlt: Der Website-Import ist abgeschaltet.');

  const app = await buildApp({
    db,
    tokenSecret,
    importer,
    logger: true,
    importsPerHour: Number.parseInt(env('IMPORTS_PER_HOUR') ?? '30', 10),
  });

  if (existsSync(webDir)) {
    await serveWeb(app, webDir);
    app.log.info(`Frontend wird ausgeliefert aus ${webDir}`);
  } else {
    app.log.warn(`Kein Frontend unter ${webDir} gefunden, nur die API ist erreichbar.`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} empfangen, fahre herunter`);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`RunPlanner läuft auf Port ${port}`);
}

main().catch((error: unknown) => {
  console.error('Start fehlgeschlagen:', error);
  process.exit(1);
});
