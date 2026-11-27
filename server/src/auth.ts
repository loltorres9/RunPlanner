/**
 * Konten und Sitzungen.
 *
 * Passwörter liegen nur als scrypt-Hash in der Datenbank. Sitzungen sind signierte
 * Tokens im JWT-Format (HS256), von Hand statt per Bibliothek: Es ist der einzige
 * Tokentyp, den wir ausstellen, und `alg: none` ist so von vornherein ausgeschlossen.
 */

import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.js';

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

const SCRYPT_KEYLEN = 32;
/** Gültigkeit einer Sitzung. Lang, weil man sich am Handy ungern neu anmeldet. */
export const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64');
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt}$${derived.toString('base64')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || expected === undefined) return false;
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  const expectedBytes = Buffer.from(expected, 'base64');
  if (expectedBytes.length !== derived.length) return false;
  return timingSafeEqual(derived, expectedBytes);
}

export interface TokenPayload {
  sub: string;
  /** Zähler des Kontos. Wird er erhöht, verfallen alle bisherigen Sitzungen. */
  epoch: number;
  exp: number;
}

export function signToken(payload: TokenPayload, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.${sign(`${header}.${body}`, secret)}`;
}

export function verifyToken(token: string, secret: string, now: number): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const a = Buffer.from(signature);
  const b = Buffer.from(sign(`${header}.${body}`, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string };
    if (decodedHeader.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.sub !== 'string' || typeof payload.epoch !== 'number') return null;
    return payload;
  } catch {
    return null;
  }
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * Das Signaturgeheimnis. Steht keines in der Umgebung, wird eines erzeugt und in der
 * Datenbank abgelegt, damit Sitzungen einen Neustart überleben.
 */
export async function resolveTokenSecret(db: Db, fromEnv: string | undefined): Promise<string> {
  if (fromEnv !== undefined && fromEnv.length >= 16) return fromEnv;
  const generated = randomBytes(32).toString('base64');
  await db.query('insert into app_config (key, value) values ($1, $2) on conflict (key) do nothing', [
    'token_secret',
    generated,
  ]);
  const confirmed = await db.query<{ value: string }>('select value from app_config where key = $1', [
    'token_secret',
  ]);
  return confirmed.rows[0]?.value ?? generated;
}

export function newId(): string {
  return randomUUID();
}

/** Einladungscode: kurz genug zum Teilen, lang genug gegen Raten. */
export function newInviteCode(): string {
  return randomBytes(9).toString('base64url');
}

/** Code für einen Reset-Link: 144 Bit Zufall, nicht zu erraten. */
export function newResetCode(): string {
  return randomBytes(18).toString('base64url');
}

/** In der Datenbank liegt nur der Hash, damit ein Datenbank-Leck keine gültigen Links verrät. */
export function hashResetCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Einfache Bremse pro Schlüssel (IP, Konto) in einem festen Zeitfenster. In-Memory
 * reicht: Es gibt genau einen Serverprozess.
 */
export class Throttle {
  private readonly hits = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Verbleibende Sperrzeit in Millisekunden, oder 0 wenn frei. */
  retryAfter(key: string, now: number): number {
    const entry = this.hits.get(key);
    if (entry === undefined) return 0;
    if (entry.until <= now) {
      this.hits.delete(key);
      return 0;
    }
    return entry.count >= this.max ? entry.until - now : 0;
  }

  record(key: string, now: number): void {
    const entry = this.hits.get(key);
    if (entry === undefined || entry.until <= now) {
      this.hits.set(key, { count: 1, until: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}

/** Zufälliger Schlüssel für den Kalender-Abo-Link (192 Bit). */
export function newCalendarToken(): string {
  return randomBytes(24).toString('base64url');
}
