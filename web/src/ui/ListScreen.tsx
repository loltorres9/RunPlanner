import { useEffect, useState } from 'react';
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

type Sort = 'date' | 'added';

function readSort(): Sort {
  try {
    return localStorage.getItem('listSort') === 'added' ? 'added' : 'date';
  } catch {
    return 'date';
  }
}

/** Pro Gruppe der Stand vom letzten App-Start; bleibt bis zum Neuladen der App gleich. */
const seenThisSession = new Map<string, number>();

/**
 * Zeitpunkt, zu dem die Liste dieser Gruppe auf diesem Gerät zuletzt angesehen wurde,
 * bevor die App dieses Mal geöffnet wurde. So bleiben die „Neu“-Abzeichen stehen, solange
 * man in der App hin und her wechselt, und verschwinden erst beim nächsten Öffnen.
 */
function useLastSeen(groupId: string, ready: boolean, newest: number): number {
  const key = `listSeen:${groupId}`;
  const [seen] = useState(() => {
    const cached = seenThisSession.get(groupId);
    if (cached !== undefined) return cached;
    let stored = 0;
    try {
      stored = Number(localStorage.getItem(key));
    } catch {
      // egal
    }
    const value = Number.isFinite(stored) && stored > 0 ? stored : Date.now();
    seenThisSession.set(groupId, value);
    return value;
  });
  // Gemerkt wird der neueste tatsächlich angezeigte Eintrag, nicht „jetzt“: War die Liste
  // noch nicht aktualisiert, gilt ein inzwischen hinzugekommener Eintrag weiter als neu.
  useEffect(() => {
    if (!ready || newest === 0) return;
    try {
      if (newest > Number(localStorage.getItem(key) ?? 0)) localStorage.setItem(key, String(newest));
    } catch {
      // egal
    }
  }, [key, ready, newest]);
  return seen;
}

export function ListScreen() {
  const { t } = useI18n();
  const { events, eventsLoaded, me, groupId } = useApp();
  const [onlyMine, setOnlyMine] = useState(() => readFlag('onlyMine'));
  const [sort, setSort] = useState<Sort>(readSort);
  const lastSeen = useLastSeen(groupId, eventsLoaded, Math.max(0, ...events.map((e) => e.createdAt)));
  const isNew = (e: (typeof events)[number]) => e.createdBy !== me.user.id && e.createdAt > lastSeen;
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

  const byAdded = [...upcoming].sort((a, b) => b.createdAt - a.createdAt);

  function chooseSort(next: Sort) {
    setSort(next);
    try {
      localStorage.setItem('listSort', next);
    } catch {
      // egal
    }
  }

  return (
    <div className="stack">
      <div className="segmented" role="group" aria-label={t.list.upcoming}>
        <button type="button" className={sort === 'date' ? 'active' : ''} aria-pressed={sort === 'date'} onClick={() => chooseSort('date')}>
          {t.list.sortDate}
        </button>
        <button type="button" className={sort === 'added' ? 'active' : ''} aria-pressed={sort === 'added'} onClick={() => chooseSort('added')}>
          {t.list.sortAdded}
        </button>
      </div>
      <div className="row between">
        <h2>{sort === 'added' ? t.list.recentlyAdded : t.list.upcoming}</h2>
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

      {sort === 'added'
        ? byAdded.map((e) => <EventCard key={e.id} event={e} showAdded isNew={isNew(e)} />)
        : [...groups].map(([month, list]) => (
            <section key={month} className="stack">
              <MonthTitle month={month} />
              {list.map((e) => (
                <EventCard key={e.id} event={e} isNew={isNew(e)} />
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
