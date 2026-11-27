/**
 * Schlichter ZIP-Leser für die GPX-Suche: liest das Inhaltsverzeichnis am Ende des
 * Archivs und entpackt einzelne Einträge (gespeichert oder „deflate“). Ohne
 * Fremdbibliothek; Grenzen gegen riesige oder manipulierte Archive.
 */

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Position des lokalen Kopfs im Archiv. */
  offset: number;
}

export class ZipError extends Error {}

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 2000;

/** Liest das Inhaltsverzeichnis. Verzeichnisse werden ausgelassen. */
export function listZip(data: Buffer): ZipEntry[] {
  // Der Endeintrag steht in den letzten 22 Byte plus höchstens 64 KB Kommentar.
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i -= 1) {
    if (data.readUInt32LE(i) === END_SIGNATURE) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('Keine ZIP-Datei');
  const count = data.readUInt16LE(end + 10);
  let pos = data.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES) throw new ZipError('Zu viele Einträge im Archiv');
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > data.length || data.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw new ZipError('Beschädigtes Archiv');
    const flags = data.readUInt16LE(pos + 8);
    const method = data.readUInt16LE(pos + 10);
    const compressedSize = data.readUInt32LE(pos + 20);
    const size = data.readUInt32LE(pos + 24);
    const nameLength = data.readUInt16LE(pos + 28);
    const extraLength = data.readUInt16LE(pos + 30);
    const commentLength = data.readUInt16LE(pos + 32);
    const offset = data.readUInt32LE(pos + 42);
    const rawName = data.subarray(pos + 46, pos + 46 + nameLength);
    // Bit 11: Name in UTF-8, sonst meist CP437 (latin1 ist für Dateinamen nah genug).
    const name = rawName.toString(flags & 0x800 ? 'utf8' : 'latin1');
    if (!name.endsWith('/')) entries.push({ name, method, compressedSize, size, offset });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Entpackt einen Eintrag; bricht ab, wenn er größer als `maxBytes` würde. */
export function readZipEntry(data: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.size > maxBytes) throw new ZipError('Datei im Archiv ist zu groß');
  const pos = entry.offset;
  if (pos + 30 > data.length || data.readUInt32LE(pos) !== LOCAL_SIGNATURE) throw new ZipError('Beschädigtes Archiv');
  const start = pos + 30 + data.readUInt16LE(pos + 26) + data.readUInt16LE(pos + 28);
  const raw = data.subarray(start, start + entry.compressedSize);
  if (raw.length < entry.compressedSize) throw new ZipError('Beschädigtes Archiv');
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) throw new ZipError('Unbekannte Kompression');
  try {
    return inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch {
    throw new ZipError('Datei im Archiv ließ sich nicht entpacken');
  }
}
