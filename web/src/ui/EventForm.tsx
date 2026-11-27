import { useState, type FormEvent } from 'react';
import { notesToAccommodations, type AccommodationInput, type EventInput, type RaceInput, type RunEvent } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { navigate, useApp } from '../state.js';
import { daysBetween } from '../dates.js';
import { DateField } from './DatePicker.js';
import { eventToInput } from './EventDetail.js';
import { Icon } from './Icon.js';
import { requestAutoGpxSearch } from './GpxSearch.js';

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
  /** Teamstrecke mit Teamgröße. */
  team: boolean;
  teamSize: string;
  /** ITRA-Punkte als Text, leer = unbekannt. */
  itraPoints: string;
  /** Starttag fiel durch eine Änderung des Zeitraums heraus und wurde geleert. */
  dayCleared: boolean;
}

/** Unterkunfts-Vorschlag im Formular; `id` bei vorhandenen. */
interface AccommodationDraft {
  key: string;
  id: string | null;
  name: string;
  url: string;
  price: string;
  notes: string;
  nights: string[];
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
  accommodationNotes: string;
  notes: string;
  races: RaceDraft[];
  accommodations: AccommodationDraft[];
  /** Vorhandene Vorschläge, die im Formular entfernt wurden. */
  removedAccommodations: string[];
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
    accommodationNotes: str(input.accommodationNotes),
    notes: str(input.notes),
    races: (input.races ?? []).map(raceToDraft),
    accommodations: (input.accommodations ?? []).map(accommodationToDraft),
    removedAccommodations: [],
  };
}

function accommodationToDraft(a: AccommodationInput & { id?: string | null }): AccommodationDraft {
  return {
    key: nextKey(),
    id: a.id ?? null,
    name: a.name,
    url: str(a.url),
    price: str(a.price),
    notes: str(a.notes),
    nights: a.nights ?? [],
  };
}

const emptyAccommodation = (): AccommodationDraft => accommodationToDraft({ name: '' });

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
    team: !!race.teamSize,
    teamSize: str(race.teamSize ?? 3),
    itraPoints: str(race.itraPoints),
    dayCleared: false,
  };
}

const emptyRace = (): RaceDraft => raceToDraft({ name: '' });

/** Neuer Zeitraum: Starttage außerhalb leeren und die Strecke markieren. */
function withRange(draft: Draft, startDate: string, endDate: string): Draft {
  const races = draft.races.map((r) => {
    if (!r.startDate) return r;
    if (!endDate) return { ...r, startDate: '', dayCleared: false };
    const inside = r.startDate >= startDate && r.startDate <= endDate;
    return inside ? r : { ...r, startDate: '', dayCleared: true };
  });
  return { ...draft, startDate, endDate, races };
}

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

/** Teamgröße aus dem Formular, auf 2 bis 20 begrenzt. */
function teamSizeOf(value: string): number {
  return Math.min(20, Math.max(2, int(value) ?? 2));
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
        // Eintägig: kein eigener Starttag, es gilt der Veranstaltungstag.
        startDate: draft.endDate && r.startDate ? r.startDate : null,
        startTime: r.startTime || null,
        fee: num(r.fee),
        feeNote: r.feeNote || null,
        cutoff: r.cutoff || null,
        teamSize: r.team ? teamSizeOf(r.teamSize) : null,
        itraPoints: r.itraPoints === '' ? null : Number(r.itraPoints),
      })),
    accommodations: draft.accommodations
      .filter((a) => a.name.trim() !== '')
      .map((a) => ({
        id: a.id,
        name: a.name,
        url: a.url.trim() || null,
        price: a.price || null,
        notes: a.notes || null,
        // Nächte außerhalb eines geänderten Zeitraums fallen weg.
        nights: a.nights.filter((n) => draft.endDate && n >= draft.startDate && n <= draft.endDate),
      })),
    removeAccommodationIds: draft.removedAccommodations,
  };
}

const blank: Draft = toDraft({ name: '', startDate: '', currency: 'EUR', races: [] });

export function EventForm(props: { eventId?: string }) {
  const { t } = useI18n();
  const { events } = useApp();
  const existing = props.eventId ? events.find((e) => e.id === props.eventId) : undefined;
  // Erst rendern, wenn die Veranstaltung geladen ist, sonst startet das Formular leer
  // (z. B. nach Neuladen direkt auf der Bearbeiten-Seite).
  if (props.eventId && !existing) return <p className="muted">{t.common.loading}</p>;
  return <EventFormLoaded key={existing?.id ?? 'new'} existing={existing} />;
}

