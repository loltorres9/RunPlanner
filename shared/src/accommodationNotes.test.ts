import { describe, expect, it } from 'vitest';
import { notesToAccommodations } from './accommodationNotes.js';

describe('notesToAccommodations', () => {
  it('macht aus Zeilen Vorschläge mit Name, Link und Preis', () => {
    const notes = [
      '- Hotel Adler, ca. 90 € pro Nacht – https://hotel-adler.de/zimmer.',
      '',
      '• Jugendherberge Esslingen',
      'https://www.jugendherberge.de/esslingen',
      'ab 35 € p.P.',
      'https://www.camping-neckar.de',
    ].join('\n');
    expect(notesToAccommodations(notes)).toEqual([
      { name: 'Hotel Adler', url: 'https://hotel-adler.de/zimmer', price: 'ca. 90 € pro Nacht', notes: null, nights: [] },
      { name: 'Jugendherberge Esslingen', url: 'https://www.jugendherberge.de/esslingen', price: 'ab 35 € p.P.', notes: null, nights: [] },
      { name: 'camping-neckar.de', url: 'https://www.camping-neckar.de', price: null, notes: null, nights: [] },
    ]);
  });

  it('liefert für leere Notizen nichts', () => {
    expect(notesToAccommodations('  \n\n')).toEqual([]);
  });
});
