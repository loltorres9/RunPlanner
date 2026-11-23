/**
 * Karte (Leaflet mit OpenStreetMap-Kacheln) und Höhenprofil eines Streckenverlaufs.
 * Leaflet wird erst geladen, wenn jemand eine Karte öffnet.
 */

import { useEffect, useRef, useState } from 'react';
import { elevationProfile, type RaceTrack } from '@runplanner/shared';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.js';

export function RouteMap(props: { raceId: string }) {
  const { t } = useI18n();
  const [track, setTrack] = useState<RaceTrack | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.track(props.raceId).then(setTrack, () => setFailed(true));
  }, [props.raceId]);

  if (failed) return <p className="error">{t.common.error}</p>;
  if (track === null) return <p className="muted small">{t.common.loading}</p>;
  return (
    <div className="route stack">
      <MapView track={track} />
      <ElevationProfile track={track} />
    </div>
  );
}

function MapView(props: { track: RaceTrack }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([{ default: L }]) => {
      if (disposed || ref.current === null) return;
      const map = L.map(ref.current, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      const latlngs = props.track.points.map(([lat, lon]) => [lat, lon] as [number, number]);
      const line = L.polyline(latlngs, { color: '#2f7d5b', weight: 4 }).addTo(map);
      L.circleMarker(latlngs[0]!, { radius: 7, color: '#ffffff', weight: 2, fillColor: '#2f7d5b', fillOpacity: 1 }).addTo(map);
      L.circleMarker(latlngs[latlngs.length - 1]!, { radius: 7, color: '#ffffff', weight: 2, fillColor: '#c4622d', fillOpacity: 1 }).addTo(
        map,
      );
      map.fitBounds(line.getBounds(), { padding: [16, 16] });
      cleanup = () => map.remove();
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [props.track]);
  return <div ref={ref} className="route-map" />;
}

function ElevationProfile(props: { track: RaceTrack }) {
  const { t, number } = useI18n();
  const profile = elevationProfile(props.track.points);
  if (profile.length < 2) return <p className="muted small">{t.track.noElevation}</p>;
  const width = 600;
  const height = 160;
  const pad = { left: 40, right: 8, top: 10, bottom: 22 };
  const maxKm = profile[profile.length - 1]!.km || 1;
  const eles = profile.map((p) => p.ele);
  const minEle = Math.min(...eles);
  const maxEle = Math.max(...eles);
  const span = Math.max(maxEle - minEle, 50);
  const x = (km: number) => pad.left + (km / maxKm) * (width - pad.left - pad.right);
  const y = (ele: number) => pad.top + (1 - (ele - minEle) / span) * (height - pad.top - pad.bottom);
  const line = profile.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.km).toFixed(1)},${y(p.ele).toFixed(1)}`).join('');
  const area = `${line}L${x(maxKm).toFixed(1)},${height - pad.bottom}L${x(0).toFixed(1)},${height - pad.bottom}Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxKm);
  return (
    <figure className="profile">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t.track.profile}>
        <path d={area} className="profile-area" />
        <path d={line} className="profile-line" />
        <text x={pad.left - 6} y={y(maxEle) + 4} textAnchor="end" className="profile-label">
          {number(maxEle, 0)}
        </text>
        <text x={pad.left - 6} y={y(minEle) + 4} textAnchor="end" className="profile-label">
          {number(minEle, 0)}
        </text>
        {ticks.map((km) => (
          <text key={km} x={x(km)} y={height - 6} textAnchor="middle" className="profile-label">
            {number(km, 0)}
          </text>
        ))}
      </svg>
      <figcaption className="muted small">{t.track.profileCaption}</figcaption>
    </figure>
  );
}
