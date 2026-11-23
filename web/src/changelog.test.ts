import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANGELOG } from './changelog.js';

describe('Änderungsprotokoll', () => {
  it('beginnt mit der aktuellen Version und hat beide Sprachen', () => {
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(CHANGELOG[0]?.version).toBe(version);
    for (const entry of CHANGELOG) {
      expect(entry.de.length).toBeGreaterThan(0);
      expect(entry.en.length).toBe(entry.de.length);
    }
    expect(new Set(CHANGELOG.map((e) => e.version)).size).toBe(CHANGELOG.length);
  });
});
