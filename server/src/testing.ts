/**
 * `Db` auf Basis von PGlite: echtes Postgres im Prozess. Für Tests und den lokalen
 * Betrieb ohne eigene Datenbank. PGlite ist nur eine Entwicklungsabhängigkeit, daher
 * bekommt diese Datei die Instanz von außen.
 */

import type { Db } from './db.js';

interface PgliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgliteDb(pg: PgliteLike): Db {
  const wrap = (runner: Omit<PgliteLike, 'transaction' | 'close'>): Db => ({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await runner.query(sql, params ?? []);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await runner.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return pg.transaction((tx) => fn(wrap(tx)));
    },
    async close() {
      await pg.close();
    },
  });
  return wrap(pg);
}
