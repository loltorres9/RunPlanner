import { describe, expect, it } from 'vitest';
import { fetchPage, htmlToText, ImportError, isPrivateAddress, toDraft } from './importer.js';

describe('isPrivateAddress', () => {
  it('erkennt interne Adressen', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2a00:1450:4001::1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('fetchPage', () => {
  it('lädt keine internen Adressen', async () => {
    await expect(fetchPage('http://127.0.0.1:5432/')).rejects.toBeInstanceOf(ImportError);
    await expect(fetchPage('http://localhost/')).rejects.toMatchObject({ code: 'blocked_url' });
    await expect(fetchPage('file:///etc/passwd')).rejects.toMatchObject({ code: 'invalid_url' });
  });
});

describe('htmlToText', () => {
  it('behält Inhalt, Meta-Angaben und JSON-LD, verwirft Skripte', () => {
    const html = `<html><head><title>Trail &amp; Fun</title>
      <meta property="og:description" content="Am 1. Mai in Ruhpolding">
      <script type="application/ld+json">{"@type":"Event","startDate":"2027-05-01"}</script>
      <script>var tracking = 1;</script><style>.x{}</style></head>
      <body><h1>Strecken</h1><table><tr><td>Ultra</td><td>70&nbsp;km</td><td>95&euro;</td></tr></table></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('TITLE: Trail & Fun');
    expect(text).toContain('Am 1. Mai in Ruhpolding');
    expect(text).toContain('"startDate":"2027-05-01"');
    expect(text).toContain('Ultra | 70 km | 95€');
    expect(text).not.toContain('tracking');
  });
});

describe('toDraft', () => {
  it('verwirft ungültige Werte', () => {
    const { draft, warnings } = toDraft(
      {
        name: ' Chiemgau Trail ',
        location: 'Ruhpolding',
        startDate: '2027-05-01',
        endDate: '2027-04-30',
        registrationDeadline: '1. April',
        currency: 'eur',
        multiDay: false,
        races: [
          { name: 'Ultra', distanceKm: 70, elevationUpM: 3800.4, elevationDownM: -5, startDate: null, startTime: '6:00', fee: 95, feeNote: null, cutoff: '14 h' },
        ],
        warnings: ['Gebühren vom Vorjahr'],
      },
      'https://example.org',
    );
    expect(draft.name).toBe('Chiemgau Trail');
    expect(draft.endDate).toBeNull();
    expect(draft.registrationDeadline).toBeNull();
    expect(draft.currency).toBe('EUR');
    expect(draft.races?.[0]).toMatchObject({ elevationUpM: 3800, elevationDownM: null, startTime: null, fee: 95 });
    expect(warnings).toEqual(['Gebühren vom Vorjahr']);
  });
});
