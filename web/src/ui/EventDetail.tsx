import { useState } from 'react';
import {
  PARTICIPATION_STATUSES,
  eventTodos,
  teamMembers,
  teamOf,
  type EventInput,
  type Participation,
  type ParticipationStatus,
  type Race,
  type RunEvent,
} from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { navigate, todayIso, useApp } from '../state.js';
import { eventColor, initials } from './EventCard.js';
import { Icon } from './Icon.js';
import { CommentsSection } from './CommentsSection.js';
import { ExpensesSection } from './ExpensesSection.js';
import { GpxSearch } from './GpxSearch.js';
import { RaceTrackPanel } from './RaceTrackPanel.js';
import { StaysSection } from './StaysSection.js';

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
      teamSize: r.teamSize,
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

        {event.notes && <p className="pre">{event.notes}</p>}
        <p className="muted small">{f(t.event.addedBy, { name: event.createdByName })}</p>
      </div>

      {error && <p className="error">{error}</p>}

      <h2>{t.event.races}</h2>
      {event.races.length === 0 && <p className="muted">{t.event.noRaces}</p>}
      <GpxSearch event={event} />
      {event.races.map((race) => (
        <RaceCard
          key={race.id}
          race={race}
          currency={event.currency}
          myId={me.user.id}
          onStatus={(status) => update(() => api.setParticipation(race.id, status))}
          onChange={update}
        />
      ))}

      {event.accommodationNeeded && <StaysSection event={event} onChange={(action) => update(action)} />}

      <ExpensesSection event={event} />

      <CommentsSection event={event} />

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

function RaceCard(props: {
  race: Race;
  currency: string;
  myId: string;
  onStatus: (status: ParticipationStatus | null) => void;
  onChange: (action: () => Promise<RunEvent>) => Promise<void>;
}) {
  const { t, date, money, number } = useI18n();
  const { race } = props;
  const mine = race.participants.find((p) => p.userId === props.myId)?.status ?? null;

  return (
    <div className="card stack race">
      <div className="row between wrap">
        <strong>{race.name}</strong>
        {race.fee !== null && (
          <span className="fee">
            {money(race.fee, props.currency)}
            {race.teamSize !== null && <span className="muted small"> {t.team.perTeam}</span>}
          </span>
        )}
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

      <RaceTrackPanel race={race} onChange={props.onChange} />

      {race.teamSize !== null ? (
        <TeamPanel race={race} myId={props.myId} mine={mine} onChange={props.onChange} />
      ) : (
        <>
          <div className="participants">
            {race.participants.length === 0 ? (
              <span className="muted small">{t.event.nobody}</span>
            ) : (
              race.participants.map((p) => <PersonChip key={p.userId} person={p} />)
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
        </>
      )}
    </div>
  );
}

function PersonChip(props: { person: Participation }) {
  const { t } = useI18n();
  const p = props.person;
  return (
    <span className={`person status-${p.status}`}>
      <span className="avatar">{initials(p.userName)}</span>
      {p.userName} · {t.status[p.status]}
    </span>
  );
}

/**
 * Teamstrecke: Teams mit Mitgliedern, beitreten oder gründen. „Bezahlt“ setzt nur,
 * wer fürs Team zahlt; dann gilt das ganze Team als bezahlt.
 */
function TeamPanel(props: {
  race: Race;
  myId: string;
  mine: ParticipationStatus | null;
  onChange: (action: () => Promise<RunEvent>) => Promise<void>;
}) {
  const { t, f } = useI18n();
  const { race, myId, mine } = props;
  const size = race.teamSize ?? 0;
  const myTeam = teamOf(race, myId);
  const isPayer = myTeam?.payerId === myId;
  const withoutTeam = race.participants.filter((p) => !race.teams.some((team) => team.id === p.teamId));
  const set = (status: ParticipationStatus | null, teamId?: string) =>
    props.onChange(() => api.setParticipation(race.id, status, teamId));
  // Ohne Team ist man nach dem Eintragen Gründer:in und zahlt selbst.
  const canPay = myTeam === undefined || isPayer;

  return (
    <div className="stack teams">
      {race.teams.length === 0 && <span className="muted small">{t.team.none}</span>}
      {race.teams.map((team) => {
        const members = teamMembers(race, team.id);
        const paid = members.find((m) => m.userId === team.payerId)?.status === 'paid';
        const isMine = myTeam?.id === team.id;
        return (
          <div key={team.id} className={`team${isMine ? ' mine' : ''}`}>
            <div className="row between wrap">
              <strong>
                {team.name} ({members.length}/{size})
              </strong>
              {paid ? (
                <span className="team-badge">{t.status.paid}</span>
              ) : (
                <span className="muted small">{f(t.team.payer, { name: team.payerName })}</span>
              )}
            </div>
            <div className="participants">
              {members.map((p) => (
                <PersonChip key={p.userId} person={p} />
              ))}
            </div>
            <div className="row gap wrap">
              {!isMine && members.length < size && (
                <button type="button" className="small" onClick={() => set(mine === 'paid' || mine === null ? 'interested' : mine, team.id)}>
                  {t.team.join}
                </button>
              )}
              {isMine && !isPayer && (
                <button type="button" className="small" onClick={() => props.onChange(() => api.updateTeam(team.id, { payerId: myId }))}>
                  {t.team.takeOver}
                </button>
              )}
            </div>
            {isMine && paid && team.expenseId !== null && <p className="muted small">{t.team.expenseHint}</p>}
          </div>
        );
      })}
      {withoutTeam.length > 0 && (
        <div className="participants">
          <span className="muted small">{t.team.withoutTeam}</span>
          {withoutTeam.map((p) => (
            <PersonChip key={p.userId} person={p} />
          ))}
        </div>
      )}

      <div className="segmented small" role="group" aria-label={t.event.myStatus}>
        <button type="button" className={mine === null ? 'active' : ''} onClick={() => set(null)}>
          {t.status.none}
        </button>
        {PARTICIPATION_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className={mine === status ? 'active' : ''}
            disabled={status === 'paid' && !canPay}
            title={status === 'paid' && !canPay ? f(t.team.paidBy, { name: myTeam?.payerName ?? '' }) : undefined}
            onClick={() => set(status)}
          >
            {t.status[status]}
          </button>
        ))}
      </div>
      {myTeam === undefined ? (
        <p className="muted small">{t.team.foundHint}</p>
      ) : (
        <div className="row gap wrap">
          {!isPayer && <span className="muted small">{f(t.team.paidBy, { name: myTeam.payerName })}</span>}
          {teamMembers(race, myTeam.id).length > 1 && (
            <button type="button" className="link small" onClick={() => set(mine === 'paid' ? 'registered' : (mine ?? 'interested'), 'new')}>
              {t.team.found}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
