import { describe, expect, it } from 'vitest';
import { komootToTrack, komootTour, outdooractiveTour } from './routeServices.js';

describe('Routen-Dienste', () => {
  it('erkennt Komoot- und Outdooractive-Touren', () => {
    expect(komootTour(new URL('https://www.komoot.com/de-de/tour/910705099?share_token=abc-1&ref=wtd'))).toEqual({
      api: 'https://www.komoot.com/api/v007/tours/910705099?_embedded=coordinates&share_token=abc-1',
    });
    expect(komootTour(new URL('https://www.komoot.de/smarttour/16360513'))?.api).toBe(
      'https://www.komoot.com/api/v007/smart_tours/16360513?_embedded=coordinates',
    );
    expect(komootTour(new URL('https://www.komoot.com/highlight/3782713'))).toBeNull();
    expect(outdooractiveTour(new URL('https://www.outdooractive.com/de/route/trailrunning/schwaebische-alb/esslinger-trail/123456789/'))).toEqual({
      gpx: 'https://www.outdooractive.com/download.tour.gpx?i=123456789',
    });
    expect(outdooractiveTour(new URL('https://www.outdooractive.com/de/'))).toBeNull();
  });

  it('liest den Verlauf aus der Komoot-Antwort', () => {
    const track = komootToTrack({
      name: 'Esslinger Höhenrunde',
      _embedded: {
        coordinates: {
          items: [
            { lat: 48.74, lng: 9.3, alt: 240 },
            { lat: 48.79, lng: 9.3, alt: 480 },
            { lat: 999, lng: 9.3, alt: 1 },
          ],
        },
      },
    });
    expect(track.name).toBe('Esslinger Höhenrunde');
    expect(track.points).toHaveLength(2);
    expect(Math.round(track.distanceKm * 10) / 10).toBe(5.6);
    expect(() => komootToTrack({ name: 'privat' })).toThrow();
  });
});
