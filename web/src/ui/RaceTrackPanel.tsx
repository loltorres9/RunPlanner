/** GPX einer Strecke: hochladen, Karte und Höhenprofil zeigen, entfernen. */

import { lazy, Suspense, useRef, useState } from 'react';
import type { Race, RunEvent } from '@runplanner/shared';
import { api } from '../api.js';
import { GpxError, parseGpx } from '../gpx.js';
import { useI18n } from '../i18n/index.js';
import { Icon } from './Icon.js';

const RouteMap = lazy(() => import('./RouteMap.js').then((m) => ({ default: m.RouteMap })));

const MAX_FILE_BYTES = 15 * 1024 * 1024;

export function RaceTrackPanel(props: { race: Race; onChange: (action: () => Promise<RunEvent>) => Promise<void> }) {
  const { t, f, number } = useI18n();
  const { race } = props;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError(t.track.tooLarge);
      return;
    }
    setBusy(true);
    try {
      const track = parseGpx(await file.text());
      await props.onChange(() => api.setTrack(race.id, track));
      setOpen(true);
    } catch (e) {
      setError(e instanceof GpxError ? t.track.invalid : t.common.error);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const track = race.track;
  return (
    <div className="track stack gap-s">
      {track && (
        <p className="small track-summary">
          <Icon name="map" size={14} /> {f(t.track.summary, { km: number(track.distanceKm) })}
          {track.gainM !== null && ` · ↑ ${number(track.gainM, 0)} hm`}
          {track.lossM !== null && ` · ↓ ${number(track.lossM, 0)} hm`}
        </p>
      )}
      <div className="row gap-s wrap">
        {track && (
          <button type="button" className="small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t.track.hide : t.track.show}
          </button>
        )}
        <button type="button" className="small" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? t.common.loading : track ? t.track.replace : t.track.upload}
        </button>
        {track && (
          <button
            type="button"
            className="small link danger-text"
            onClick={() => {
              if (window.confirm(t.track.removeConfirm)) void props.onChange(() => api.deleteTrack(race.id));
            }}
          >
            {t.track.remove}
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept=".gpx,application/gpx+xml,application/xml,text/xml"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      {error && <p className="error small">{error}</p>}
      {track && open && (
        <Suspense fallback={<p className="muted small">{t.common.loading}</p>}>
          <RouteMap raceId={race.id} key={`${track.distanceKm}-${track.gainM}`} />
        </Suspense>
      )}
    </div>
  );
}
