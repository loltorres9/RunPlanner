/**
 * Unterkünfte einer Veranstaltung: Vorschläge, die eigene Wahl und die Übersicht,
 * wer wo übernachtet. Bei mehrtägigen Veranstaltungen kann jede Person auch pro Nacht
 * wählen (z. B. Etappenläufe, bei denen jede Nacht woanders geschlafen wird).
 */

import { useState, type FormEvent } from 'react';
import {
  eventNights,
  eventPeople,
  openStays,
  stayFor,
  staysPerNight,
  type Accommodation,
  type AccommodationInput,
  type RunEvent,
  type Stay,
  type StayInput,
} from '@runplanner/shared';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { useApp } from '../state.js';
import { initials } from './EventCard.js';
import { Icon } from './Icon.js';

type Run = (action: () => Promise<RunEvent>) => Promise<void>;

/** Kurze Beschriftung einer Nacht, z. B. „Nacht vor Fr 4.9.“. */
function useNightLabel() {
  const { t, f, date } = useI18n();
  const short = (night: string) => date(night, { weekday: 'short', day: 'numeric', month: 'numeric' });
  return {
    short,
    label: (night: string) => f(t.stay.nightBefore, { day: short(night) }),
  };
}

export function StaysSection(props: { event: RunEvent; onChange: Run }) {
  const { t, f } = useI18n();
  const { short } = useNightLabel();
  const { event, onChange } = props;
  const [adding, setAdding] = useState(false);
  const nights = eventNights(event);
  const open = openStays(event);
  const undecided = summarize(open.filter((p) => p.reason === 'undecided'), short);
  const others = event.stays.filter((s) => s.choice === 'other');
  const noneNeeded = [...new Set(event.stays.filter((s) => s.choice === 'none' && s.night === null).map((s) => s.userName))];
  const anyPerNight = nights.length > 0 && event.stays.some((s) => s.night !== null);

  return (
    <section className="card stack stays">
      <h2>
        <Icon name="bed" size={18} /> {t.stay.title}
      </h2>
      {event.accommodationNotes && <p className="pre small">{event.accommodationNotes}</p>}
      {event.accommodationNotes && event.accommodations.length === 0 && (
        <a className="small" href={`#/event/${event.id}/edit`}>
          {t.stay.convertNotes}
        </a>
      )}

      <MyStay event={event} onChange={onChange} />

      <h3>{t.stay.suggestions}</h3>
      {event.accommodations.length === 0 && !adding && <p className="muted small">{t.stay.noSuggestions}</p>}
      {event.accommodations.map((a) => (
        <SuggestionCard
          key={a.id}
          event={event}
          accommodation={a}
          guests={event.stays.filter((s) => s.choice === 'suggested' && s.accommodationId === a.id)}
          onChange={onChange}
        />
      ))}
      {adding ? (
        <AccommodationForm
          nights={nights}
          onCancel={() => setAdding(false)}
          onSave={async (input) => {
            await onChange(() => api.addAccommodation(event.id, input));
            setAdding(false);
          }}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> {t.stay.suggest}
        </button>
      )}

      {anyPerNight && <NightOverview event={event} nights={nights} />}

      {others.length > 0 && (
        <>
          <h3>{t.stay.others}</h3>
          <ul className="guest-list">
            {others.map((s) => (
              <li key={`${s.userId}-${s.night ?? ''}`}>
                <Guest stay={s} />
                <span className="muted">
                  · {s.otherText}
                  {s.night !== null && ` (${short(s.night)})`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {noneNeeded.length > 0 && (
        <p className="small">
          <span className="muted">{t.stay.noneNeeded}: </span>
          {noneNeeded.join(', ')}
        </p>
      )}
      {undecided.length > 0 && (
        <p className="small warn-text">
          {t.stay.undecided}: {undecided.join(', ')}
        </p>
      )}
      {nights.length > 0 && !anyPerNight && <p className="muted small">{f(t.stay.perNightTip, { count: nights.length })}</p>}
    </section>
  );
}

/** „Anna, Ben (Fr 4.9., Sa 5.9.)“: Namen, bei Wahl pro Nacht mit den betroffenen Nächten. */
function summarize(entries: { userName: string; night: string | null }[], short: (night: string) => string): string[] {
  const byName = new Map<string, string[]>();
  for (const entry of entries) {
    const list = byName.get(entry.userName) ?? [];
    if (entry.night !== null) list.push(entry.night);
    byName.set(entry.userName, list);
  }
  return [...byName].map(([name, nights]) => (nights.length ? `${name} (${nights.map(short).join(', ')})` : name));
}

function Guest(props: { stay: Stay; nights?: string[] }) {
  const { t } = useI18n();
  const { short } = useNightLabel();
  const { stay } = props;
  return (
    <span className={`person ${stay.booked ? 'status-paid' : ''}`} title={stay.booked ? t.stay.booked : t.stay.notBooked}>
      <span className="avatar">{initials(stay.userName)}</span>
      {stay.userName}
      {props.nights && props.nights.length > 0 && <span className="muted small"> ({props.nights.map(short).join(', ')})</span>}
      {stay.booked ? ' ✓' : <span className="muted small"> · {t.stay.notBooked}</span>}
    </span>
  );
}

function SuggestionCard(props: { event: RunEvent; accommodation: Accommodation; guests: Stay[]; onChange: Run }) {
  const { t, f } = useI18n();
  const { short } = useNightLabel();
  const { accommodation: a } = props;
  const [editing, setEditing] = useState(false);
  const nights = eventNights(props.event);

  // Wer pro Nacht wählt, erscheint einmal mit seinen Nächten; gebucht nur, wenn alle gebucht sind.
  const guests = new Map<string, { stay: Stay; nights: string[] }>();
  for (const stay of props.guests) {
    if (stay.night !== null && !nights.includes(stay.night)) continue;
    const entry = guests.get(stay.userId);
    if (entry === undefined) guests.set(stay.userId, { stay, nights: stay.night === null ? [] : [stay.night] });
    else {
      if (stay.night !== null) entry.nights.push(stay.night);
      if (!stay.booked) entry.stay = { ...entry.stay, booked: false };
    }
  }

  if (editing) {
    return (
      <AccommodationForm
        initial={a}
        nights={nights}
        onCancel={() => setEditing(false)}
        onSave={async (input) => {
          await props.onChange(() => api.updateAccommodation(a.id, input));
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="suggestion stack">
      <div className="row between gap-s">
        <strong>
          {a.url ? (
            <a href={a.url} target="_blank" rel="noreferrer">
              {a.name}
            </a>
          ) : (
            a.name
          )}
        </strong>
        {a.price && <span className="small">{a.price}</span>}
      </div>
      {a.nights.length > 0 && nights.length > 0 && (
        <p className="small">{f(t.stay.onlyNights, { days: a.nights.map(short).join(', ') })}</p>
      )}
      {a.notes && <p className="muted small pre">{a.notes}</p>}
      <div className="participants">
        {guests.size === 0 ? (
          <span className="muted small">{t.stay.nobody}</span>
        ) : (
          [...guests.values()].map((g) => <Guest key={g.stay.userId} stay={g.stay} nights={g.nights} />)
        )}
      </div>
      <div className="row gap-s end">
        <button type="button" className="small" onClick={() => setEditing(true)}>
          {t.common.edit}
        </button>
        <button
          type="button"
          className="small danger"
          onClick={() => {
            if (window.confirm(f(t.stay.deleteConfirm, { name: a.name }))) void props.onChange(() => api.deleteAccommodation(a.id));
          }}
        >
          {t.common.delete}
        </button>
      </div>
    </div>
  );
}

function AccommodationForm(props: {
  initial?: Accommodation;
  nights: string[];
  onSave: (input: AccommodationInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { short } = useNightLabel();
  const [name, setName] = useState(props.initial?.name ?? '');
  const [url, setUrl] = useState(props.initial?.url ?? '');
  const [price, setPrice] = useState(props.initial?.price ?? '');
  const [notes, setNotes] = useState(props.initial?.notes ?? '');
  const [nights, setNights] = useState<string[]>(props.initial?.nights ?? []);
  const [busy, setBusy] = useState(false);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await props.onSave({
        name,
        url: url || null,
        price: price || null,
        notes: notes || null,
        nights: nights.filter((n) => props.nights.includes(n)),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="suggestion stack" onSubmit={save}>
      <label>
        {t.stay.name}
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
      </label>
      <label>
        {t.stay.link}
        <input type="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        {t.stay.price}
        <input value={price} placeholder={t.stay.pricePlaceholder} onChange={(e) => setPrice(e.target.value)} maxLength={120} />
      </label>
      <label>
        {t.stay.notes}
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </label>
      {props.nights.length > 0 && (
        <div className="stack gap-s">
          <span className="field-label">{t.stay.forNights}</span>
          <div className="day-chips" role="group" aria-label={t.stay.forNights}>
            {props.nights.map((night) => {
              const active = nights.includes(night);
              return (
                <button
                  key={night}
                  type="button"
                  className={active ? 'chip-button active' : 'chip-button'}
                  aria-pressed={active}
                  onClick={() => setNights(active ? nights.filter((n) => n !== night) : [...nights, night])}
                >
                  {short(night)}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="row gap-s end">
        <button type="button" className="link" onClick={props.onCancel}>
          {t.common.cancel}
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {t.common.save}
        </button>
      </div>
    </form>
  );
}

/** Die eigene Wahl: für alle Nächte oder, bei mehrtägigen Veranstaltungen, pro Nacht. */
function MyStay(props: { event: RunEvent; onChange: Run }) {
  const { t } = useI18n();
  const { label } = useNightLabel();
  const { me } = useApp();
  const { event, onChange } = props;
  const nights = eventNights(event);
  const saved = nights.length > 0 && staysPerNight(event, me.user.id);
  const [wantPerNight, setWantPerNight] = useState(saved);
  const perNight = saved || (nights.length > 0 && wantPerNight);
  const isOpen = openStays(event).some((o) => o.userId === me.user.id && o.reason === 'undecided');

  function save(night: string | null, input: StayInput | null) {
    return onChange(() => api.setStay(event.id, input === null ? { night, choice: null } : { ...input, night }));
  }

  function toggle(on: boolean) {
    if (on) {
      setWantPerNight(true);
      void onChange(() => api.setStayMode(event.id, true));
      return;
    }
    if (saved && !window.confirm(t.stay.perNightOffConfirm)) return;
    setWantPerNight(false);
    if (saved) void onChange(() => api.setStayMode(event.id, false));
  }

  return (
    <div className={`my-stay stack ${isOpen ? 'open' : ''}`}>
      {!perNight && (
        <StayPicker
          label={t.stay.mine}
          event={event}
          night={null}
          stay={event.stays.find((s) => s.userId === me.user.id && s.night === null)}
          onSave={(input) => save(null, input)}
        />
      )}
      {perNight && (
        <>
          <strong>{t.stay.mine}</strong>
          {nights.map((night) => (
            <StayPicker
              key={night}
              label={label(night)}
              event={event}
              night={night}
              stay={event.stays.find((s) => s.userId === me.user.id && s.night === night)}
              onSave={(input) => save(night, input)}
            />
          ))}
        </>
      )}
      {nights.length > 0 && (
        <label className="toggle">
          <input type="checkbox" checked={perNight} onChange={(e) => toggle(e.target.checked)} />
          {t.stay.perNight}
        </label>
      )}
    </div>
  );
}

/** Auswahl für eine Nacht (oder alle): keine, ein Vorschlag oder eine andere, plus „gebucht“. */
function StayPicker(props: {
  label: string;
  event: RunEvent;
  night: string | null;
  stay: Stay | undefined;
  onSave: (input: StayInput | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const { stay, night } = props;
  const current = stay === undefined ? '' : stay.choice === 'suggested' ? `a:${stay.accommodationId}` : stay.choice;
  const [otherText, setOtherText] = useState(stay?.otherText ?? '');
  const [selected, setSelected] = useState(current);

  // "Andere" ohne Text ist erst eine Auswahl im Formular; gespeichert wird mit Text.
  const value = selected === 'other' && current !== 'other' ? 'other' : current;

  // Vorschläge für diese Nacht zuerst, die übrigen danach.
  const fits = (a: Accommodation) => night === null || a.nights.length === 0 || a.nights.includes(night);
  const accommodations = [...props.event.accommodations.filter(fits), ...props.event.accommodations.filter((a) => !fits(a))];

  function save(choice: string, booked: boolean, text = otherText) {
    if (choice === '') return props.onSave(null);
    if (choice === 'none') return props.onSave({ choice: 'none' });
    if (choice === 'other') return props.onSave({ choice: 'other', otherText: text, booked });
    return props.onSave({ choice: 'suggested', accommodationId: choice.slice(2), booked });
  }

  return (
    <div className="stay-picker stack">
      <label>
        {props.label}
        <select
          value={value}
          onChange={(e) => {
            const choice = e.target.value;
            setSelected(choice);
            if (choice !== 'other' || otherText.trim()) void save(choice, stay?.booked ?? false);
          }}
        >
          <option value="">{t.stay.choose}</option>
          <option value="none">{t.stay.none}</option>
          {accommodations.map((a) => (
            <option key={a.id} value={`a:${a.id}`}>
              {a.name}
            </option>
          ))}
          <option value="other">{t.stay.other}</option>
        </select>
      </label>
      {value === 'other' && (
        <input
          aria-label={`${props.label}: ${t.stay.other}`}
          value={otherText}
          placeholder={t.stay.otherPlaceholder}
          maxLength={300}
          onChange={(e) => setOtherText(e.target.value)}
          onBlur={() => {
            if (otherText.trim() && otherText !== (stay?.otherText ?? '')) void save('other', stay?.booked ?? false, otherText);
          }}
        />
      )}
      {stay !== undefined && stay.choice !== 'none' && (
        <label className="toggle">
          <input type="checkbox" checked={stay.booked} onChange={(e) => void save(current, e.target.checked)} />
          {t.stay.booked}
        </label>
      )}
    </div>
  );
}

/** Wer in welcher Nacht wo schläft, sobald jemand pro Nacht wählt. */
function NightOverview(props: { event: RunEvent; nights: string[] }) {
  const { t } = useI18n();
  const { label } = useNightLabel();
  const { event } = props;
  const people = new Map(eventPeople(event).map((p) => [p.userId, p.userName]));
  for (const s of event.stays) people.set(s.userId, s.userName);

  function place(stay: Stay): string {
    if (stay.choice === 'none') return t.stay.none;
    if (stay.choice === 'other') return stay.otherText ?? t.stay.other;
    return event.accommodations.find((a) => a.id === stay.accommodationId)?.name ?? '?';
  }

  return (
    <>
      <h3>{t.stay.byNight}</h3>
      <div className="night-overview stack">
        {props.nights.map((night) => (
          <div key={night} className="night">
            <strong className="small">{label(night)}</strong>
            <ul className="guest-list">
              {[...people].map(([userId, userName]) => {
                const stay = stayFor(event, userId, night);
                return (
                  <li key={userId} className="small">
                    <span className="avatar">{initials(userName)}</span>
                    {userName}:{' '}
                    {stay === undefined ? (
                      <span className="warn-text">{t.stay.undecidedShort}</span>
                    ) : (
                      <span>
                        {place(stay)}
                        {stay.choice !== 'none' &&
                          (stay.booked ? ' ✓' : <span className="muted"> · {t.stay.notBooked}</span>)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