function EventFormLoaded(props: { existing: RunEvent | undefined }) {
  const { t, f, lang, date } = useI18n();
  const { groupId, putEvent, importEnabled } = useApp();
  const existing = props.existing;
  const [draft, setDraft] = useState<Draft>(() =>
    existing
      ? { ...toDraft(eventToInput(existing)), accommodations: existing.accommodations.map(accommodationToDraft) }
      : { ...blank, races: [emptyRace()] },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dateMissing, setDateMissing] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [imported, setImported] = useState(false);
  const [importState, setImportState] = useState<{ busy: boolean; message: string | null; warnings: string[] }>({
    busy: false,
    message: null,
    warnings: [],
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setRace = (key: string, patch: Partial<RaceDraft>) =>
    setDraft((d) => ({ ...d, races: d.races.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const setAccommodation = (key: string, patch: Partial<AccommodationDraft>) =>
    setDraft((d) => ({ ...d, accommodations: d.accommodations.map((a) => (a.key === key ? { ...a, ...patch } : a)) }));
  const removeAccommodation = (a: AccommodationDraft) =>
    setDraft((d) => ({
      ...d,
      accommodations: d.accommodations.filter((x) => x.key !== a.key),
      removedAccommodations: a.id ? [...d.removedAccommodations, a.id] : d.removedAccommodations,
    }));
  /** Freitext-Notizen in einzelne Vorschläge aufteilen; die Notizen werden dabei geleert. */
  const notesToSuggestions = () =>
    setDraft((d) => ({
      ...d,
      accommodations: [...d.accommodations, ...notesToAccommodations(d.accommodationNotes).map(accommodationToDraft)],
      accommodationNotes: '',
    }));

  async function runImport() {
    if (!importUrl.trim()) return;
    setImportState({ busy: true, message: t.import.running, warnings: [] });
    try {
      const result = await api.importFromUrl(importUrl.trim(), lang);
      const imported = toDraft(result.draft);
      // Beim Bearbeiten vorhandene Felder nicht mit leeren Werten überschreiben.
      setDraft((d) => ({
        ...d,
        ...Object.fromEntries(
          Object.entries(imported).filter(
            ([k, v]) => !['races', 'accommodations', 'removedAccommodations'].includes(k) && v !== '' && v !== false,
          ),
        ),
        races: imported.races.length > 0 ? imported.races : d.races,
        // Nennt die Website Unterkünfte, ist eine Übernachtung wohl ein Thema.
        accommodationNeeded: d.accommodationNeeded || imported.accommodations.length > 0,
        // Unterkunftstipps der Website ergänzen, ohne vorhandene doppelt aufzunehmen.
        accommodations: [
          ...d.accommodations,
          ...imported.accommodations.filter(
            (a) => !d.accommodations.some((x) => x.name.trim().toLowerCase() === a.name.trim().toLowerCase()),
          ),
        ],
      }));
      setImportState({ busy: false, message: t.import.done, warnings: result.warnings });
      setImported(true);
    } catch (e) {
      setImportState({ busy: false, message: e instanceof ApiError ? e.message : t.common.error, warnings: [] });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.startDate) {
      setDateMissing(true);
      setError(t.event.dateRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = fromDraft(draft);
      const saved = existing ? await api.updateEvent(existing.id, input) : await api.createEvent(groupId, input);
      putEvent(saved);
      // Frisch importiert: Auf der Event-Seite gleich nach GPX-Dateien suchen.
      if (imported && !existing && saved.website && saved.races.length > 0) requestAutoGpxSearch(saved.id);
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
        <DateField
          mode="range"
          label={t.event.startDate}
          start={draft.startDate}
          end={draft.endDate}
          invalid={dateMissing}
          onChange={(start, end) => {
            setDateMissing(false);
            setDraft((d) => withRange(d, start, end));
          }}
        />
        <label>
          {t.event.website}
          <input type="url" value={draft.website} placeholder="https://" onChange={(e) => set('website', e.target.value)} />
        </label>
        <DateField
          mode="single"
          label={t.event.registrationDeadline}
          value={draft.registrationDeadline}
          onChange={(value) => set('registrationDeadline', value)}
        />
        <div className="grid2">
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
            <h3>{t.stay.suggestions}</h3>
            <p className="muted small">{t.event.suggestionsHint}</p>
            {draft.accommodations.map((a) => (
              <div key={a.key} className="suggestion stack">
                <div className="grid2">
                  <label>
                    {t.stay.name}
                    <input value={a.name} onChange={(e) => setAccommodation(a.key, { name: e.target.value })} maxLength={200} />
                  </label>
                  <label>
                    {t.stay.price}
                    <input
                      value={a.price}
                      placeholder={t.stay.pricePlaceholder}
                      onChange={(e) => setAccommodation(a.key, { price: e.target.value })}
                      maxLength={120}
                    />
                  </label>
                </div>
                <label>
                  {t.stay.link}
                  <input type="url" value={a.url} placeholder="https://" onChange={(e) => setAccommodation(a.key, { url: e.target.value })} />
                </label>
                <div className="row gap-s">
                  <label className="grow">
                    {t.stay.notes}
                    <input value={a.notes} onChange={(e) => setAccommodation(a.key, { notes: e.target.value })} maxLength={1000} />
                  </label>
                  <button
                    type="button"
                    className="link danger align-end"
                    aria-label={t.common.delete}
                    onClick={() => {
                      if (!a.id || window.confirm(f(t.stay.deleteConfirm, { name: a.name }))) removeAccommodation(a);
                    }}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              </div>
            ))}
            <button type="button" onClick={() => setDraft((d) => ({ ...d, accommodations: [...d.accommodations, emptyAccommodation()] }))}>
              <Icon name="plus" size={16} /> {t.stay.suggest}
            </button>
            <label>
              {t.event.accommodationNotes}
              <textarea
                rows={2}
                value={draft.accommodationNotes}
                placeholder={t.event.accommodationNotesPlaceholder}
                onChange={(e) => set('accommodationNotes', e.target.value)}
              />
            </label>
            {draft.accommodationNotes.trim() !== '' && (
              <button type="button" className="small align-start" onClick={notesToSuggestions}>
                {t.event.notesToSuggestions}
              </button>
            )}
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
          {draft.endDate && (
            <div className="race-day">
              <span className="field-label">{t.event.raceDate}</span>
              <div className="day-chips" role="group" aria-label={t.event.raceDate}>
                {daysBetween(draft.startDate, draft.endDate).map((day) => (
                  <button
                    key={day}
                    type="button"
                    className={race.startDate === day ? 'chip-button active' : 'chip-button'}
                    aria-pressed={race.startDate === day}
                    onClick={() =>
                      setRace(race.key, { startDate: race.startDate === day ? '' : day, dayCleared: false })
                    }
                  >
                    {date(day, { weekday: 'short', day: 'numeric' })}
                  </button>
                ))}
              </div>
              {race.dayCleared && <small className="warn-text">{t.event.raceDayCleared}</small>}
            </div>
          )}
          <div className="grid3">
            <label>
              {t.event.startTime}
              <input type="time" value={race.startTime} onChange={(e) => setRace(race.key, { startTime: e.target.value })} />
            </label>
            <label>
              {race.team ? t.team.feePerTeam : t.event.fee}
              <input inputMode="decimal" value={race.fee} onChange={(e) => setRace(race.key, { fee: e.target.value })} />
            </label>
            <label>
              {t.event.cutoff}
              <input value={race.cutoff} onChange={(e) => setRace(race.key, { cutoff: e.target.value })} maxLength={120} />
            </label>
          </div>
          <div className="row gap wrap">
            <label className="toggle">
              <input
                type="checkbox"
                checked={race.team}
                onChange={(e) => setRace(race.key, { team: e.target.checked })}
              />
              {t.team.teamRace}
            </label>
            {race.team && (
              <label className="toggle">
                {t.team.size}
                <input
                  type="number"
                  min={2}
                  max={20}
                  inputMode="numeric"
                  value={race.teamSize}
                  onChange={(e) => setRace(race.key, { teamSize: e.target.value })}
                  style={{ width: '5em' }}
                />
              </label>
            )}
            <label className="toggle">
              {t.event.itraPoints}
              <select value={race.itraPoints} onChange={(e) => setRace(race.key, { itraPoints: e.target.value })}>
                <option value="">{t.event.itraUnknown}</option>
                {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </select>
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
