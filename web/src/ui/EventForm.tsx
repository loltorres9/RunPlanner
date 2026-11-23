import { useState, type FormEvent } from 'react';
import type { EventInput, RaceInput } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { navigate, useApp } from '../state.js';
import { eventToInput } from './EventDetail.js';
import { Icon } from './Icon.js';

/** Formularzustand: Zahlen als Text, damit leere Felder leer bleiben dürfen. */
interface RaceDraft {
  key: string;
  id: string | null;
  name: string;
  distanceKm: string;
  elevationUpM: string;
  elevationDownM: string;
  startDate: string;
  startTime: string;
  fee: string;
  feeNote: string;
  cutoff: string;
}

interface Draft {
  name: string;
  location: string;
  startDate: string;
  endDate: string;
  website: string;
  registrationDeadline: string;
  currency: string;
  accommodationNeeded: boolean;
  accommodationBooked: boolean;
  accommodationNotes: string;
  notes: string;
  races: RaceDraft[];
}

let keySeq = 0;
const nextKey = () => `r${++keySeq}`;
const str = (value: number | string | null | undefined) => (value === null || value === undefined ? '' : String(value));

function toDraft(input: EventInput): Draft {
  return {
    name: input.name,
    location: str(input.location),
    startDate: input.startDate,
    endDate: str(input.endDate),
    website: str(input.website),
    registrationDeadline: str(input.registrationDeadline),
    currency: input.currency ?? 'EUR',
    accommodationNeeded: input.accommodationNeeded ?? false,
    accommodationBooked: input.accommodationBooked ?? false,
    accommodationNotes: str(input.accommodationNotes),
    notes: str(input.notes),
    races: (input.races ?? []).map(raceToDraft),
  };
}

function raceToDraft(race: RaceInput): RaceDraft {
  return {
    key: nextKey(),
    id: race.id ?? null,
    name: race.name,
    distanceKm: str(race.distanceKm),
    elevationUpM: str(race.elevationUpM),
    elevationDownM: str(race.elevationDownM),
    startDate: str(race.startDate),
    startTime: str(race.startTime),
    fee: str(race.fee),
    feeNote: str(race.feeNote),
    cutoff: str(race.cutoff),
  };
}

const emptyRace = (): RaceDraft => raceToDraft({ name: '' });

function num(value: string): number | null {
  const cleaned = value.replace(',', '.').trim();
  if (cleaned === '') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: string): number | null {
  const parsed = num(value);
  return parsed === null ? null : Math.round(parsed);
}

function fromDraft(draft: Draft): EventInput {
  return {
    name: draft.name,
    location: draft.location || null,
    startDate: draft.startDate,
    endDate: draft.endDate || null,
    website: draft.website || null,
    registrationDeadline: draft.registrationDeadline || null,
    currency: draft.currency.toUpperCase(),
    accommodationNeeded: draft.accommodationNeeded,
    accommodationBooked: draft.accommodationNeeded && draft.accommodationBooked,
    accommodationNotes: draft.accommodationNotes || null,
    notes: draft.notes || null,
    races: draft.races
      .filter((r) => r.name.trim() !== '')
      .map((r) => ({
        id: r.id,
        name: r.name,
        distanceKm: num(r.distanceKm),
        elevationUpM: int(r.elevationUpM),
        elevationDownM: int(r.elevationDownM),
        startDate: r.startDate || null,
        startTime: r.startTime || null,
        fee: num(r.fee),
        feeNote: r.feeNote || null,
        cutoff: r.cutoff || null,
      })),
  };
}

const blank: Draft = toDraft({ name: '', startDate: '', currency: 'EUR', races: [] });

