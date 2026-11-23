/**
 * GPX-Suche auf der Event-Seite: Der Server durchsucht die Website der Veranstaltung,
 * schlägt je Strecke eine Datei vor, und hier wird bestätigt, was übernommen wird.
 */

import { useEffect, useState } from 'react';
import type { GpxSearchResult, RunEvent } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { useApp } from '../state.js';
import { Icon } from './Icon.js';

const AUTO_KEY = 'gpxAutoSearch';

/** Merkt vor, dass die Suche beim nächsten Öffnen der Event-Seite von selbst startet. */
export function requestAutoGpxSearch(eventId: string): void {
  try {
    sessionStorage.setItem(AUTO_KEY, eventId);
  } catch {
    // Ohne Speicher eben nicht automatisch.
  }
}

function takeAutoRequest(eventId: string): boolean {
  try {
    if (sessionStorage.getItem(AUTO_KEY) !== eventId) return false;
    sessionStorage.removeItem(AUTO_KEY);
    return true;
  } catch {
    return false;
  }
}

export function GpxSearch(props: { event: RunEvent }) {
  const { t, f, number } = useI18n();
  const { putEvent } = useApp();
  const { event } = props;
  const [state, setState] = useState<'idle' | 'searching' | 'result' | 'applying'>('idle');
  const [result, setResult] = useState<GpxSearchResult | null>(null);
  // Je Strecke: gewählte Datei (URL) und ob sie übernommen werden soll.
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function search() {
    setState('searching');
    setError(null);
    setNotice(null);
    try {
      const found = await api.gpxSearch(event.id);
      const nextChoice: Record<string, string> = {};
      const nextChecked: Record<string, boolean> = {};
      for (const race of event.races) {
        const match = found.candidates.find((c) => c.raceId === race.id);
        nextChoice[race.id] = match?.url ?? '';
        // Vorhandene Verläufe nur ersetzen, wenn man es ausdrücklich anhakt.
        nextChecked[race.id] = match !== undefined && race.track === null;
      }
      setChoice(nextChoice);
      setChecked(nextChecked);
      setResult(found);
      setState('result');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
      setState('idle');
    }
  }

  useEffect(() => {
    if (takeAutoRequest(event.id)) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  async function apply() {
    const items = event.races.filter((r) => checked[r.id] && choice[r.id]).map((r) => ({ raceId: r.id, url: choice[r.id]! }));
    if (items.length === 0) return;
    setState('applying');
    setError(null);
    try {
      putEvent(await api.gpxApply(event.id, { items }));
      setResult(null);
      setNotice(t.gpxSearch.applied);
      setState('idle');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
      setState('result');
    }
  }

  if (!event.website || event.races.length === 0) return null;

  const selectedCount = event.races.filter((r) => checked[r.id] && choice[r.id]).length;

  return (
    <div className="gpx-search stack">
      {state !== 'result' && state !== 'applying' && (
        <button type="button" onClick={search} disabled={state === 'searching'}>
          <Icon name="map" size={16} /> {t.gpxSearch.button}
        </button>
      )}
      {state === 'searching' && <p className="muted small">{t.gpxSearch.running}</p>}
      {notice && <p className="notice small">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {result && (state === 'result' || state === 'applying') && (
        <section className="card stack">
          <div className="row between">
            <h3>{t.gpxSearch.title}</h3>
            <button type="button" className="icon-button" aria-label={t.gpxSearch.close} onClick={() => setResult(null)}>
              <Icon name="close" size={18} />
            </button>
          </div>
          <p className="muted small">
            {result.candidates.length === 0
              ? f(t.gpxSearch.none, { pages: result.pagesChecked })
              : `${f(t.gpxSearch.found, { files: result.candidates.length, pages: result.pagesChecked })} ${
                  result.matchedBy === 'ai' ? t.gpxSearch.byAi : t.gpxSearch.byDistance
                }`}
          </p>
          {result.candidates.length > 0 && (
            <ul className="gpx-matches">
              {event.races.map((race) => (
                <li key={race.id}>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={!!checked[race.id] && !!choice[race.id]}
                      disabled={!choice[race.id]}
                      onChange={(e) => setChecked({ ...checked, [race.id]: e.target.checked })}
                    />
                    <span>
                      <strong>{race.name}</strong>
                      {race.distanceKm !== null && <span className="muted"> · {number(race.distanceKm)} km</span>}
                    </span>
                  </label>
                  <select
                    aria-label={race.name}
                    value={choice[race.id] ?? ''}
                    onChange={(e) => {
                      setChoice({ ...choice, [race.id]: e.target.value });
                      setChecked({ ...checked, [race.id]: e.target.value !== '' });
                    }}
                  >
                    <option value="">{t.gpxSearch.noFile}</option>
                    {result.candidates.map((c) => (
                      <option key={c.url} value={c.url}>
                        {c.fileName} ({number(c.distanceKm)} km{c.gainM !== null ? `, ↑${c.gainM} hm` : ''})
                      </option>
                    ))}
                  </select>
                  {race.track !== null && checked[race.id] && choice[race.id] && (
                    <span className="warn-text small">{t.gpxSearch.replaces}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {result.external.length > 0 && (
            <div className="stack gap-s">
              <p className="muted small">{t.gpxSearch.external}</p>
              <ul className="external-routes">
                {result.external.map((r) => (
                  <li key={r.url}>
                    <a href={r.url} target="_blank" rel="noreferrer">
                      <Icon name="link" size={14} /> {r.service}
                      {r.label && r.label !== r.service ? `: ${r.label}` : ''}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.candidates.length > 0 && (
            <button type="button" className="primary" disabled={selectedCount === 0 || state === 'applying'} onClick={apply}>
              {state === 'applying' ? t.gpxSearch.applying : `${t.gpxSearch.apply} (${selectedCount})`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
