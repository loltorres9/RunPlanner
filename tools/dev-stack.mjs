/**
 * Lokaler Gesamtaufbau ohne Docker und ohne eigenes Postgres.
 *
 * Startet den echten Server gegen ein eingebettetes Postgres (PGlite) und liefert die
 * gebaute PWA aus. Ohne PGLITE_DIR liegt alles im Arbeitsspeicher und ist nach dem
 * Beenden weg.
 *
 *   npm run build && npm run start:local     → http://localhost:3000
 *
 * Mit ANTHROPIC_API_KEY in der Umgebung funktioniert auch der Website-Import.
 */

import { PGlite } from '@electric-sql/pglite';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../server/dist/app.js';
import { createClaudeImporter } from '../server/dist/importer.js';
import { serveWeb } from '../server/dist/static.js';
import { createPgliteDb } from '../server/dist/testing.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web', 'dist');
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

const pg = await PGlite.create(process.env.PGLITE_DIR);
const app = await buildApp({
  db: createPgliteDb(pg),
  tokenSecret: 'lokaler-entwicklungsschluessel-nicht-fuer-den-betrieb',
  importer: apiKey ? createClaudeImporter({ apiKey, model: process.env.ANTHROPIC_MODEL }) : null,
  logger: false,
});

if (existsSync(webDir)) await serveWeb(app, webDir);
else console.warn('web/dist fehlt: erst "npm run build" ausführen.');

await app.listen({ port, host: '127.0.0.1' });
console.log(`RunPlanner lokal: http://localhost:${port}`);
