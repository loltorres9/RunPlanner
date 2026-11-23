/** `Db`-Implementierung auf Basis von `pg` — das, was auf Railway laeuft. */

import pg from 'pg';
import type { Db, QueryResult } from './db.js';

/**
 * Postgres liefert `bigint` (int8) standardmaessig als String aus, weil nicht jede Zahl
 * in ein JavaScript-Double passt. Unsere bigint-Spalten sind Zeitstempel in Millisekunden
 * und laufende Nummern — beides liegt weit unter 2^53, also ist die Wandlung sicher und
 * erspart uns Stringvergleiche an jeder Fundstelle.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number.parseInt(value, 10));

class PgDb implements Db {
  constructor(private readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params as never[]);
    return { rows: result.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const tx: Db = {
        query: async <R>(sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params as never[]);
          return { rows: result.rows as R[] };
        },
        exec: async (statements: string) => {
          await client.query(statements);
        },
        transaction: () => {
          throw new Error('Verschachtelte Transaktionen werden nicht unterstützt');
        },
        close: async () => {},
      };
      const value = await fn(tx);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPgDb(connectionString: string): Db {
  const needsSsl = /[?&]sslmode=require/.test(connectionString);
  return new PgDb(
    new pg.Pool({
      connectionString,
      max: 5,
      // Railway terminiert TLS mit eigenem Zertifikat; die Verbindung laeuft ohnehin
      // ueber das private Netz zwischen den Diensten.
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    }),
  );
}
