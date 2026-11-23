/** Auslieferung der gebauten PWA neben der API. */

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export async function serveWeb(app: FastifyInstance, webDir: string): Promise<void> {
  await app.register(fastifyStatic, { root: webDir, index: false });

  // Die Wurzel braucht eine eigene Route: @fastify/static antwortet auf das Verzeichnis
  // sonst mit 403, statt an die Ausweichroute unten durchzureichen.
  app.get('/', async (_request, reply) => reply.header('cache-control', 'no-cache').sendFile('index.html'));

  // Alles, was keine API-Route ist, beantwortet die Einzelseiten-App selbst.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: 'Unbekannte Route' });
    }
    // Der Service Worker darf nie aus einem alten Cache kommen.
    if (request.url.startsWith('/sw.js')) {
      return reply.header('cache-control', 'no-cache').sendFile('sw.js');
    }
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });
}
