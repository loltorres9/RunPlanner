import { coversDay, lastDay } from '@runplanner/shared';
import { monthGrid, shiftMonth } from '../dates.js';
import { useI18n } from '../i18n/index.js';
import { navigate, todayIso, useApp } from '../state.js';
import { EventCard, eventColor } from './EventCard.js';
import { Icon } from './Icon.js';

export function CalendarScreen(props: { month?: string }) {
  const { t, date } = useI18n();
  const { events } = useApp();
  const today = todayIso();
  const month = props.month && /^\d{4}-\d{2}$/.test(props.month) ? props.month : today.slice(0, 7);
  const days = monthGrid(month);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31`;
  const inMonth = events.filter((e) => e.startDate <= monthEnd && lastDay(e) >= monthStart);
  const weekdays = days.slice(0, 7).map((d) => date(d, { weekday: 'narrow' }));

  return (
    <div className="stack">
      <div className="row between calendar-head">
        <button type="button" className="icon-button" aria-label={t.calendar.prev} onClick={() => navigate(`calendar/${shiftMonth(month, -1)}`)}>
          <Icon name="chevronLeft" />
        </button>
        <h2>{date(monthStart, { month: 'long', year: 'numeric' })}</h2>
        <button type="button" className="icon-button" aria-label={t.calendar.next} onClick={() => navigate(`calendar/${shiftMonth(month, 1)}`)}>
          <Icon name="chevronRight" />
        </button>
      </div>
      {month !== today.slice(0, 7) && (
        <button type="button" className="link center-self" onClick={() => navigate('calendar')}>
          {t.calendar.today}
        </button>
      )}

      <div className="calendar card" role="grid">
        {weekdays.map((w, i) => (
          <div key={`h${i}`} className="weekday" role="columnheader">
            {w}
          </div>
        ))}
        {days.map((day) => {
          const dayEvents = inMonth.filter((e) => coversDay(e, day));
          const classes = ['cell'];
          if (!day.startsWith(month)) classes.push('other');
          if (day === today) classes.push('today');
          return (
            <div key={day} className={classes.join(' ')} role="gridcell">
              <span className="num">{Number(day.slice(8))}</span>
              {dayEvents.slice(0, 3).map((e) => (
                <a key={e.id} href={`#/event/${e.id}`} className="chip" style={{ background: eventColor(e.id) }} title={e.name}>
                  {e.name}
                </a>
              ))}
              {dayEvents.length > 3 && <span className="more">+{dayEvents.length - 3}</span>}
            </div>
          );
        })}
      </div>

      {inMonth.length === 0 ? (
        <p className="muted center">{t.calendar.nothingThisMonth}</p>
      ) : (
        <div className="stack">
          {inMonth.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </div>
      )}
    </div>
  );
}
