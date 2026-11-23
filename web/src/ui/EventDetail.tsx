import { useState } from 'react';
import { PARTICIPATION_STATUSES, eventTodos, type EventInput, type ParticipationStatus, type Race, type RunEvent } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { navigate, todayIso, useApp } from '../state.js';
import { eventColor, initials } from './EventCard.js';
import { Icon } from './Icon.js';

export function eventToInput(event: RunEvent): EventInput {
  return {
    name: event.name,
    location: event.location,
    startDate: event.startDate,
    endDate: event.endDate,
    website: event.website,
    registrationDeadline: event.registrationDeadline,
    currency: event.currency,
    accommodationNeeded: event.accommodationNeeded,
    accommodationBooked: event.accommodationBooked,
    accommodationNotes: event.accommodationNotes,
    notes: event.notes,
    races: event.races.map((r) => ({
      id: r.id,
      name: r.name,
      distanceKm: r.distanceKm,
      elevationUpM: r.elevationUpM,
      elevationDownM: r.elevationDownM,
      startDate: r.startDate,
      startTime: r.startTime,
      fee: r.fee,
      feeNote: r.feeNote,
      cutoff: r.cutoff,
    })),
  };
}

export function EventDetail(props: { eventId: string }) {
  const { t, f, date } = useI18n();
  const { events, eventsLoaded, me, groupId, putEvent, dropEvent } = useApp();
  const [error, setError] = useState<string | null>(null);
  const event = events.find((e) => e.id === props.eventId);

  if (!event) {
    return <p className="muted">{eventsLoaded ? t.common.error : t.common.loading}</p>;
  }

  const role = me.groups.find((g) => g.id === groupId)?.role;
  const canDelete = event.createdBy === me.user.id || role === 'admin';
  const todos = eventTodos(event, todayIso());

  async function update(action: () => Promise<RunEvent>) {
    setError(null);
    try {
      putEvent(await action());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    }
  }

  async function remove() {
    if (!event || !window.confirm(f(t.event.deleteConfirm, { name: event.name }))) return;
    try {
      await api.deleteEvent(event.id);
      dropEvent(event.id);
      navigate('list', true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    }
  }

  const days =
    event.endDate !== null
      ? Math.round((Date.parse(event.endDate) - Date.parse(event.startDate)) / 86_400_000) + 1
      : 1;

  return (
    <div className="stack detail">
      <button type="button" className="link back" onClick={() => window.history.back()}>
        <Icon name="chevronLeft" size={16} /> {t.common.back}
      </button>

      <div className="card stack" style={{ borderTop: `4px solid ${eventColor(event.id)}` }}>
        <h1>{event.name}</h1>
        <div className="facts">
          <span>
            <Icon name="calendar" size={16} />
            <span>
              {date(event.startDate)}
              {event.endDate && ` – ${date(event.endDate)}`}
              {days > 1 && <span className="muted"> ({f(t.event.days, { count: days })})</span>}
            </span>
          </span>
          {event.location && (
            <a href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(event.location)}`} target="_blank" rel="noreferrer">
              <Icon name="pin" size={16} /> {event.location}
            </a>
          )}
          {event.website && (
            <a href={event.website} target="_blank" rel="noreferrer">
              <Icon name="link" size={16} /> {t.event.openWebsite}
            </a>
          )}
          {event.registrationDeadline && (
            <span className={todos.includes('deadlinePassed') ? 'danger-text' : todos.includes('deadlineSoon') ? 'warn-text' : ''}>
              <Icon name="clock" size={16} /> {f(t.event.deadlineOn, { date: date(event.registrationDeadline) })}
            </span>
          )}
        </div>

        {event.accommodationNeeded && (
          <div className={`accommodation ${event.accommodationBooked ? 'ok' : 'open'}`}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={event.accommodationBooked}
                onChange={(e) => update(() => api.updateEvent(event.id, { ...eventToInput(event), accommodationBooked: e.target.checked }))}
              />
              <Icon name="bed" size={16} /> {t.event.accommodationBooked}
            </label>
            {event.accommodationNotes && <p className="pre">{event.accommodationNotes}</p>}
          </div>
        )}

        {event.notes && <p className="pre">{event.notes}</p>}
        <p className="muted small">{f(t.event.addedBy, { name: event.createdByName })}</p>
      </div>

      {error && <p className="error">{error}</p>}

      <h2>{t.event.races}</h2>
      {event.races.length === 0 && <p className="muted">{t.event.noRaces}</p>}
      {event.races.map((race) => (
        <RaceCard
          key={race.id}
          race={race}
          currency={event.currency}
          myId={me.user.id}
          onStatus={(status) => update(() => api.setParticipation(race.id, status))}
        />
      ))}

      <div className="row gap">
        <button type="button" className="primary" onClick={() => navigate(`event/${event.id}/edit`)}>
          {t.common.edit}
        </button>
        {canDelete && (
          <button type="button" className="danger" onClick={remove}>
            <Icon name="trash" size={16} /> {t.common.delete}
          </button>
        )}
      </div>
    </div>
  );
}

function RaceCard(props: { race: Race; currency: string; myId: string; onStatus: (status: ParticipationStatus | null) => void }) {
  const { t, date, money, number } = useI18n();
  const { race } = props;
  const mine = race.participants.find((p) => p.userId === props.myId)?.status ?? null;

  return (
    <div className="card stack race">
      <div className="row between wrap">
        <strong>{race.name}</strong>
        {race.fee !== null && <span className="fee">{money(race.fee, props.currency)}</span>}
      </div>
      <div className="stats">
        {race.distanceKm !== null && <span>{number(race.distanceKm)} km</span>}
        {race.elevationUpM !== null && (
          <span>
            <Icon name="up" size={14} /> {number(race.elevationUpM, 0)} hm
          </span>
        )}
        {race.elevationDownM !== null && <span>↓ {number(race.elevationDownM, 0)} hm</span>}
        {(race.startDate || race.startTime) && (
          <span>
            <Icon name="clock" size={14} /> {race.startDate ? `${date(race.startDate, { weekday: 'short', day: 'numeric', month: 'short' })} ` : ''}
            {race.startTime ?? ''}
          </span>
        )}
        {race.cutoff && <span>⏱ {race.cutoff}</span>}
      </div>
      {race.feeNote && <p className="muted small">{race.feeNote}</p>}

      <div className="participants">
        {race.participants.length === 0 ? (
          <span className="muted small">{t.event.nobody}</span>
        ) : (
          race.participants.map((p) => (
            <span key={p.userId} className={`person status-${p.status}`}>
              <span className="avatar">{initials(p.userName)}</span>
              {p.userName} · {t.status[p.status]}
            </span>
          ))
        )}
      </div>

      <div className="segmented small" role="group" aria-label={t.event.myStatus}>
        <button type="button" className={mine === null ? 'active' : ''} onClick={() => props.onStatus(null)}>
          {t.status.none}
        </button>
        {PARTICIPATION_STATUSES.map((status) => (
          <button key={status} type="button" className={mine === status ? 'active' : ''} onClick={() => props.onStatus(status)}>
            {t.status[status]}
          </button>
        ))}
      </div>
    </div>
  );
}
