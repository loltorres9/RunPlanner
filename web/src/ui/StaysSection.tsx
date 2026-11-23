/**
 * Unterkünfte einer Veranstaltung: Vorschläge, die eigene Wahl und die Übersicht,
 * wer wo übernachtet.
 */

import { useState, type FormEvent } from 'react';
import { openStays, type Accommodation, type AccommodationInput, type RunEvent, type Stay } from '@runplanner/shared';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { useApp } from '../state.js';
import { initials } from './EventCard.js';
import { Icon } from './Icon.js';

type Run = (action: () => Promise<RunEvent>) => Promise<void>;

export function StaysSection(props: { event: RunEvent; onChange: Run }) {
  const { t } = useI18n();
  const { event, onChange } = props;
  const [adding, setAdding] = useState(false);
  const undecided = openStays(event).filter((p) => p.reason === 'undecided');
  const others = event.stays.filter((s) => s.choice === 'other');
  const noneNeeded = event.stays.filter((s) => s.choice === 'none');

  return (
    <section className="card stack stays">
      <h2>
        <Icon name="bed" size={18} /> {t.stay.title}
      </h2>
      {event.accommodationNotes && <p className="pre small">{event.accommodationNotes}</p>}

      <MyStay event={event} onChange={onChange} />

      <h3>{t.stay.suggestions}</h3>
      {event.accommodations.length === 0 && !adding && <p className="muted small">{t.stay.noSuggestions}</p>}
      {event.accommodations.map((a) => (
        <SuggestionCard
          key={a.id}
          accommodation={a}
          guests={event.stays.filter((s) => s.choice === 'suggested' && s.accommodationId === a.id)}
          onChange={onChange}
        />
      ))}
      {adding ? (
        <AccommodationForm
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

      {others.length > 0 && (
        <>
          <h3>{t.stay.others}</h3>
          <ul className="guest-list">
            {others.map((s) => (
              <li key={s.userId}>
                <Guest stay={s} />
                <span className="muted">· {s.otherText}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {noneNeeded.length > 0 && (
        <p className="small">
          <span className="muted">{t.stay.noneNeeded}: </span>
          {noneNeeded.map((s) => s.userName).join(', ')}
        </p>
      )}
      {undecided.length > 0 && (
        <p className="small warn-text">
          {t.stay.undecided}: {undecided.map((p) => p.userName).join(', ')}
        </p>
      )}
    </section>
  );
}

function Guest(props: { stay: Stay }) {
  const { t } = useI18n();
  const { stay } = props;
  return (
    <span className={`person ${stay.booked ? 'status-paid' : ''}`} title={stay.booked ? t.stay.booked : t.stay.notBooked}>
      <span className="avatar">{initials(stay.userName)}</span>
      {stay.userName}
      {stay.booked ? ' ✓' : <span className="muted small"> · {t.stay.notBooked}</span>}
    </span>
  );
}

function SuggestionCard(props: { accommodation: Accommodation; guests: Stay[]; onChange: Run }) {
  const { t, f } = useI18n();
  const { accommodation: a, guests } = props;
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <AccommodationForm
        initial={a}
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
      {a.notes && <p className="muted small pre">{a.notes}</p>}
      <div className="participants">
        {guests.length === 0 ? (
          <span className="muted small">{t.stay.nobody}</span>
        ) : (
          guests.map((g) => <Guest key={g.userId} stay={g} />)
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
  onSave: (input: AccommodationInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(props.initial?.name ?? '');
  const [url, setUrl] = useState(props.initial?.url ?? '');
  const [price, setPrice] = useState(props.initial?.price ?? '');
  const [notes, setNotes] = useState(props.initial?.notes ?? '');
  const [busy, setBusy] = useState(false);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await props.onSave({ name, url: url || null, price: price || null, notes: notes || null });
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

/** Die eigene Wahl: keine, eine vorgeschlagene oder eine andere, plus „gebucht“. */
function MyStay(props: { event: RunEvent; onChange: Run }) {
  const { t } = useI18n();
  const { me } = useApp();
  const { event } = props;
  const mine = event.stays.find((s) => s.userId === me.user.id);
  const current = mine === undefined ? '' : mine.choice === 'suggested' ? `a:${mine.accommodationId}` : mine.choice;
  const [otherText, setOtherText] = useState(mine?.otherText ?? '');
  const [selected, setSelected] = useState(current);

  // "Andere" ohne Text ist erst eine Auswahl im Formular; gespeichert wird mit Text.
  const value = selected === 'other' && current !== 'other' ? 'other' : current;

  function save(choice: string, booked: boolean, text = otherText) {
    if (choice === '') return props.onChange(() => api.setStay(event.id, { choice: null }));
    if (choice === 'none') return props.onChange(() => api.setStay(event.id, { choice: 'none' }));
    if (choice === 'other') return props.onChange(() => api.setStay(event.id, { choice: 'other', otherText: text, booked }));
    return props.onChange(() => api.setStay(event.id, { choice: 'suggested', accommodationId: choice.slice(2), booked }));
  }

  return (
    <div className={`my-stay stack ${mine === undefined ? 'open' : ''}`}>
      <label>
        {t.stay.mine}
        <select
          value={value}
          onChange={(e) => {
            const choice = e.target.value;
            setSelected(choice);
            if (choice !== 'other' || otherText.trim()) void save(choice, mine?.booked ?? false);
          }}
        >
          <option value="">{t.stay.choose}</option>
          <option value="none">{t.stay.none}</option>
          {event.accommodations.map((a) => (
            <option key={a.id} value={`a:${a.id}`}>
              {a.name}
            </option>
          ))}
          <option value="other">{t.stay.other}</option>
        </select>
      </label>
      {value === 'other' && (
        <input
          aria-label={t.stay.other}
          value={otherText}
          placeholder={t.stay.otherPlaceholder}
          maxLength={300}
          onChange={(e) => setOtherText(e.target.value)}
          onBlur={() => {
            if (otherText.trim() && otherText !== (mine?.otherText ?? '')) void save('other', mine?.booked ?? false, otherText);
          }}
        />
      )}
      {mine !== undefined && mine.choice !== 'none' && (
        <label className="toggle">
          <input type="checkbox" checked={mine.booked} onChange={(e) => void save(current, e.target.checked)} />
          {t.stay.booked}
        </label>
      )}
    </div>
  );
}
