import { eventPeople, eventTodos, type RunEvent } from '@runplanner/shared';
import { useI18n } from '../i18n/index.js';
import { todayIso } from '../state.js';
import { Icon } from './Icon.js';

const COLORS = ['#2f7d5b', '#c4622d', '#3a6ea5', '#8a5a9e', '#b08a1e', '#4d8a8a', '#a8455b'];

/** Feste Farbe pro Veranstaltung, damit sie im Kalender wiedererkennbar ist. */
export function eventColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

export function EventCard(props: { event: RunEvent; showAdded?: boolean; isNew?: boolean }) {
  const { t, f, date, number, ago } = useI18n();
  const { event } = props;
  const todos = eventTodos(event, todayIso());
  const people = eventPeople(event);
  const distances = event.races
    .map((r) => (r.distanceKm !== null ? `${number(r.distanceKm)} km` : r.name))
    .slice(0, 5)
    .join(' · ');

  return (
    <a className="event-card card" href={`#/event/${event.id}`} style={{ borderLeftColor: eventColor(event.id) }}>
      <div className="date-block">
        <span className="day">{date(event.startDate, { day: 'numeric' })}</span>
        <span className="month">{date(event.startDate, { month: 'short' })}</span>
      </div>
      <div className="event-main">
        <strong>
          {event.name}
          {props.isNew && <span className="badge new">{t.list.newBadge}</span>}
        </strong>
        <div className="meta">
          {event.location && (
            <span>
              <Icon name="pin" size={14} /> {event.location}
            </span>
          )}
          {event.endDate && <span>– {date(event.endDate, { day: 'numeric', month: 'short' })}</span>}
        </div>
        {distances && <div className="meta">{distances}</div>}
        {props.showAdded && (
          <div className="meta added">{f(t.list.addedBy, { name: event.createdByName, ago: ago(event.createdAt) })}</div>
        )}
        <div className="row wrap gap-s">
          {people.map((p) => (
            <span key={p.userId} className="avatar" title={p.userName}>
              {initials(p.userName)}
            </span>
          ))}
          {todos.includes('accommodation') && (
            <span className="badge warn">
              <Icon name="bed" size={14} /> {t.event.accommodationOpen}
            </span>
          )}
          {todos.includes('deadlineSoon') && <span className="badge warn">{t.event.deadlineSoon}</span>}
          {todos.includes('deadlinePassed') && <span className="badge danger">{t.event.deadlinePassed}</span>}
        </div>
      </div>
    </a>
  );
}
