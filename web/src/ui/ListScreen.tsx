import { useState } from 'react';
import { lastDay } from '@runplanner/shared';
import { useI18n } from '../i18n/index.js';
import { todayIso, useApp } from '../state.js';
import { EventCard } from './EventCard.js';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // egal
  }
}

export function ListScreen() {
  const { t } = useI18n();
  const { events, eventsLoaded, me } = useApp();
  const [onlyMine, setOnlyMine] = useState(() => readFlag('onlyMine'));
  const [showPast, setShowPast] = useState(false);
  const today = todayIso();

  const filtered = onlyMine
    ? events.filter((e) => e.races.some((r) => r.participants.some((p) => p.userId === me.user.id)))
    : events;
  const upcoming = filtered.filter((e) => lastDay(e) >= today);
  const past = filtered.filter((e) => lastDay(e) < today).reverse();

  // Nach Monat gruppieren, damit die Liste wie ein Kalender lesbar bleibt.
  const groups = new Map<string, typeof upcoming>();
  for (const e of upcoming) {
    const key = e.startDate.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  return (
    <div className="stack">
      <div className="row between">
        <h2>{t.list.upcoming}</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={onlyMine}
            onChange={(e) => {
              setOnlyMine(e.target.checked);
              writeFlag('onlyMine', e.target.checked);
            }}
          />
          {t.list.onlyMine}
        </label>
      </div>

      {eventsLoaded && upcoming.length === 0 && <p className="muted">{t.list.empty}</p>}
      {!eventsLoaded && <p className="muted">{t.common.loading}</p>}

      {[...groups].map(([month, list]) => (
        <section key={month} className="stack">
          <MonthTitle month={month} />
          {list.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </section>
      ))}

      {past.length > 0 && (
        <>
          <button type="button" className="link" onClick={() => setShowPast(!showPast)}>
            {showPast ? t.list.hidePast : `${t.list.showPast} (${past.length})`}
          </button>
          {showPast && (
            <section className="stack past">
              <h3>{t.list.past}</h3>
              {past.map((e) => (
                <EventCard key={e.id} event={e} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function MonthTitle(props: { month: string }) {
  const { date } = useI18n();
  return <h3 className="month-title">{date(`${props.month}-01`, { month: 'long', year: 'numeric' })}</h3>;
}