export function EventForm(props: { eventId?: string }) {
  const { t, lang } = useI18n();
  const { events, groupId, putEvent, importEnabled } = useApp();
  const existing = props.eventId ? events.find((e) => e.id === props.eventId) : undefined;
  const [draft, setDraft] = useState<Draft>(() => (existing ? toDraft(eventToInput(existing)) : { ...blank, races: [emptyRace()] }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importState, setImportState] = useState<{ busy: boolean; message: string | null; warnings: string[] }>({
    busy: false,
    message: null,
    warnings: [],
  });

  if (props.eventId && !existing) return <p className="muted">{t.common.loading}</p>;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setRace = (key: string, patch: Partial<RaceDraft>) =>
    setDraft((d) => ({ ...d, races: d.races.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));

  async function runImport() {
    if (!importUrl.trim()) return;
    setImportState({ busy: true, message: t.import.running, warnings: [] });
    try {
      const result = await api.importFromUrl(importUrl.trim(), lang);
      const imported = toDraft(result.draft);
      // Beim Bearbeiten vorhandene Felder nicht mit leeren Werten überschreiben.
      setDraft((d) => ({
        ...d,
        ...Object.fromEntries(Object.entries(imported).filter(([k, v]) => k !== 'races' && v !== '' && v !== false)),
        races: imported.races.length > 0 ? imported.races : d.races,
      }));
      setImportState({ busy: false, message: t.import.done, warnings: result.warnings });
    } catch (e) {
      setImportState({ busy: false, message: e instanceof ApiError ? e.message : t.common.error, warnings: [] });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = fromDraft(draft);
      const saved = existing ? await api.updateEvent(existing.id, input) : await api.createEvent(groupId, input);
      putEvent(saved);
      navigate(`event/${saved.id}`, true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack form" onSubmit={submit}>
      <div className="row between">
        <h1>{existing ? t.event.editTitle : t.event.new}</h1>
        <button type="button" className="link" onClick={() => window.history.back()}>
          {t.common.cancel}
        </button>
      </div>
      <section className="card stack import">
        <h2>
          <Icon name="download" size={18} /> {t.import.title}
        </h2>
        <p className="muted small">{importEnabled ? t.import.hint : t.import.disabled}</p>
        {importEnabled && (
          <div className="row gap">
            <input
              type="url"
              inputMode="url"
              placeholder="https://"
              aria-label={t.import.url}
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runImport();
                }
              }}
            />
            <button type="button" onClick={runImport} disabled={importState.busy || !importUrl.trim()}>
              {t.import.run}
            </button>
          </div>
        )}
        {importState.message && <p className={importState.busy ? 'muted small' : 'notice small'}>{importState.message}</p>}
        {importState.warnings.length > 0 && (
          <ul className="warnings small">
            {importState.warnings.map((w, i) => (
              <li key={i}>
                <Icon name="alert" size={14} /> {w}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <label>
          {t.event.name}
          <input value={draft.name} onChange={(e) => set('name', e.target.value)} required maxLength={200} />
        </label>
        <label>
          {t.event.location}
          <input value={draft.location} onChange={(e) => set('location', e.target.value)} maxLength={200} />
        </label>
        <div className="grid2">
          <label>
            {t.event.startDate}
            <input type="date" value={draft.startDate} onChange={(e) => set('startDate', e.target.value)} required />
          </label>
          <label>
            {t.event.endDate}
            <input type="date" value={draft.endDate} min={draft.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} />
          </label>
        </div>
        <label>
          {t.event.website}
          <input type="url" value={draft.website} placeholder="https://" onChange={(e) => set('website', e.target.value)} />
        </label>
        <div className="grid2">
          <label>
            {t.event.registrationDeadline}
            <input type="date" value={draft.registrationDeadline} onChange={(e) => set('registrationDeadline', e.target.value)} />
          </label>
          <label>
            {t.event.currency}
            <select value={draft.currency} onChange={(e) => set('currency', e.target.value)}>
              {['EUR', 'CHF', 'GBP', 'USD', 'SEK', 'NOK', 'CZK', 'PLN'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="card stack">
        <h2>
          <Icon name="bed" size={18} /> {t.event.accommodation}
        </h2>
        <label className="toggle">
          <input type="checkbox" checked={draft.accommodationNeeded} onChange={(e) => set('accommodationNeeded', e.target.checked)} />
          {t.event.accommodationNeeded}
        </label>
        {draft.accommodationNeeded && (
          <>
            <label className="toggle">
              <input type="checkbox" checked={draft.accommodationBooked} onChange={(e) => set('accommodationBooked', e.target.checked)} />
              {t.event.accommodationBooked}
            </label>
            <label>
              {t.event.accommodationNotes}
              <textarea rows={2} value={draft.accommodationNotes} onChange={(e) => set('accommodationNotes', e.target.value)} />
            </label>
          </>
        )}
      </section>

      <h2>{t.event.races}</h2>
      {draft.races.map((race, index) => (
        <section key={race.key} className="card stack race-form">
          <div className="row between">
            <strong>#{index + 1}</strong>
            <button
              type="button"
              className="icon-button"
              aria-label={t.event.removeRace}
              onClick={() => setDraft((d) => ({ ...d, races: d.races.filter((r) => r.key !== race.key) }))}
            >
              <Icon name="trash" size={18} />
            </button>
          </div>
          <label>
            {t.event.raceName}
            <input value={race.name} onChange={(e) => setRace(race.key, { name: e.target.value })} maxLength={120} placeholder="Trail 25" />
          </label>
          <div className="grid3">
            <label>
              {t.event.distance}
              <input inputMode="decimal" value={race.distanceKm} onChange={(e) => setRace(race.key, { distanceKm: e.target.value })} />
            </label>
            <label>
              {t.event.elevationUp}
              <input inputMode="numeric" value={race.elevationUpM} onChange={(e) => setRace(race.key, { elevationUpM: e.target.value })} />
            </label>
            <label>
              {t.event.elevationDown}
              <input inputMode="numeric" value={race.elevationDownM} onChange={(e) => setRace(race.key, { elevationDownM: e.target.value })} />
            </label>
          </div>
          <div className="grid3">
            {draft.endDate && (
              <label>
                {t.event.raceDate}
                <input
                  type="date"
                  value={race.startDate}
                  min={draft.startDate}
                  max={draft.endDate}
                  onChange={(e) => setRace(race.key, { startDate: e.target.value })}
                />
              </label>
            )}
            <label>
              {t.event.startTime}
              <input type="time" value={race.startTime} onChange={(e) => setRace(race.key, { startTime: e.target.value })} />
            </label>
            <label>
              {t.event.fee}
              <input inputMode="decimal" value={race.fee} onChange={(e) => setRace(race.key, { fee: e.target.value })} />
            </label>
            <label>
              {t.event.cutoff}
              <input value={race.cutoff} onChange={(e) => setRace(race.key, { cutoff: e.target.value })} maxLength={120} />
            </label>
          </div>
          <label>
            {t.event.feeNote}
            <input
              value={race.feeNote}
              placeholder={t.event.feeNotePlaceholder}
              onChange={(e) => setRace(race.key, { feeNote: e.target.value })}
              maxLength={300}
            />
          </label>
        </section>
      ))}
      <button type="button" onClick={() => setDraft((d) => ({ ...d, races: [...d.races, emptyRace()] }))}>
        <Icon name="plus" size={16} /> {t.event.addRace}
      </button>

      <section className="card stack">
        <label>
          {t.event.notes}
          <textarea rows={3} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
      </section>

      {error && <p className="error">{error}</p>}
      <div className="sticky-actions">
        <button type="submit" className="primary" disabled={busy}>
          {t.common.save}
        </button>
      </div>
    </form>
  );
}
